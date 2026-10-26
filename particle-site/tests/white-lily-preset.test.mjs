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
const petalUrl = moduleUrl(compile(await readFile(new URL('../src/petalPreset.ts', import.meta.url), 'utf8'))
  .replace("from './animation'", `from '${animationUrl}'`));
const petal = await import(petalUrl);
const originalPetal = structuredClone({ params: petal.PETAL_PARAMS, clip: petal.PETAL_CLIP, timing: petal.DEFAULT_PETAL_TIMING });
const whiteLilyUrl = moduleUrl(compile(await readFile(new URL('../src/whiteLilyPreset.ts', import.meta.url), 'utf8'))
  .replace("from './petalPreset'", `from '${petalUrl}'`));
const { WHITE_LILY_PRESET_NAME, WHITE_LILY_PARAMS, WHITE_LILY_CLIP, WHITE_LILY_TIMING } = await import(whiteLilyUrl);

test('白百合使用独立原色参数与真实1080p，柔化白色亮核且不覆盖粉花预设', () => {
  assert.equal(WHITE_LILY_PRESET_NAME, '白百合 · 自然风蚀');
  assert.equal(WHITE_LILY_PARAMS.colorMode, 'original');
  assert.equal(WHITE_LILY_PARAMS.resolution, '1080p');
  assert.equal(WHITE_LILY_PARAMS.autoCount, true);
  assert.equal(WHITE_LILY_PARAMS.count, 500000);
  assert.equal(WHITE_LILY_PARAMS.surfaceMode, true);
  assert.equal(WHITE_LILY_PARAMS.petalFlow, true);
  assert.equal(WHITE_LILY_PARAMS.fade, true);
  assert.ok(WHITE_LILY_PARAMS.sparkle < petal.PETAL_PARAMS.sparkle);
  assert.ok(WHITE_LILY_PARAMS.glow < petal.PETAL_PARAMS.glow);
  assert.ok(WHITE_LILY_PARAMS.opacity < petal.PETAL_PARAMS.opacity);
  assert.deepEqual({ params: petal.PETAL_PARAMS, clip: petal.PETAL_CLIP, timing: petal.DEFAULT_PETAL_TIMING }, originalPetal);
  assert.notStrictEqual(WHITE_LILY_PARAMS, petal.PETAL_PARAMS);
});

test('白百合36秒片段复用既有阶段数据，每轮原形与旋转精确闭合', () => {
  assert.deepEqual(WHITE_LILY_TIMING, { hold: 5, disperse: 14, blackout: 2, assemble: 12, rest: 3 });
  assert.notStrictEqual(WHITE_LILY_TIMING, petal.DEFAULT_PETAL_TIMING);
  assert.equal(WHITE_LILY_CLIP.duration, 36);
  assert.notStrictEqual(WHITE_LILY_CLIP, petal.PETAL_CLIP);
  assert.deepEqual(animation.clipLoopSeam(WHITE_LILY_CLIP), { continuous: true, mismatches: [] });
  for (const time of [0, 5, 33, 36]) assert.equal(animation.sampleClip(WHITE_LILY_CLIP, time).progress, 0);
  for (const time of [19, 20, 21]) assert.equal(animation.sampleClip(WHITE_LILY_CLIP, time).progress, 1);
  for (let cycle = 0; cycle < 5; cycle++) for (let time = 0; time < 36; time++) {
    assert.deepEqual(animation.sampleClip(WHITE_LILY_CLIP, (cycle * 36 + time) % 36), animation.sampleClip(WHITE_LILY_CLIP, time));
  }
});

test('白百合可沿用既有JSON timing和阶段重定时，保留用户姿态与新增帧', () => {
  const saved = JSON.parse(JSON.stringify({ version: 2, effect: 'erosion', params: WHITE_LILY_PARAMS, clip: WHITE_LILY_CLIP, petalTiming: WHITE_LILY_TIMING }));
  const edited = animation.normalizeClip({ ...saved.clip, keyframes: [...saved.clip.keyframes,
    { id: 'user-white-detail', time: 10, scale: 1.2, rotation: [3, 12, 1], progress: 0.3, interpolation: 'linear' },
  ] });
  const timing = { ...saved.petalTiming, disperse: 7, assemble: 6 };
  const result = petal.retimePetalClip(edited, saved.petalTiming, timing);
  const added = result.keyframes.find(frame => frame.id === 'user-white-detail');
  assert.equal(result.duration, 23);
  assert.equal(added.time, 7.5);
  assert.deepEqual({ ...added, time: 10 }, edited.keyframes.find(frame => frame.id === added.id));
  assert.deepEqual(animation.clipLoopSeam(result), { continuous: true, mismatches: [] });
  assert.equal(saved.params.resolution, '1080p');
  assert.equal(saved.petalTiming.disperse, 14);
});
