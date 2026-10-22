export type AnimationInterpolation = 'smooth' | 'linear' | 'hold';

export interface AnimationKeyframe {
  id: string;
  time: number;
  scale: number;
  /** 整体素材的 XYZ 旋转角度，单位为度。 */
  rotation: [number, number, number];
  progress: number;
  /** 从此帧到下一帧的过渡；旧项目缺省为 smooth。 */
  interpolation?: AnimationInterpolation;
}

export interface AnimationClip {
  duration: number;
  keyframes: AnimationKeyframe[];
}

export interface AnimationSample {
  scale: number;
  rotation: [number, number, number];
  progress: number;
}

export const DEFAULT_CLIP: AnimationClip = {
  duration: 6,
  keyframes: [
    { id: 'key-start', time: 0, scale: 1, rotation: [0, 0, 0], progress: 0 },
    { id: 'key-dispersed', time: 3, scale: 1, rotation: [0, 0, 0], progress: 1 },
    { id: 'key-end', time: 6, scale: 1, rotation: [0, 0, 0], progress: 0 },
  ],
};

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 生成独立副本；同一时刻只保留最后输入的帧，不改变原输入。 */
export function normalizeClip(input: unknown): AnimationClip {
  const raw = isRecord(input) ? input : {};
  const duration = clamp(finite(raw.duration, DEFAULT_CLIP.duration), 0.5, 120);
  const source = Array.isArray(raw.keyframes) ? raw.keyframes : [];
  const byTime = new Map<number, AnimationKeyframe>();
  source.forEach((value, index) => {
    if (!isRecord(value)) return;
    const rotation = Array.isArray(value.rotation) ? value.rotation : [];
    const frame: AnimationKeyframe = {
      id: typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `keyframe-${index + 1}`,
      time: clamp(finite(value.time, 0), 0, duration),
      scale: clamp(finite(value.scale, 1), 0.1, 4),
      rotation: [0, 1, 2].map((axis) => clamp(finite(rotation[axis], 0), -1080, 1080)) as [number, number, number],
      progress: clamp(finite(value.progress, 0), 0, 1),
    };
    if (value.interpolation === 'smooth' || value.interpolation === 'linear' || value.interpolation === 'hold') {
      frame.interpolation = value.interpolation;
    }
    byTime.set(frame.time, frame);
  });
  const keyframes = [...byTime.values()].sort((left, right) => left.time - right.time);
  if (keyframes.length === 0) {
    DEFAULT_CLIP.keyframes.forEach((frame) => keyframes.push({
      ...frame,
      time: frame.time / DEFAULT_CLIP.duration * duration,
      rotation: [...frame.rotation],
    }));
  }
  const ids = new Set<string>();
  keyframes.forEach((frame) => {
    const base = frame.id;
    let suffix = 2;
    while (ids.has(frame.id)) frame.id = `${base}-${suffix++}`;
    ids.add(frame.id);
  });
  return { duration, keyframes };
}

/** 更改播放时长时按比例移动帧，保留帧数量、姿态和动画结构。 */
export function retimeClip(input: AnimationClip, duration: number): AnimationClip {
  const clip = normalizeClip(input);
  const nextDuration = clamp(finite(duration, clip.duration), 0.5, 120);
  return normalizeClip({
    duration: nextDuration,
    keyframes: clip.keyframes.map((frame) => ({ ...frame, time: frame.time / clip.duration * nextDuration })),
  });
}

/** 编辑时间不能悄悄覆盖另一帧；导入同刻帧的兼容规则仍由 normalizeClip 管理。 */
export function updateKeyframe(
  input: AnimationClip,
  id: string,
  patch: Partial<Omit<AnimationKeyframe, 'id'>>,
): { clip: AnimationClip; error: string | null } {
  const clip = normalizeClip(input);
  const selected = clip.keyframes.find((frame) => frame.id === id);
  if (!selected) return { clip, error: '选中的关键帧已不存在，请重新选择。' };
  const time = clamp(finite(patch.time, selected.time), 0, clip.duration);
  if (clip.keyframes.some((frame) => frame.id !== id && Math.abs(frame.time - time) < 1e-7)) {
    return { clip, error: `${Number(time.toFixed(2))} 秒已有关键帧，请选择其他时间；原有帧均已保留。` };
  }
  return {
    clip: normalizeClip({ ...clip, keyframes: clip.keyframes.map((frame) => frame.id === id ? { ...frame, ...patch, id, time } : frame) }),
    error: null,
  };
}

