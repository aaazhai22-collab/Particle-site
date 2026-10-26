export type PlaybackMode = 'idle' | 'disperse' | 'assemble' | 'loop';

export interface PlaybackState {
  progress: number;
  running: boolean;
  mode: PlaybackMode;
  direction: 1 | -1;
  time: number;
}

export interface PlaybackTiming {
  duration: number;
  playbackRate: number;
  motionSpeed: number;
}

/** Continue a paused task, or choose a useful task at an idle/completed endpoint. */
export function resumePlayback<T extends PlaybackState>(state: T): T {
  const next = { ...state, running: true };
  if (state.mode === 'idle') {
    next.direction = state.progress <= 0 ? 1 : state.progress >= 1 ? -1 : state.direction;
    next.mode = next.direction === 1 ? 'disperse' : 'assemble';
  } else if (state.mode === 'assemble' && state.progress <= 0) {
    next.mode = 'disperse';
    next.direction = 1;
  } else if (state.mode === 'disperse' && state.progress >= 1) {
    next.mode = 'assemble';
    next.direction = -1;
  } else if (state.mode === 'loop') {
    if (state.progress <= 0) next.direction = 1;
    if (state.progress >= 1) next.direction = -1;
  }
  return next;
}

/** Integrate elapsed seconds; no frame-count assumptions or accumulated positions. */
export function advancePlayback<T extends PlaybackState>(
  state: T,
  deltaSeconds: number,
  timing: PlaybackTiming,
): T {
  const next = { ...state };
  if (!state.running || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return next;
  if (!Number.isFinite(timing.duration) || timing.duration <= 0 ||
      !Number.isFinite(timing.playbackRate) || timing.playbackRate < 0) return next;
  const motionSpeed = Number.isFinite(timing.motionSpeed) ? Math.max(0, timing.motionSpeed) : 0;
  next.time += deltaSeconds * motionSpeed;
  const step = deltaSeconds * timing.playbackRate / timing.duration;
  if (state.mode === 'loop') {
    // Reflect a continuous phase. Modulo handles even long background-tab intervals.
    const phase = state.direction === 1 ? state.progress : 2 - state.progress;
    const folded = (phase + step) % 2;
    next.progress = folded <= 1 ? folded : 2 - folded;
    next.direction = folded < 1 ? 1 : -1;
  } else if (state.mode === 'disperse' || state.mode === 'assemble') {
    next.progress = Math.min(1, Math.max(0, state.progress + step * state.direction));
    if ((state.direction === 1 && next.progress === 1) ||
        (state.direction === -1 && next.progress === 0)) next.running = false;
  }
  return next;
}

export function advanceTimelineTime(
  time: number,
  deltaSeconds: number,
  duration: number,
  playbackRate: number,
  loop: boolean,
): { time: number; completed: boolean } {
  if (!(duration > 0) || !Number.isFinite(duration)) return { time: 0, completed: true };
  const current = Math.min(duration, Math.max(0, Number.isFinite(time) ? time : 0));
  const delta = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
  const rate = Number.isFinite(playbackRate) ? Math.max(0, playbackRate) : 0;
  const step = delta * rate;
  // 定位到终点但尚无实际时间经过时，保留精确终点供检查、截图和打帧。
  if (!(step > 0) || !Number.isFinite(step)) return { time: current, completed: !loop && current >= duration };
  const next = current + step;
  if (loop) return { time: ((next % duration) + duration) % duration, completed: false };
  return { time: Math.min(duration, Math.max(0, next)), completed: next >= duration };
}
