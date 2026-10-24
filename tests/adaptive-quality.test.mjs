import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const limitsURL = url(compile(await readFile(new URL('../src/particleLimits.ts', import.meta.url), 'utf8')));
const limits = await import(limitsURL);
const source = compile(await readFile(new URL('../src/adaptiveQuality.ts', import.meta.url), 'utf8'))
  .replace(/from (['"])\.\/particleLimits\1/g, () => `from ${JSON.stringify(limitsURL)}`);
const { AdaptiveQualityController } = await import(url(source));

// These are policy regression samples, not claimed browser / GPU benchmarks.
const clock = () => ({ now: 0 });
function feed(controller, time, seconds, frameMs, extra = {}) {
  const frames = Math.ceil(seconds * 1000 / frameMs);
  const changes = [];
  let prior = controller.state.currentCount;
  for (let frame = 0; frame < frames; frame++) {
    time.now += frameMs;
    const state = controller.observe({ now: time.now, frameMs, eligible: true, ...extra });
    if (state.currentCount !== prior) { changes.push({ now: time.now, count: state.currentCount }); prior = state.currentCount; }
  }
  return changes;
}

test('shared manual cap is 500k; adaptive minimum is 5k and does not override smaller source/user limits', () => {
  assert.deepEqual({ ...limits }, { ADAPTIVE_MIN_PARTICLES: 5000, DEFAULT_PARTICLE_COUNT: 30000, MAX_PARTICLES: 500000, MIN_PARTICLES: 1000 });
  const controller = new AdaptiveQualityController();
  assert.equal(controller.reset(500000, 500000).currentCount, 30000);
  assert.equal(controller.reset(3200, 500000).currentCount, 3200);
  assert.equal(controller.reset(500000, 1000).currentCount, 1000);
  assert.equal(controller.reset(500000, 500000, 1).currentCount, 5000);
  assert.equal(controller.reset(0, 500000).currentCount, 0);
  assert.equal(controller.reset(1000000, 1000000, 900000).currentCount, 500000);
});

test('no quantity increase before two seconds of real history plus a second sustained fast window', () => {
  const controller = new AdaptiveQualityController(), time = clock();
  controller.reset(500000, 500000);
  feed(controller, time, 1.9, 1000 / 60);
  assert.equal(controller.state.currentCount, 30000);
  assert.equal(controller.state.status, 'sampling');
  feed(controller, time, .6, 1000 / 60);
  assert.equal(controller.state.currentCount, 30000);
  assert.ok(controller.state.frameMsAvg > 16 && controller.state.frameMsAvg < 17);
  feed(controller, time, .6, 1000 / 60);
  assert.ok(controller.state.currentCount > 30000);
});

test('a strong sustained frame stream climbs through 100k and 200k to the real 500k cap', () => {
  const controller = new AdaptiveQualityController(), time = clock();
  controller.reset(500000, 500000);
  const changes = feed(controller, time, 50, 1000 / 60);
  assert.ok(changes.some(change => change.count > 100000 && change.count < 200000));
  assert.ok(changes.some(change => change.count >= 200000 && change.count < 500000));
  assert.equal(controller.state.currentCount, 500000);
  assert.equal(controller.state.status, 'ceiling');
  assert.ok(changes.every((change, index) => index === 0 || change.now - changes[index - 1].now >= 2900), 'growth has hysteresis, not frame-by-frame oscillation');
});

test('sustained sub-30 render frames descend quickly to 5k instead of a forced 10k floor', () => {
  const controller = new AdaptiveQualityController(), time = clock();
  controller.reset(500000, 500000, 80000);
  const changes = feed(controller, time, 15, 1000 / 20);
  assert.equal(controller.state.currentCount, 5000);
  assert.ok(changes.length >= 4);
  assert.ok(changes.every((change, index) => index === 0 || change.now - changes[index - 1].now >= 1900));
  assert.ok(changes.every((change, index) => index === 0 || change.count < changes[index - 1].count));
});

test('one isolated 1s stall does not immediately remove particles or count as sustained slow rendering', () => {
  const controller = new AdaptiveQualityController(), time = clock();
  controller.reset(500000, 500000);
  feed(controller, time, 1.5, 1000 / 60);
  feed(controller, time, 1, 1000);
  assert.equal(controller.state.currentCount, 30000);
  feed(controller, time, 1.5, 1000 / 60);
  assert.equal(controller.state.currentCount, 30000);
});

test('repeated intermittent stalls reduce density even when fewer than half of rendered frames are slow', () => {
  const controller = new AdaptiveQualityController(), time = clock();
  controller.reset(500000, 500000, 80000);
  for (let group = 0; group < 30; group++) {
    for (let frame = 0; frame < 9; frame++) {
      time.now += 16;
      controller.observe({ now: time.now, frameMs: 16, eligible: true });
    }
    time.now += 500;
    controller.observe({ now: time.now, frameMs: 500, eligible: true });
  }
  assert.ok(controller.state.currentCount < 80000, 'persistent expensive frames consume most of the elapsed time');
});

test('noise in the target deadband stays stable; short alternating fast/slow bursts do not oscillate quantity', () => {
  const controller = new AdaptiveQualityController(), time = clock();
  controller.reset(500000, 500000);
  for (let pair = 0; pair < 1000; pair++) {
    for (const frameMs of [18, 26]) { time.now += frameMs; controller.observe({ now: time.now, frameMs, eligible: true }); }
  }
  assert.equal(controller.state.currentCount, 30000);
  assert.equal(controller.state.status, 'stable');
  assert.ok(controller.state.fpsAvg > 44 && controller.state.fpsAvg < 47);
});

test('hidden, paused and capture-ineligible time clears history and never accumulates fake zero FPS', () => {
  const controller = new AdaptiveQualityController(), time = clock();
  controller.reset(500000, 500000);
  feed(controller, time, 1.8, 1000 / 60);
  feed(controller, time, 50, 1000 / 60, { eligible: false, reason: '录制中' });
  assert.equal(controller.state.currentCount, 30000);
  assert.equal(controller.state.status, 'frozen');
  assert.equal(controller.state.fpsAvg, 0);
  assert.equal(controller.state.sampleSeconds, 0);
  feed(controller, time, 1.8, 1000 / 60);
  assert.equal(controller.state.currentCount, 30000, 'prior history is not reused after visibility/pause changes');
  feed(controller, time, 1.4, 1000 / 60);
  assert.ok(controller.state.currentCount > 30000);
});

test('explicit freeze requires resume and keeps the exact draw count throughout even eligible fast frames', () => {
  const controller = new AdaptiveQualityController(), time = clock();
  controller.reset(500000, 500000, 80000);
  feed(controller, time, 1.8, 1000 / 60);
  controller.freeze('录制冻结');
  feed(controller, time, 50, 1000 / 120);
  assert.equal(controller.state.currentCount, 80000);
  assert.equal(controller.state.status, 'frozen');
  assert.equal(controller.state.reason, '录制冻结');
  controller.resume();
  feed(controller, time, 1.8, 1000 / 60);
  assert.equal(controller.state.currentCount, 80000);
  feed(controller, time, 1.4, 1000 / 60);
  assert.ok(controller.state.currentCount > 80000);
});

test('source capacity and live user ceiling are enforced without rebuilding or resetting the draw count upwards', () => {
  const controller = new AdaptiveQualityController(), time = clock();
  controller.reset(200000, 500000);
  feed(controller, time, 35, 1000 / 60);
  assert.equal(controller.state.currentCount, 200000);
  assert.match(controller.state.reason, /素材/);
  assert.equal(controller.setCeiling(80000).currentCount, 80000);
  assert.equal(controller.state.ceiling, 80000);
  assert.equal(controller.setCeiling(500000).currentCount, 80000, 'raising a ceiling only permits later measured growth');
  assert.equal(controller.state.ceiling, 200000);
  controller.resetSamples();
  feed(controller, time, 1.5, 1000 / 60);
  assert.equal(controller.state.currentCount, 80000);
  controller.reset(6000, 500000, 30000);
  feed(controller, time, 8, 1000 / 20);
  assert.equal(controller.state.currentCount, 5000);
  controller.reset(7, 500000);
  feed(controller, time, 8, 1000 / 20);
  assert.equal(controller.state.currentCount, 7);
});

test('invalid/duplicate samples cannot create history; a backwards clock restarts measurement safely', () => {
  const controller = new AdaptiveQualityController();
  controller.reset(500000, 500000);
  for (const frameMs of [0, -1, NaN, Infinity]) controller.observe({ now: 100000, frameMs, eligible: true });
  for (const fps of [0, -1, NaN, Infinity]) controller.observe({ now: 100000, fps, eligible: true });
  controller.observe({ now: NaN, frameMs: 16, eligible: true });
  assert.equal(controller.state.sampleSeconds, 0);
  assert.equal(controller.state.frameMsAvg, 0);
  controller.observe({ now: 100, frameMs: 16, eligible: true });
  controller.observe({ now: 100, frameMs: 2000, eligible: true });
  assert.equal(controller.state.frameMsAvg, 16);
  controller.observe({ now: 50, frameMs: 20, eligible: true });
  assert.equal(controller.state.frameMsAvg, 20);
  assert.equal(controller.state.currentCount, 30000);
  assert.ok(controller.state.sampleSeconds <= .02);
});

test('FPS fallback and frame milliseconds give the same decisions; exposed snapshots cannot mutate controller state', () => {
  const milliseconds = new AdaptiveQualityController(), fps = new AdaptiveQualityController();
  milliseconds.reset(500000, 500000); fps.reset(500000, 500000);
  for (let frame = 1; frame <= 720; frame++) {
    milliseconds.observe({ now: frame * 1000 / 60, frameMs: 1000 / 60, eligible: true });
    fps.observe({ now: frame * 1000 / 60, fps: 60, eligible: true });
  }
  assert.equal(milliseconds.state.currentCount, fps.state.currentCount);
  const snapshot = fps.state;
  snapshot.currentCount = 1;
  snapshot.ceiling = 1;
  assert.ok(fps.state.currentCount > 10000);
  assert.equal(fps.state.ceiling, 500000);
});

test('explicit warmup excludes compilation frames and intervals crossing its end', () => {
  const controller = new AdaptiveQualityController();
  controller.reset(500000, 300000);
  controller.warmup(0, 2000, '首次编译预热');
  for (const now of [500, 1000, 1500, 2000, 2100]) {
    controller.observe({ now, frameMs: 500, eligible: true });
    assert.equal(controller.state.currentCount, 30000);
    assert.equal(controller.state.sampleSeconds, 0);
    assert.equal(controller.state.frameMsAvg, 0);
    assert.match(controller.state.reason, /预热/);
  }
  const time = { now: 2100 };
  feed(controller, time, 4, 1000 / 60);
  assert.ok(controller.state.currentCount > 30000);
  assert.ok(controller.state.frameMsAvg < 17);
});

test('page-restoration warmup clears prior low/high windows without changing the retained count', () => {
  const controller = new AdaptiveQualityController(), time = clock();
  controller.reset(500000, 300000, 80000);
  feed(controller, time, 1.8, 1000 / 60);
  controller.warmup(100000, 2000, '页面恢复预热');
  controller.observe({ now: 101000, frameMs: 1000, eligible: true });
  controller.observe({ now: 102000, frameMs: 1000, eligible: true });
  assert.equal(controller.state.currentCount, 80000);
  assert.equal(controller.state.sampleSeconds, 0);
  const resumed = { now: 102000 };
  feed(controller, resumed, 1.8, 1000 / 60);
  assert.equal(controller.state.currentCount, 80000);
  feed(controller, resumed, 1.4, 1000 / 60);
  assert.ok(controller.state.currentCount > 80000);
});
