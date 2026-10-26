import { ADAPTIVE_MIN_PARTICLES, DEFAULT_PARTICLE_COUNT, MAX_PARTICLES } from './particleLimits';

export type AdaptiveQualityStatus = 'sampling' | 'stable' | 'increasing' | 'decreasing' | 'ceiling' | 'frozen';

export interface AdaptiveQualityState {
  currentCount: number;
  capacity: number;
  /** The smaller of the source capacity and the user's ceiling. */
  ceiling: number;
  status: AdaptiveQualityStatus;
  frameMsAvg: number;
  fpsAvg: number;
  sampleSeconds: number;
  reason: string;
}

export interface AdaptiveFrameSample {
  /** performance.now(), in milliseconds. */
  now: number;
  frameMs?: number;
  /** Only use when the engine cannot supply an actual frame duration. */
  fps?: number;
  eligible: boolean;
  reason?: string;
}

const WINDOW_MS = 2_000;
const EVALUATION_MS = 1_000;
const TARGET_FPS = 45;
const HARD_MINIMUM_FPS = 30;
const GROW_FPS = TARGET_FPS * 1.08;
const SHRINK_FPS = TARGET_FPS * 0.88;
const countLimit = (value: number) => Number.isFinite(value) ? Math.min(MAX_PARTICLES, Math.max(0, Math.floor(value))) : 0;

/**
 * Uses actual render timings only. No hardware names, display refresh guesses,
 * invisible frames, paused frames, or recorder timings contribute to adaptation.
 */
export class AdaptiveQualityController {
  private capacity = 0;
  private userCeiling = MAX_PARTICLES;
  private explicitFreeze = false;
  private ineligible = false;
  private samples: { now: number; frameMs: number }[] = [];
  private previousNow: number | null = null;
  private evaluationAt: number | null = null;
  private highWindows = 0;
  private criticalStreak = 0;
  private warmupUntil = 0;
  private warmupReason = '图形预热中，暂不判断设备性能';
  private current: AdaptiveQualityState = {
    currentCount: 0, capacity: 0, ceiling: 0, status: 'sampling',
    frameMsAvg: 0, fpsAvg: 0, sampleSeconds: 0, reason: '等待真实渲染样本',
  };

  get state(): AdaptiveQualityState { return { ...this.current }; }

  reset(capacity: number, ceiling: number, initial = DEFAULT_PARTICLE_COUNT): AdaptiveQualityState {
    this.capacity = countLimit(capacity);
    this.userCeiling = countLimit(ceiling);
    const cap = Math.min(this.capacity, this.userCeiling);
    const minimum = Math.min(ADAPTIVE_MIN_PARTICLES, cap);
    const start = Number.isFinite(initial) ? Math.floor(initial) : DEFAULT_PARTICLE_COUNT;
    this.current.currentCount = Math.max(minimum, Math.min(cap, start));
    this.current.capacity = this.capacity;
    this.current.ceiling = cap;
    this.explicitFreeze = false;
    this.ineligible = false;
    this.warmupUntil = 0;
    this.clearSamples();
    this.setWaitingStatus();
    return this.state;
  }

  setCeiling(ceiling: number): AdaptiveQualityState {
    const next = countLimit(ceiling);
    if (next === this.userCeiling) return this.state;
    this.userCeiling = next;
    this.current.ceiling = Math.min(this.capacity, next);
    const minimum = Math.min(ADAPTIVE_MIN_PARTICLES, this.current.ceiling);
    this.current.currentCount = Math.max(minimum, Math.min(this.current.currentCount, this.current.ceiling));
    this.clearSamples();
    this.setWaitingStatus();
    return this.state;
  }

  freeze(reason = '自动数量已冻结，保留当前粒子数'): AdaptiveQualityState {
    if (!this.explicitFreeze) this.clearSamples();
    this.explicitFreeze = true;
    this.current.status = 'frozen';
    this.current.reason = reason;
    return this.state;
  }

  resume(): AdaptiveQualityState {
    if (!this.explicitFreeze) return this.state;
    this.explicitFreeze = false;
    this.ineligible = false;
    this.clearSamples();
    this.setWaitingStatus();
    return this.state;
  }

  resetSamples(): AdaptiveQualityState {
    this.clearSamples();
    this.setWaitingStatus();
    return this.state;
  }

  /** Exclude compilation / page-restoration work, without changing density. */
  warmup(now: number, durationMs = 2_000, reason = '图形预热中，暂不判断设备性能'): AdaptiveQualityState {
    if (!Number.isFinite(now) || !Number.isFinite(durationMs)) return this.state;
    this.warmupUntil = now + Math.max(0, durationMs);
    this.warmupReason = reason;
    this.clearSamples();
    if (!this.explicitFreeze) { this.current.status = 'frozen'; this.current.reason = reason; }
    return this.state;
  }

  /** A frame overlapping the excluded interval is excluded in its entirety. */
  isWarmingUp(now: number, frameMs = 0): boolean {
    return this.warmupUntil > 0 && Number.isFinite(now) &&
      now - Math.max(0, Number.isFinite(frameMs) ? frameMs : 0) < this.warmupUntil;
  }

