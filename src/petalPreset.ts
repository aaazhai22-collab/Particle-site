import { normalizeClip } from './animation';
import type { AnimationClip } from './animation';
import type { ParticleParams } from './ParticleEngine';

export const PETAL_PRESET_NAME = '花瓣微流 · 渐隐回环';

export interface PetalTiming {
  hold: number;
  disperse: number;
  blackout: number;
  assemble: number;
  rest: number;
}

export const DEFAULT_PETAL_TIMING: PetalTiming = {
  hold: 5, disperse: 14, blackout: 2, assemble: 12, rest: 3,
};

/** Stored with the preset, independently of its source image or model. */
export const PETAL_PARAMS: Partial<ParticleParams> = {
  autoCount: true, count: 500_000, resolution: '1080p',
  surfaceMode: true, petalFlow: true,
  ambient: 0.02, ambientRange: 0.3, ambientSpeed: 0.5,
  colorMode: 'original', size: 1.05, opacity: 0.94,
  glow: 0.3, exposure: 1.25, contrast: 1.1, sparkle: 0.06,
  curl: 1.8, spread: 0.6, depth: 1.2, scatter: 0.06, stagger: 0.65,
  turbulence: 0.14, motionSpeed: 0.55, playbackRate: 1,
  erosion: 0.8, flowScale: 1.25, stringiness: 2.2, trail: 0.55,
  fade: true, direction: 'y', autoRotate: false, duration: 14,
};

export function normalizePetalTiming(input: unknown = DEFAULT_PETAL_TIMING): PetalTiming {
  const source = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const timing = { ...DEFAULT_PETAL_TIMING };
  for (const key of Object.keys(timing) as (keyof PetalTiming)[]) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) timing[key] = Math.min(120, Math.max(0.01, value));
  }
  const sum = Object.values(timing).reduce((total, value) => total + value, 0);
  const scale = Math.min(120, Math.max(0.5, sum)) / sum;
  for (const key of Object.keys(timing) as (keyof PetalTiming)[]) timing[key] *= scale;
  return timing;
}

export function scalePetalTiming(input: PetalTiming, duration: number): PetalTiming {
  const timing = normalizePetalTiming(input);
  const sum = Object.values(timing).reduce((total, value) => total + value, 0);
  const target = Number.isFinite(duration) ? Math.min(120, Math.max(0.5, duration)) : sum;
  return Object.fromEntries(Object.entries(timing).map(([key, value]) => [key, value * target / sum])) as unknown as PetalTiming;
}

export function getPetalStages(input: PetalTiming = DEFAULT_PETAL_TIMING) {
  const timing = normalizePetalTiming(input);
  const holdEnd = timing.hold;
  const erosionEnd = holdEnd + timing.disperse * 5 / 7;
  const fadeEnd = holdEnd + timing.disperse;
  const blackEnd = fadeEnd + timing.blackout;
  const assembleEnd = blackEnd + timing.assemble;
  return { holdEnd, erosionEnd, fadeEnd, blackEnd, assembleEnd, duration: assembleEnd + timing.rest };
}

export function createPetalClip(input: Partial<PetalTiming> = DEFAULT_PETAL_TIMING): AnimationClip {
  const stages = getPetalStages(normalizePetalTiming(input));
  return normalizeClip({
    duration: stages.duration,
    keyframes: [
      { id: 'petal-start', time: 0, scale: 1, rotation: [0, 0, 0], progress: 0 },
      { id: 'petal-hold', time: stages.holdEnd, scale: 1.01, rotation: [0, 2, 0], progress: 0 },
      { id: 'petal-erosion', time: stages.erosionEnd, scale: 1.025, rotation: [-1, 6, -1], progress: 0.65 },
      { id: 'petal-fade', time: stages.fadeEnd, scale: 1.035, rotation: [-1, 8, -1], progress: 1 },
      { id: 'petal-black', time: stages.blackEnd, scale: 1.035, rotation: [-1, 8, -1], progress: 1 },
      { id: 'petal-restored', time: stages.assembleEnd, scale: 1, rotation: [0, 0, 0], progress: 0 },
      { id: 'petal-end', time: stages.duration, scale: 1, rotation: [0, 0, 0], progress: 0 },
    ],
  });
}

export const PETAL_CLIP = createPetalClip();

/** Move all edited frames through the same stage map; never regenerate user poses. */
export function retimePetalClip(input: AnimationClip, previous: PetalTiming, next: PetalTiming): AnimationClip {
  const clip = normalizeClip(input);
  const before = getPetalStages(scalePetalTiming(previous, clip.duration));
  const after = getPetalStages(next);
  const from = [0, before.holdEnd, before.erosionEnd, before.fadeEnd, before.blackEnd, before.assembleEnd, before.duration];
  const to = [0, after.holdEnd, after.erosionEnd, after.fadeEnd, after.blackEnd, after.assembleEnd, after.duration];
  const mapTime = (time: number) => {
    const right = from.findIndex((boundary, index) => index > 0 && time <= boundary);
    if (right < 0) return after.duration;
    const ratio = (time - from[right - 1]) / (from[right] - from[right - 1]);
    return to[right - 1] + ratio * (to[right] - to[right - 1]);
  };
  return normalizeClip({ duration: after.duration, keyframes: clip.keyframes.map(frame => ({ ...frame, time: mapTime(frame.time) })) });
}

export function petalPhaseAt(time: number, timing: PetalTiming): string {
  const stages = getPetalStages(timing);
  if (time < stages.holdEnd) return '原形与外围微流';
  if (time < stages.erosionEnd) return '局部侵蚀';
  if (time < stages.fadeEnd) return '卷曲细丝与淡出';
  if (time < stages.blackEnd) return '黑场停留';
  if (time < stages.assembleEnd) return '缓慢聚合还原';
  return '原形停留';
}
