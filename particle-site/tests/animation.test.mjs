import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/animation.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { DEFAULT_CLIP, normalizeClip, retimeClip, sampleClip, updateKeyframe, captureKeyframe, clipLoopSeam } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const frame = (id, time, progress, scale = 1, rotation = [0, 0, 0]) => ({ id, time, progress, scale, rotation });
const close = (actual, expected, epsilon = 1e-12) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} 应接近 ${expected}`);

test('默认 6 秒片段在 0、3、6 秒精确聚合、消散、聚合', () => {
  assert.equal(DEFAULT_CLIP.duration, 6);
  for (const [time, progress] of [[0, 0], [3, 1], [6, 0]]) {
    assert.deepEqual(sampleClip(DEFAULT_CLIP, time), { scale: 1, rotation: [0, 0, 0], progress });
  }
  close(sampleClip(DEFAULT_CLIP, 1.5).progress, 0.5);
  close(sampleClip(DEFAULT_CLIP, 4.5).progress, 0.5);
});

test('相邻帧的形态、缩放与各轴旋转共用分段 smoothstep', () => {
  const clip = { duration: 4, keyframes: [frame('a', 0, 0, 1, [0, 360, -180]), frame('b', 4, 1, 3, [720, -360, 180])] };
  const sample = sampleClip(clip, 1);
  close(sample.progress, 0.15625);
  close(sample.scale, 1.3125);
  assert.deepEqual(sample.rotation, [112.5, 247.5, -123.75]);
  assert.deepEqual(sampleClip(clip, 2), { progress: 0.5, scale: 2, rotation: [360, 0, 0] });
  assert.deepEqual(sampleClip(clip, 4), { progress: 1, scale: 3, rotation: [720, -360, 180] });
});

test('时间越界保持边界姿态，首末帧之外保持最近姿态', () => {
  const first = frame('first', 2, 0.2, 0.5, [10, 20, 30]);
  const last = frame('last', 8, 0.8, 2, [70, 80, 90]);
  const clip = { duration: 10, keyframes: [first, last] };
  for (const time of [-100, 0, 1, 2]) assert.deepEqual(sampleClip(clip, time), { scale: 0.5, rotation: [10, 20, 30], progress: 0.2 });
  for (const time of [8, 9, 10, 100]) assert.deepEqual(sampleClip(clip, time), { scale: 2, rotation: [70, 80, 90], progress: 0.8 });
});

test('单帧片段始终稳定，非法时间不会产生 NaN', () => {
  const clip = { duration: 5, keyframes: [frame('only', 2, 0.35, 1.7, [-90, 45, 1080])] };
  for (const time of [0, 2, 5, NaN, Infinity, -Infinity]) {
    assert.deepEqual(sampleClip(clip, time), { progress: 0.35, scale: 1.7, rotation: [-90, 45, 1080] });
  }
});

test('空或非法片段恢复默认帧，并按合法总时长分布', () => {
  for (const input of [null, undefined, [], 'invalid', { duration: NaN, keyframes: null }]) {
    assert.deepEqual(normalizeClip(input), DEFAULT_CLIP);
  }
  assert.deepEqual(normalizeClip({ duration: 20, keyframes: [] }).keyframes.map((entry) => entry.time), [0, 10, 20]);
  assert.equal(normalizeClip({ duration: -10 }).duration, 0.5);
  assert.equal(normalizeClip({ duration: 200 }).duration, 120);
});

test('数据校验限制所有参数，缺失和非有限数值采用安全值', () => {
  const clip = normalizeClip({ duration: 9, keyframes: [
    frame('a', -10, -2, -5, [-2000, Infinity, 2000]),
    frame('b', 60, 4, 20, [NaN, -Infinity, 30]),
    null,
    'invalid',
  ] });
  assert.deepEqual(clip.keyframes, [
    frame('a', 0, 0, 0.1, [-1080, 0, 1080]),
    frame('b', 9, 1, 4, [0, 0, 30]),
  ]);
  const missing = normalizeClip({ duration: 2, keyframes: [{ time: 1 }] }).keyframes[0];
  assert.equal(missing.time, 1);
  assert.equal(missing.scale, 1);
  assert.equal(missing.progress, 0);
  assert.deepEqual(missing.rotation, [0, 0, 0]);
  assert.ok(missing.id);
});

test('按时间排序，重复时刻保留最后输入帧，所有帧 ID 唯一', () => {
  const clip = normalizeClip({ duration: 10, keyframes: [
    frame('same', 7, 0.7), frame('same', 1, 0.1), frame('same-2', 3, 0.3),
    frame('discarded', 2, 0.2), frame('last-at-two', 2, 0.9),
  ] });
  assert.deepEqual(clip.keyframes.map((entry) => entry.time), [1, 2, 3, 7]);
  assert.equal(clip.keyframes[1].id, 'last-at-two');
  assert.equal(clip.keyframes[1].progress, 0.9);
  assert.equal(new Set(clip.keyframes.map((entry) => entry.id)).size, clip.keyframes.length);
  const collapsed = normalizeClip({ duration: 2, keyframes: [frame('early-input', 5, 0.5), frame('last-input', 3, 1)] });
  assert.equal(collapsed.keyframes.length, 1);
  assert.equal(collapsed.keyframes[0].id, 'last-input');
  assert.equal(collapsed.keyframes[0].time, 2);
});

test('归一化和取样不改变原始数据，返回的旋转数组互不共享', () => {
  const input = { duration: 8, keyframes: [frame('b', 8, 1, 3, [360, 720, 1080]), frame('a', 0, 0)] };
  const original = structuredClone(input);
  const clip = normalizeClip(input);
  const start = sampleClip(clip, 0);
  const middle = sampleClip(clip, 4);
  start.rotation[0] = 999;
  middle.rotation[1] = 999;
  clip.keyframes[0].rotation[2] = 999;
  assert.deepEqual(input, original);
  assert.deepEqual(sampleClip(input, 0).rotation, [0, 0, 0]);
  assert.deepEqual(sampleClip(input, 4).rotation, [180, 360, 540]);
});

test('旋转支持整圈与多圈，不自动折算为最短角度', () => {
  const clip = { duration: 4, keyframes: [frame('start', 0, 0), frame('end', 4, 1, 1, [360, 720, -1080])] };
  assert.deepEqual(sampleClip(clip, 2).rotation, [180, 360, -540]);
  assert.deepEqual(sampleClip(clip, 4).rotation, [360, 720, -1080]);
});

test('修改总时长按比例保留所有帧及相同相对时间的姿态，短片段不坍缩', () => {
  const original = { duration: 6, keyframes: [frame('start', 0, 0), frame('middle', 3, 1, 2, [360, 90, -180]), frame('end', 6, 0)] };
  const resized = retimeClip(original, 3);
  assert.deepEqual(resized.keyframes.map((entry) => [entry.id, entry.time]), [['start', 0], ['middle', 1.5], ['end', 3]]);
  assert.deepEqual(sampleClip(resized, 0.75), sampleClip(original, 1.5));
  const shortest = retimeClip(resized, 0.1);
  assert.equal(shortest.duration, 0.5);
  assert.equal(shortest.keyframes.length, 3);
  assert.deepEqual(shortest.keyframes.map((entry) => entry.time), [0, 0.25, 0.5]);
  assert.deepEqual(retimeClip(retimeClip(original, 120), 6), normalizeClip(original));
  assert.deepEqual(retimeClip(original, NaN), normalizeClip(original));
  assert.equal(original.keyframes[1].time, 3);
});

test('中间关键帧连续平滑，反复前后取样始终精确还原端点', () => {
  const before = sampleClip(DEFAULT_CLIP, 3 - 1e-5).progress;
  const after = sampleClip(DEFAULT_CLIP, 3 + 1e-5).progress;
  close(before, 1, 1e-9);
  close(after, 1, 1e-9);
  for (let cycle = 0; cycle < 100; cycle++) {
    for (let index = 0; index <= 60; index++) sampleClip(DEFAULT_CLIP, index / 10);
    for (let index = 60; index >= 0; index--) sampleClip(DEFAULT_CLIP, index / 10);
    assert.deepEqual(sampleClip(DEFAULT_CLIP, 0), { scale: 1, rotation: [0, 0, 0], progress: 0 });
    assert.deepEqual(sampleClip(DEFAULT_CLIP, 6), { scale: 1, rotation: [0, 0, 0], progress: 0 });
  }
});

test('每帧可指定到下一帧的过渡；旧项目仍为平滑，保持在准确关键帧才切换', () => {
  const a = frame('a', 0, 0, 1, [0, 0, 0]), b = frame('b', 4, 1, 3, [360, -720, 1080]);
  const original = { duration: 4, keyframes: [a, b] };
  close(sampleClip(original, 1).progress, .15625);
  const linear = { ...original, keyframes: [{ ...a, interpolation: 'linear' }, b] };
  assert.deepEqual(sampleClip(linear, 1), { progress: .25, scale: 1.5, rotation: [90, -180, 270] });
  const held = { ...original, keyframes: [{ ...a, interpolation: 'hold' }, b] };
  assert.deepEqual(sampleClip(held, 4 - 1e-8), sampleClip(held, 0));
  assert.deepEqual(sampleClip(held, 4), { progress: 1, scale: 3, rotation: [360, -720, 1080] });
  assert.equal(normalizeClip(linear).keyframes[0].interpolation, 'linear');
  assert.equal(retimeClip(held, 8).keyframes[0].interpolation, 'hold');
  assert.equal(normalizeClip({ ...original, keyframes: [{ ...a, interpolation: 'invalid' }, b] }).keyframes[0].interpolation, undefined);
  assert.deepEqual(original, { duration: 4, keyframes: [a, b] });
});

test('移动关键帧到已有时刻会拒绝整个操作，不会静默删除或改写任一帧', () => {
  const original = structuredClone(DEFAULT_CLIP);
  const result = updateKeyframe(original, 'key-start', { time: 3, progress: .4 });
  assert.ok(result.error?.includes('已有关键帧'));
  assert.deepEqual(result.clip, original);
  assert.deepEqual(original, DEFAULT_CLIP);
  const moved = updateKeyframe(original, 'key-dispersed', { time: 4.25, scale: 2.5, rotation: [90, 180, 360] });
  assert.equal(moved.error, null);
  assert.equal(moved.clip.keyframes.length, 3);
  assert.deepEqual(moved.clip.keyframes[1], frame('key-dispersed', 4.25, 1, 2.5, [90, 180, 360]));
  assert.ok(updateKeyframe(original, 'missing-id', { time: 2 }).error?.includes('不存在'));
});

test('比例缩时后的分数帧时间仍可原位更新，不会生成邻近重复关键帧', () => {
  const clip = retimeClip(DEFAULT_CLIP, 2 / 3);
  const sample = { progress: .42, scale: 1.7, rotation: [15, 270, -90] };
  const captured = captureKeyframe(clip, clip.keyframes[1].time, sample, 'new-id');
  assert.equal(captured.clip.keyframes.length, 3);
  assert.equal(captured.frame.id, 'key-dispersed');
  assert.equal(captured.frame.time, 1 / 3);
  assert.deepEqual(sampleClip(captured.clip, 1 / 3), sample);
  assert.deepEqual(clip.keyframes[1], frame('key-dispersed', 1 / 3, 1));
});

test('打帧采用传入的实际形态和角度，新增帧独立复制，更新已有帧保留其过渡', () => {
  const clip = { duration: 6, keyframes: [{ ...frame('a', 0, 0), interpolation: 'hold' }, frame('b', 6, 0)] };
  const manual = { progress: .7, scale: 1.8, rotation: [-25, 450, 0] };
  const added = captureKeyframe(clip, 2.234, manual, 'captured');
  assert.equal(added.frame.time, 2.23);
  assert.equal(added.frame.id, 'captured');
  assert.deepEqual(sampleClip(added.clip, 2.23), manual);
  const updated = captureKeyframe(clip, 0, manual, 'ignored-new-id');
  assert.equal(updated.frame.id, 'a');
  assert.equal(updated.frame.interpolation, 'hold');
  manual.rotation[1] = 0;
  assert.equal(added.frame.rotation[1], 450);
  assert.equal(updated.frame.rotation[1], 450);
  assert.equal(clip.keyframes[0].rotation[1], 0);
});

test('循环接缝按实际首尾姿态检查，整圈与等价 XYZ 角度不误报', () => {
  assert.deepEqual(clipLoopSeam(DEFAULT_CLIP), { continuous: true, mismatches: [] });
  const a = frame('a', 0, 0), b = frame('b', 6, 0, 1, [360, -720, 1080]);
  assert.equal(clipLoopSeam({ duration: 6, keyframes: [a, b] }).continuous, true);
  assert.equal(clipLoopSeam({ duration: 6, keyframes: [a, { ...b, rotation: [180, 180, 180] }] }).continuous, true);
  assert.deepEqual(clipLoopSeam({ duration: 6, keyframes: [a, frame('b', 6, 1, 2, [0, 90, 0])] }),
    { continuous: false, mismatches: ['形态', '缩放', '旋转'] });
  // 两端没有关键帧时，检查的是实际保持的首末姿态，也不插入或改写用户帧。
  const unclosed = { duration: 10, keyframes: [frame('a', 2, .2), frame('b', 8, .8)] };
  const copy = structuredClone(unclosed);
  assert.deepEqual(clipLoopSeam(unclosed), { continuous: false, mismatches: ['形态'] });
  assert.deepEqual(unclosed, copy);
});