  observe(sample: AdaptiveFrameSample): AdaptiveQualityState {
    if (this.explicitFreeze) return this.state;
    if (!sample.eligible) {
      if (!this.ineligible) this.clearSamples();
      this.ineligible = true;
      this.current.status = 'frozen';
      this.current.reason = sample.reason ?? '页面隐藏、动画暂停或录制期间不参与自动采样';
      return this.state;
    }
    if (this.ineligible) {
      this.ineligible = false;
      this.clearSamples();
      this.setWaitingStatus();
    }
    const frameMs = sample.frameMs !== undefined ? sample.frameMs
      : sample.fps !== undefined && sample.fps > 0 ? 1_000 / sample.fps : 0;
    if (!Number.isFinite(sample.now) || !Number.isFinite(frameMs) || frameMs <= 0) return this.state;
    if (this.isWarmingUp(sample.now, frameMs)) {
      this.current.status = 'frozen';
      this.current.reason = this.warmupReason;
      return this.state;
    }
    if (this.warmupUntil) {
      this.warmupUntil = 0;
      this.clearSamples();
      this.setWaitingStatus();
    }
    // Equal timestamps cannot be two real frames. A backwards clock starts a new window.
    if (this.previousNow !== null && sample.now === this.previousNow) return this.state;
    if (this.previousNow !== null && sample.now < this.previousNow) this.clearSamples();
    this.previousNow = sample.now;
    this.samples.push({ now: sample.now, frameMs });
    const cutoff = sample.now - WINDOW_MS;
    while (this.samples.length > 1 && this.samples[0].now < cutoff) this.samples.shift();
    const sum = this.samples.reduce((total, value) => total + value.frameMs, 0);
    this.current.frameMsAvg = sum / this.samples.length;
    this.current.fpsAvg = 1_000 / this.current.frameMsAvg;
    this.current.sampleSeconds = Math.min(WINDOW_MS, sample.now - this.samples[0].now + this.samples[0].frameMs) / 1_000;
    this.criticalStreak = frameMs > 1_000 / HARD_MINIMUM_FPS ? this.criticalStreak + 1 : 0;
    if (this.current.ceiling === 0) { this.setWaitingStatus(); return this.state; }
    const enoughHistory = this.current.sampleSeconds >= 2 - 1e-6 && (this.samples.length >= 2 || this.criticalStreak >= 2);
    if (!enoughHistory || (this.evaluationAt !== null && sample.now - this.evaluationAt < EVALUATION_MS)) return this.state;
    this.evaluationAt = sample.now;

    const slowSamples = this.samples.filter((value) => value.frameMs > 1_000 / SHRINK_FPS);
    const slowFraction = slowSamples.length / this.samples.length;
    const slowTimeFraction = slowSamples.reduce((total, value) => total + value.frameMs, 0) / sum;
    const fastFraction = this.samples.filter((value) => value.frameMs <= 1_000 / GROW_FPS).length / this.samples.length;
    const minimum = Math.min(ADAPTIVE_MIN_PARTICLES, this.current.ceiling);
    // A single long frame can dominate the mean but is not sustained load.
    // Repeated intermittent stalls still matter: measure their share of real
    // time as well as frame count, so 50% slow frames cannot evade a downshift.
    const sustainedSlow = (slowSamples.length >= 3 || this.criticalStreak >= 2) && (slowFraction >= 0.35 || slowTimeFraction >= 0.55);
    if (this.current.fpsAvg < SHRINK_FPS && sustainedSlow) {
      this.highWindows = 0;
      const factor = this.current.fpsAvg < HARD_MINIMUM_FPS ? 0.6 : 0.8;
      const next = Math.max(minimum, Math.floor(this.current.currentCount * factor / 1_000) * 1_000);
      if (next < this.current.currentCount) {
        this.current.currentCount = next;
        this.current.status = 'decreasing';
        this.current.reason = `持续渲染低于 ${Math.round(SHRINK_FPS)} FPS，降低数量以恢复流畅度`;
        this.clearSamples(true);
      } else {
        this.current.status = this.current.currentCount === this.current.ceiling ? 'ceiling' : 'stable';
        this.current.reason = '已到当前可用最低数量；继续保留真实性能反馈';
      }
    } else if (this.current.fpsAvg >= GROW_FPS && fastFraction >= 0.85) {
      this.highWindows++;
      if (this.current.currentCount >= this.current.ceiling) {
        this.current.status = 'ceiling';
        this.current.reason = this.capacity <= this.userCeiling ? '已达到素材有效采样容量' : '已达到用户设置的数量上限';
      } else if (this.highWindows >= 2) {
        this.current.currentCount = Math.min(this.current.ceiling,
          Math.max(this.current.currentCount + 1_000, Math.ceil(this.current.currentCount * 1.35 / 1_000) * 1_000));
        this.current.status = 'increasing';
        this.current.reason = '连续高帧率，逐级提高粒子密度';
        this.clearSamples(true);
      } else {
        this.current.status = 'stable';
        this.current.reason = '帧率有余量，等待第二个稳定窗口确认';
      }
    } else {
      this.highWindows = 0;
      this.current.status = 'stable';
      this.current.reason = `在 ${TARGET_FPS} FPS 目标附近保持当前数量；偶发卡顿不立即降级`;
    }
    return this.state;
  }

  private clearSamples(preserveAverage = false): void {
    this.samples = [];
    this.previousNow = null;
    this.evaluationAt = null;
    this.highWindows = 0;
    this.criticalStreak = 0;
    this.current.sampleSeconds = 0;
    if (!preserveAverage) { this.current.frameMsAvg = 0; this.current.fpsAvg = 0; }
  }

  private setWaitingStatus(): void {
    this.current.status = this.explicitFreeze || this.ineligible ? 'frozen' : this.current.ceiling === 0 ? 'ceiling' : 'sampling';
    this.current.reason = this.current.ceiling === 0 ? '素材没有可用采样或数量上限为零' : '等待至少 2 秒真实渲染样本';
  }
}
