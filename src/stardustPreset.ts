import { createPetalClip, DEFAULT_PETAL_TIMING, PETAL_PARAMS } from './petalPreset';
import type { ParticleParams } from './ParticleEngine';
import type { PetalTiming } from './petalPreset';

export const STARDUST_PRESET_NAME = '繁花星尘 · 渐蚀';
export const STARDUST_TIMING: PetalTiming = { ...DEFAULT_PETAL_TIMING };

/** Reference-inspired look; applying it never replaces or recolours the asset. */
export const STARDUST_PARAMS: Partial<ParticleParams> = {
  ...PETAL_PARAMS,
  grainStyle: true, surfaceMode: true, petalFlow: true,
  colorMode: 'original', autoCount: true, count: 500_000, resolution: '1080p', fade: true,
  size: 1.25, opacity: 0.96, glow: 0.55, exposure: 1.45, contrast: 1.04, sparkle: 0.34,
  spread: 1.05, depth: 1.2, curl: 1.65, erosion: 0.86, flowScale: 1.65,
  stringiness: 1.8, trail: 0.42, ambient: 0.018, motionSpeed: 0.45,
};

export const STARDUST_CLIP = createPetalClip(STARDUST_TIMING);
