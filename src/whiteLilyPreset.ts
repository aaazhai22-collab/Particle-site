import { createPetalClip, DEFAULT_PETAL_TIMING, PETAL_PARAMS } from './petalPreset';
import type { PetalTiming } from './petalPreset';
import type { ParticleParams } from './ParticleEngine';

export const WHITE_LILY_PRESET_NAME = '白百合 · 自然风蚀';

export const WHITE_LILY_TIMING: PetalTiming = { ...DEFAULT_PETAL_TIMING };

/** A source-independent look: selecting this preset never replaces the asset. */
export const WHITE_LILY_PARAMS: Partial<ParticleParams> = {
  ...PETAL_PARAMS,
  colorMode: 'original', surfaceMode: true, petalFlow: true,
  autoCount: true, count: 500_000, resolution: '1080p', fade: true,
  size: 1.1, opacity: 0.9, glow: 0.22, exposure: 1.1, contrast: 1.05, sparkle: 0.035,
  spread: 1.45, depth: 1.3, turbulence: 0.2, scatter: 0.08,
  curl: 1.2, flowScale: 1.35, stringiness: 1.5, trail: 0.38,
  motionSpeed: 0.45, ambient: 0.015,
};

export const WHITE_LILY_CLIP = createPetalClip(WHITE_LILY_TIMING);
