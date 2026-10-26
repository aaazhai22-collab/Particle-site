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
const presetUrl = moduleUrl(compile(await readFile(new URL('../src/stardustPreset.ts', import.meta.url), 'utf8'))
  .replace("from './petalPreset'", `from '${petalUrl}'`));
const { STARDUST_PRESET_NAME, STARDUST_PARAMS, STARDUST_TIMING, STARDUST_CLIP } = await import(presetUrl);

test('reference crystal look is an independent dense original-colour preset with controlled glow', () => {
  assert.equal(STARDUST_PRESET_NAME, '繁花星尘 · 渐蚀');
  assert.equal(STARDUST_PARAMS.grainStyle, true);
  assert.equal(petal.PETAL_PARAMS.grainStyle, false);
  assert.equal(STARDUST_PARAMS.surfaceMode, true);
  assert.equal(STARDUST_PARAMS.petalFlow, true);
  assert.equal(STARDUST_PARAMS.colorMode, 'original');
  assert.equal(STARDUST_PARAMS.autoCount, true);
  assert.equal(STARDUST_PARAMS.count, 500000);
  assert.equal(STARDUST_PARAMS.resolution, '1080p');
  assert.equal(STARDUST_PARAMS.fade, true);
  assert.ok(STARDUST_PARAMS.size < 2, 'fine grains remain distinct at normal viewing distance');
  assert.ok(STARDUST_PARAMS.sparkle > petal.PETAL_PARAMS.sparkle, 'crystal look has a distinct bright-core population');
  assert.ok(STARDUST_PARAMS.glow > petal.PETAL_PARAMS.glow && STARDUST_PARAMS.glow < 1);
  assert.ok(STARDUST_PARAMS.scatter < 0.2, 'correlated erosion must not become random sand');
  assert.notStrictEqual(STARDUST_PARAMS, petal.PETAL_PARAMS);
  assert.notStrictEqual(STARDUST_TIMING, petal.DEFAULT_PETAL_TIMING);
  assert.deepEqual({ params: petal.PETAL_PARAMS, clip: petal.PETAL_CLIP, timing: petal.DEFAULT_PETAL_TIMING }, originalPetal);
});

test('reference preset completes erosion, black hold and reversible assembly on the seconds timeline', () => {
  assert.equal(STARDUST_CLIP.duration, 36);
  assert.deepEqual(animation.clipLoopSeam(STARDUST_CLIP), { continuous: true, mismatches: [] });
  assert.notStrictEqual(STARDUST_CLIP, petal.PETAL_CLIP);
  for (const time of [0, 5, 33, 36]) assert.equal(animation.sampleClip(STARDUST_CLIP, time).progress, 0);
  for (const time of [19, 20, 21]) assert.equal(animation.sampleClip(STARDUST_CLIP, time).progress, 1);
  const before = animation.sampleClip(STARDUST_CLIP, 13).progress;
  const after = animation.sampleClip(STARDUST_CLIP, 17).progress;
  assert.ok(before > 0 && before < after && after < 1);
  assert.ok(animation.sampleClip(STARDUST_CLIP, 28).progress > 0);
  assert.ok(animation.sampleClip(STARDUST_CLIP, 28).progress < animation.sampleClip(STARDUST_CLIP, 23).progress);
});

test('reference look and user keyframes survive JSON and retiming without modifying shared defaults', () => {
  const saved = JSON.parse(JSON.stringify({ version: 2, effect: 'erosion', params: STARDUST_PARAMS, clip: STARDUST_CLIP, petalTiming: STARDUST_TIMING }));
  assert.equal(saved.params.grainStyle, true);
  assert.equal(saved.params.colorMode, 'original');
  assert.deepEqual(saved.params, STARDUST_PARAMS);
  const edited = animation.normalizeClip({ ...saved.clip, keyframes: [...saved.clip.keyframes,
    { id: 'user-crystal-detail', time: 10, scale: 1.2, rotation: [3, 12, 1], progress: 0.3, interpolation: 'linear' },
  ] });
  const shortened = petal.retimePetalClip(edited, saved.petalTiming, { ...saved.petalTiming, disperse: 7, assemble: 6 });
  assert.equal(shortened.duration, 23);
  const detail = shortened.keyframes.find(frame => frame.id === 'user-crystal-detail');
  assert.equal(detail.time, 7.5);
  assert.deepEqual({ ...detail, time: 10 }, edited.keyframes.find(frame => frame.id === detail.id));
  assert.deepEqual(animation.clipLoopSeam(shortened), { continuous: true, mismatches: [] });
  assert.deepEqual({ params: petal.PETAL_PARAMS, clip: petal.PETAL_CLIP, timing: petal.DEFAULT_PETAL_TIMING }, originalPetal);
});
