/** Small deterministic calculations shared by the renderer and its CPU tests. */
export function layerBudgets(count: number, enabled: boolean, ambient: number, trail: number) {
  const sourceCount = Math.max(0, Math.floor(count));
  return {
    ambient: enabled ? Math.min(16_000, Math.floor(sourceCount * Math.max(0, Math.min(0.08, ambient)))) : 0,
    filaments: enabled && trail > 0 ? Math.min(1_000, Math.floor(sourceCount * 0.03)) : 0,
  };
}

/** Timeline phases are addressable, including a closed ambient phase at the seam. */
export function ambientPhase(seconds: number, speed: number, duration: number, timeline: boolean): number {
  if (!(speed > 0)) return 0;
  if (!timeline || !(duration > 0)) return seconds * speed * 0.65;
  const turns = Math.max(1, Math.round(duration * speed / 8));
  return (Math.max(0, Math.min(duration, seconds)) / duration % 1) * Math.PI * 2 * turns;
}

export function motionTime(seconds: number, speed: number): number {
  return Math.max(0, Number.isFinite(seconds) ? seconds : 0) * Math.max(0, Number.isFinite(speed) ? speed : 0);
}
