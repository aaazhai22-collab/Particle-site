import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Exercise the same pure elapsed-time integrator used by the live WebGL engine.
const source = await readFile(new URL('../src/playback.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { advancePlayback, advanceTimelineTime, resumePlayback } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);
const timing = { duration: 3, playbackRate: 1, motionSpeed: 1 };
const state = (overrides = {}) => ({
  progress: 0, running: false, mode: 'idle', direction: 1, time: 0, ...overrides,
});
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9,
  `Expected ${actual} to be within 1e-9 of ${expected}`);

test('continue starts a useful task from idle and completed endpoints', () => {
  assert.deepEqual(resumePlayback(state()), state({ mode: 'disperse', running: true }));
  const fromManual = resumePlayback(state({ progress: 0.42, time: 8 }));
  assert.equal(fromManual.progress, 0.42);
  assert.equal(fromManual.time, 8);
  assert.equal(fromManual.mode, 'disperse');
  assert.equal(fromManual.direction, 1);
  const fromDispersed = resumePlayback(state({ mode: 'disperse', progress: 1 }));
  assert.equal(fromDispersed.mode, 'assemble');
  assert.equal(fromDispersed.direction, -1);
  const fromAssembled = resumePlayback(state({ mode: 'assemble', direction: -1 }));
  assert.equal(fromAssembled.mode, 'disperse');
  assert.equal(fromAssembled.direction, 1);
});

test('pause freezes all animation time, and continue preserves an intermediate task', () => {
  const paused = state({ mode: 'assemble', direction: -1, progress: 0.44, time: 12 });
  assert.deepEqual(advancePlayback(paused, 120, timing), paused);
  assert.deepEqual(resumePlayback(paused), { ...paused, running: true });
  assert.deepEqual(paused, state({ mode: 'assemble', direction: -1, progress: 0.44, time: 12 }));
});

test('20 FPS and 144 FPS produce the same progress and motion phase', () => {
  const simulate = (frames) => {
    let result = state({ mode: 'disperse', running: true });
    for (let i = 0; i < frames; i++) result = advancePlayback(result, 2.25 / frames, timing);
    return result;
  };
  const low = simulate(45);
  const high = simulate(324);
  near(low.progress, 0.75);
  near(high.progress, 0.75);
  near(low.time, high.time);
});

test('speed changes integrate from the current state without restarting', () => {
  let result = state({ mode: 'disperse', running: true });
  result = advancePlayback(result, 0.6, timing);
  near(result.progress, 0.2);
  near(result.time, 0.6);
  result = advancePlayback(result, 0.6, { ...timing, playbackRate: 2, motionSpeed: 0 });
  near(result.progress, 0.6);
  near(result.time, 0.6);
});

test('loop reflects continuously at both endpoints, including long elapsed intervals', () => {
  const beforeTop = state({ mode: 'loop', running: true, progress: 0.99 });
  const atTop = advancePlayback(beforeTop, 0.03, timing);
  near(atTop.progress, 1);
  assert.equal(atTop.direction, -1);
  const afterTop = advancePlayback(atTop, 0.03, timing);
  near(afterTop.progress, 0.99);
  const beforeBottom = state({ mode: 'loop', running: true, progress: 0.01, direction: -1 });
  const atBottom = advancePlayback(beforeBottom, 0.03, timing);
  near(atBottom.progress, 0);
  assert.equal(atBottom.direction, 1);
  const longInterval = advancePlayback(state({ mode: 'loop', running: true }), 601.5, timing);
  near(longInterval.progress, 0.5);
  assert.equal(longInterval.direction, 1);
  near(longInterval.time, 601.5);
});

test('one-shot tasks stop at the exact endpoints without accumulated position error', () => {
  let result = state({ mode: 'disperse', running: true });
  for (let cycle = 0; cycle < 100; cycle++) {
    result = advancePlayback(result, 3.1, timing);
    assert.equal(result.progress, 1);
    assert.equal(result.running, false);
    result = resumePlayback(result);
    result = advancePlayback(result, 3.1, timing);
    assert.equal(result.progress, 0);
    assert.equal(result.running, false);
    result = resumePlayback(result);
  }
});

test('timeline pauses/clamps at its exact end, and looping handles multiple elapsed cycles', () => {
  assert.deepEqual(advanceTimelineTime(5.8, 0.2, 6, 1, false), { time: 6, completed: true });
  assert.deepEqual(advanceTimelineTime(5.8, 0.2, 6, 1, true), { time: 0, completed: false });
  assert.deepEqual(advanceTimelineTime(1, 601.5, 6, 2, true), { time: 4, completed: false });
  assert.deepEqual(advanceTimelineTime(1, 0, 6, 4, true), { time: 1, completed: false });
});

test('timeline speed is integrated without applying the legacy one-shot duration again', () => {
  const first = advanceTimelineTime(0, 1.5, 6, 1, false);
  const second = advanceTimelineTime(first.time, 0.5, 6, 2, false);
  assert.equal(second.time, 2.5);
  assert.equal(second.completed, false);
});

test('手动定位到完全散开后继续，会从当前位置聚合；中途保留此前运动方向', () => {
  const endpoint = resumePlayback(state({ progress: 1, mode: 'idle', time: 11 }));
  assert.equal(endpoint.mode, 'assemble');
  assert.equal(endpoint.direction, -1);
  assert.equal(endpoint.progress, 1);
  near(advancePlayback(endpoint, .3, timing).progress, .9);
  const backwards = resumePlayback(state({ progress: .42, direction: -1 }));
  assert.equal(backwards.mode, 'assemble');
  assert.equal(backwards.progress, .42);
  near(advancePlayback(backwards, .3, timing).progress, .32);
  const bottom = resumePlayback(state({ progress: 0, direction: -1 }));
  assert.equal(bottom.mode, 'disperse');
  assert.equal(bottom.direction, 1);
});

test('没有经过有效时间时精确保留时间轴终点，不因循环取模意外跳到起点', () => {
  assert.deepEqual(advanceTimelineTime(6, 0, 6, 1, true), { time: 6, completed: false });
  assert.deepEqual(advanceTimelineTime(6, -1, 6, 1, true), { time: 6, completed: false });
  assert.deepEqual(advanceTimelineTime(6, 1, 6, 0, true), { time: 6, completed: false });
  assert.deepEqual(advanceTimelineTime(6, .25, 6, 1, true), { time: .25, completed: false });
  assert.deepEqual(advanceTimelineTime(6, 0, 6, 1, false), { time: 6, completed: true });
});

test('非法时间、速率和时长不会污染时间轴或自由动画状态', () => {
  for (const delta of [NaN, Infinity, -Infinity]) {
    assert.deepEqual(advanceTimelineTime(3, delta, 6, 1, true), { time: 3, completed: false });
    const original = state({ mode: 'loop', running: true, progress: .4 });
    assert.deepEqual(advancePlayback(original, delta, timing), original);
  }
  for (const rate of [NaN, Infinity, -1]) {
    assert.deepEqual(advanceTimelineTime(3, 1, 6, rate, true), { time: 3, completed: false });
    const original = state({ mode: 'loop', running: true, progress: .4 });
    assert.deepEqual(advancePlayback(original, 1, { ...timing, playbackRate: rate }), original);
  }
  for (const duration of [NaN, Infinity, 0, -2]) {
    assert.deepEqual(advanceTimelineTime(3, 1, duration, 1, true), { time: 0, completed: true });
    const original = state({ mode: 'loop', running: true, progress: .4 });
    assert.deepEqual(advancePlayback(original, 1, { ...timing, duration }), original);
  }
  assert.deepEqual(advanceTimelineTime(NaN, .25, 6, 1, false), { time: .25, completed: false });
});