/** 在当前画面打帧；接近已有帧时更新该帧，避免比例缩时产生的小数时间重复。 */
export function captureKeyframe(input: AnimationClip, time: number, sample: AnimationSample, id: string): {
  clip: AnimationClip; frame: AnimationKeyframe;
} {
  const clip = normalizeClip(input);
  const exactTime = clamp(finite(time, 0), 0, clip.duration);
  const nearest = clip.keyframes.reduce((closest, frame) => Math.abs(frame.time - exactTime) < Math.abs(closest.time - exactTime) ? frame : closest);
  const existing = Math.abs(nearest.time - exactTime) <= 0.005000001 ? nearest : undefined;
  const frame = {
    ...existing,
    ...sample,
    id: existing?.id ?? id,
    time: existing?.time ?? Math.min(clip.duration, Math.round(exactTime * 100) / 100),
  };
  const next = normalizeClip({ ...clip, keyframes: [...clip.keyframes.filter((entry) => entry.id !== existing?.id), frame] });
  return { clip: next, frame: next.keyframes.find((entry) => entry.id === frame.id)! };
}

function frameSample(frame: AnimationKeyframe): AnimationSample {
  return { scale: frame.scale, rotation: [...frame.rotation], progress: frame.progress };
}

/**
 * 在秒制时间轴上取样，按左帧选择过渡，缺省 smoothstep；端点精确还原。
 * 旋转角度直接插值，0 → 360° 表示完整一圈，0 → 720° 表示两圈。
 */
export function sampleClip(input: AnimationClip, time: number): AnimationSample {
  const clip = normalizeClip(input);
  const position = clamp(finite(time, 0), 0, clip.duration);
  const first = clip.keyframes[0];
  const last = clip.keyframes[clip.keyframes.length - 1];
  if (position <= first.time) return frameSample(first);
  if (position >= last.time) return frameSample(last);
  const rightIndex = clip.keyframes.findIndex((frame) => frame.time >= position);
  const right = clip.keyframes[rightIndex];
  if (position === right.time) return frameSample(right);
  const left = clip.keyframes[rightIndex - 1];
  const ratio = (position - left.time) / (right.time - left.time);
  const eased = left.interpolation === 'hold' ? 0 : left.interpolation === 'linear' ? ratio : ratio * ratio * (3 - 2 * ratio);
  const interpolate = (from: number, to: number) => from + (to - from) * eased;
  return {
    scale: interpolate(left.scale, right.scale),
    rotation: left.rotation.map((angle, axis) => interpolate(angle, right.rotation[axis])) as [number, number, number],
    progress: interpolate(left.progress, right.progress),
  };
}

/** 只提示循环接缝，不自动补帧或改变用户角度。整圈旋转视为相同姿态。 */
export function clipLoopSeam(input: AnimationClip): { continuous: boolean; mismatches: string[] } {
  const clip = normalizeClip(input);
  const start = sampleClip(clip, 0), end = sampleClip(clip, clip.duration);
  const mismatches: string[] = [];
  if (Math.abs(start.progress - end.progress) > 1e-6) mismatches.push('形态');
  if (Math.abs(start.scale - end.scale) > 1e-6) mismatches.push('缩放');
  const quaternion = (angles: [number, number, number]) => {
    const [x, y, z] = angles.map((angle) => angle * Math.PI / 360);
    const c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z);
    const s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z);
    return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3,
      c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
  };
  const first = quaternion(start.rotation), last = quaternion(end.rotation);
  if (1 - Math.abs(first.reduce((sum, value, axis) => sum + value * last[axis], 0)) > 1e-10) mismatches.push('旋转');
  return { continuous: mismatches.length === 0, mismatches };
}
