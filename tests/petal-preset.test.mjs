import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const animationUrl = moduleUrl(compile(await readFile(new URL('../src/animation.ts', import.meta.url), 'utf8')));
const animation = await import(animationUrl);
const presetSource = compile(await readFile(new URL('../src/petalPreset.ts', import.meta.url), 'utf8'))
  .replace("from './animation'", `from '${animationUrl}'`);
const { PETAL_CLIP, PETAL_PARAMS, DEFAULT_PETAL_TIMING, createPetalClip, getPetalStages, normalizePetalTiming, retimePetalClip, scalePetalTiming, petalPhaseAt } = await import(moduleUrl(presetSource));
const close = (actual, expected, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);

test('36 秒回环保留原形、局部蚀空、黑场和缓慢还原的实际时段', () => {
  assert.equal(PETAL_CLIP.duration, 36);
  assert.deepEqual(getPetalStages(), { holdEnd: 5, erosionEnd: 15, fadeEnd: 19, blackEnd: 21, assembleEnd: 33, duration: 36 });
  for (const time of [0, 2, 5, 33, 35, 36]) assert.equal(animation.sampleClip(PETAL_CLIP, time).progress, 0);
  close(animation.sampleClip(PETAL_CLIP, 15).progress, 0.65);
  for (const time of [19, 20, 21]) assert.equal(animation.sampleClip(PETAL_CLIP, time).progress, 1);
  assert.deepEqual(animation.clipLoopSeam(PETAL_CLIP), { continuous: true, mismatches: [] });
  assert.deepEqual(createPetalClip(), createPetalClip(), 'repeated creation is deterministic and independent');
});

test('消散和聚合时长独立修改，原形与黑场停留不被播放倍率重复缩放', () => {
  const timing = { ...DEFAULT_PETAL_TIMING, disperse: 7, assemble: 18 };
  const clip = createPetalClip(timing), stages = getPetalStages(timing);
  assert.equal(clip.duration, 35);
  assert.equal(stages.fadeEnd - stages.holdEnd, 7);
  assert.equal(stages.assembleEnd - stages.blackEnd, 18);
  assert.equal(stages.blackEnd - stages.fadeEnd, 2);
  close(animation.sampleClip(clip, stages.erosionEnd).progress, 0.65);
  assert.equal(animation.sampleClip(clip, stages.assembleEnd).progress, 0);
});

test('阶段改时保留用户额外打帧、姿态、插值与独立对象，不重新生成帧', () => {
  const edited = animation.normalizeClip({ ...PETAL_CLIP, keyframes: [...PETAL_CLIP.keyframes,
    { id: 'user-extra', time: 10, scale: 1.3, rotation: [4, 12, 8], progress: 0.23, interpolation: 'linear' },
    { id: 'user-return', time: 27, scale: 1.2, rotation: [0, -8, 1], progress: 0.42, interpolation: 'hold' },
  ] });
  const snapshot = structuredClone(edited);
  const timing = { ...DEFAULT_PETAL_TIMING, disperse: 7, assemble: 6 };
  const next = retimePetalClip(edited, DEFAULT_PETAL_TIMING, timing);
  assert.equal(next.keyframes.length, edited.keyframes.length);
  const extra = next.keyframes.find(frame => frame.id === 'user-extra');
  const returning = next.keyframes.find(frame => frame.id === 'user-return');
  close(extra.time, 7.5);
  close(returning.time, 17);
  for (const prior of edited.keyframes) {
    const current = next.keyframes.find(frame => frame.id === prior.id);
    assert.deepEqual({ ...current, time: prior.time }, prior);
  }
  assert.deepEqual(edited, snapshot, 'input clip remains unchanged');
  assert.deepEqual(animation.clipLoopSeam(next), { continuous: true, mismatches: [] });
});

test('修改总时长后阶段按秒同步，再调整单一阶段仍维持其余时段', () => {
  const doubled = animation.retimeClip(PETAL_CLIP, 72);
  const priorTiming = scalePetalTiming(DEFAULT_PETAL_TIMING, 72);
  assert.deepEqual(priorTiming, { hold: 10, disperse: 28, blackout: 4, assemble: 24, rest: 6 });
  const timing = { ...priorTiming, assemble: 12 };
  const result = retimePetalClip(doubled, priorTiming, timing);
  assert.equal(result.duration, 60);
  const stages = getPetalStages(timing);
  assert.equal(stages.holdEnd, 10);
  assert.equal(stages.fadeEnd, 38);
  assert.equal(stages.blackEnd, 42);
  assert.equal(stages.assembleEnd, 54);
});

test('导入时缺失和异常时段有界，输出片段不会超出时间轴120秒限制', () => {
  assert.deepEqual(normalizePetalTiming(undefined), DEFAULT_PETAL_TIMING);
  for (const input of [{ disperse: Infinity, assemble: NaN }, { hold: -5, disperse: 800, blackout: 0, assemble: 800, rest: -1 }, {}, null]) {
    const timing = normalizePetalTiming(input), stages = getPetalStages(timing), clip = createPetalClip(timing);
    assert.ok(Object.values(timing).every(value => Number.isFinite(value) && value > 0));
    assert.ok(stages.duration <= 120 + 1e-9 && stages.duration >= 0.5 - 1e-9);
    assert.ok(clip.keyframes.every(frame => frame.time >= 0 && frame.time <= clip.duration));
    assert.equal(clip.keyframes.length, 7);
  }
});

test('阶段标签在边界切换，末段聚合与消散不是同一速度控制', () => {
  assert.equal(petalPhaseAt(0, DEFAULT_PETAL_TIMING), '原形与外围微流');
  assert.equal(petalPhaseAt(5, DEFAULT_PETAL_TIMING), '局部侵蚀');
  assert.equal(petalPhaseAt(15, DEFAULT_PETAL_TIMING), '卷曲细丝与淡出');
  assert.equal(petalPhaseAt(19, DEFAULT_PETAL_TIMING), '黑场停留');
  assert.equal(petalPhaseAt(21, DEFAULT_PETAL_TIMING), '缓慢聚合还原');
  assert.equal(petalPhaseAt(33, DEFAULT_PETAL_TIMING), '原形停留');
});

test('示例预设使用真实1080p、主体数量预算与分层微流，保留稀少亮核', () => {
  assert.equal(PETAL_PARAMS.resolution, '1080p');
  assert.equal(PETAL_PARAMS.autoCount, true);
  assert.equal(PETAL_PARAMS.count, 500000);
  assert.equal(PETAL_PARAMS.surfaceMode, true);
  assert.equal(PETAL_PARAMS.petalFlow, true);
  assert.equal(PETAL_PARAMS.colorMode, 'original');
  assert.equal(PETAL_PARAMS.fade, true);
  assert.ok(PETAL_PARAMS.ambient > 0 && PETAL_PARAMS.ambient <= 0.08);
  assert.ok(PETAL_PARAMS.sparkle <= 0.1);
  assert.ok(PETAL_PARAMS.size >= 0.5 && PETAL_PARAMS.size <= 1.2, '1080p and perspective sizing must still preserve fine grains');
});
