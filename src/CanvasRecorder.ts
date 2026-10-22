export interface RecordingResult {
  url: string;
  blob: Blob;
  duration: number;
  width: number;
  height: number;
  mimeType: string;
  extension: string;
  filename: string;
}

export type RecordingStatus = 'idle' | 'recording' | 'paused' | 'processing' | 'ready' | 'error';

export interface RecorderState {
  status: RecordingStatus;
  elapsed: number;
  bytes: number;
  result: RecordingResult | null;
  error: string | null;
}

const WIDTH = 1280;
const HEIGHT = 720;
const TARGET_FPS = 30;
const MAX_DURATION_MS = 120_000;
const MAX_BYTES = 200 * 1024 * 1024;
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

function availableMimeTypes(): string[] {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return [];
  return MIME_CANDIDATES.filter((type) => {
    try {
      return MediaRecorder.isTypeSupported(type);
    } catch {
      return false;
    }
  });
}

function safeProjectName(name: string): string {
  const cleaned = (typeof name === 'string' ? name : '').normalize('NFKC').trim()
    .replace(/\.(png|jpe?g|glb)$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
  return Array.from(cleaned).slice(0, 64).join('') || 'Sphere';
}

function recordingFilename(date: Date, extension: string, projectName: string): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (name: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === name)?.value ?? '';
  return `Particle_${projectName}_${value('year')}${value('month')}${value('day')}_${value('hour')}${value('minute')}${value('second')}.${extension}`;
}

function readableError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'SecurityError') return '画布无法录制：请使用本地素材，避免跨域图片污染画布。';
  if (name === 'NotSupportedError') return '当前浏览器无法使用此编码格式录制，请尝试最新版 Chrome 或 Edge。';
  if (name === 'InvalidStateError') return '录制状态发生变化，请停止后重新录制。';
  return '视频录制失败，可能是浏览器编码器或可用内存不足。请降低画质后重试。';
}

/**
 * 录制提供的最终渲染画布。画布在录制期间须保持 1280 × 720；
 * CSS 显示尺寸和浏览器窗口尺寸可以变化。
 */
export class CanvasRecorder {
  private currentState: RecorderState = {
    status: 'idle',
    elapsed: 0,
    bytes: 0,
    result: null,
    error: null,
  };

  private selectedMimeType = availableMimeTypes()[0] ?? '';
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private heartbeat: number | null = null;
  private deadline: number | null = null;
  private accumulatedMs = 0;
  private activeStartedAt: number | null = null;
  private recordingDate = new Date();
  private projectName = 'Sphere';
  private recordingProjectName = 'Sphere';
  private outputWidth = WIDTH;
  private outputHeight = HEIGHT;
  private runId = 0;
  private destroyed = false;
  private pauseHookActive = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onUpdate: (state: RecorderState) => void,
    private readonly onPause?: (paused: boolean) => void,
  ) {}

  get state(): RecorderState {
    return {
      ...this.currentState,
      result: this.currentState.result ? { ...this.currentState.result } : null,
    };
  }

  get supported(): boolean {
    return !this.destroyed && typeof this.canvas.captureStream === 'function' && availableMimeTypes().length > 0;
  }

  get mimeType(): string {
    return this.selectedMimeType;
  }

  /** 设置下一次录制的素材名；开始后名称保持稳定，不影响已有结果。 */
  setProjectName(name: string): void {
    if (this.destroyed) return;
    this.projectName = safeProjectName(name);
  }

  start(quality: 'standard' | 'high' = 'high'): void {
    if (this.destroyed) return;
    if (['recording', 'paused', 'processing'].includes(this.currentState.status)) {
      return;
    }
    this.clear();
    if (!this.supported) {
      this.patch({ status: 'error', error: '当前浏览器不支持画布视频录制，请使用最新版 Chrome 或 Edge。' });
      return;
    }
    if (this.canvas.width !== WIDTH || this.canvas.height !== HEIGHT) {
      this.patch({ status: 'error', error: '录制需要 1280 × 720 的画布输出，请先恢复 720p 画面后重试。' });
      return;
    }

    const runId = ++this.runId;
    try {
      this.stream = this.canvas.captureStream(TARGET_FPS);
      if (this.stream.getVideoTracks().length === 0) throw new DOMException('No video track', 'NotSupportedError');
      // 某些浏览器虽然通过能力检测，构造指定编码器时仍可能失败。
      for (const mimeType of availableMimeTypes()) {
        try {
          this.recorder = new MediaRecorder(this.stream, {
            mimeType,
            videoBitsPerSecond: quality === 'high' ? 12_000_000 : 6_000_000,
          });
          this.selectedMimeType = this.recorder.mimeType || mimeType;
          break;
        } catch {
          this.recorder = null;
        }
      }
      if (!this.recorder) throw new DOMException('No encoder', 'NotSupportedError');

      this.outputWidth = this.canvas.width;
      this.outputHeight = this.canvas.height;
      this.recordingDate = new Date();
      this.recordingProjectName = this.projectName;
      this.recorder.ondataavailable = (event: BlobEvent) => {
        if (this.destroyed || runId !== this.runId || event.data.size === 0) return;
        this.chunks.push(event.data);
        this.currentState.bytes += event.data.size;
        this.emit();
        // 保留完整编码块。容量最多可能超出一个 timeslice，避免截断视频。
        if (this.currentState.bytes >= MAX_BYTES) this.stop();
      };
      this.recorder.onstop = () => {
        if (this.destroyed || runId !== this.runId) return;
        this.finalize();
      };
      this.recorder.onerror = (event: Event) => {
        if (this.destroyed || runId !== this.runId) return;
        const error = (event as Event & { error?: DOMException }).error;
        this.freezeClock();
        this.clearTimers();
        this.releasePauseHook();
        this.patch({ status: 'processing', error: readableError(error) });
        // 编码错误后浏览器仍会按 dataavailable → stop 的顺序返回剩余数据。
        if (this.recorder && this.recorder.state !== 'inactive') {
          try { this.recorder.stop(); } catch { /* 等待浏览器的 stop 事件。 */ }
        }
      };

      this.recorder.start(1000);
      this.activeStartedAt = performance.now();
      this.patch({ status: 'recording', elapsed: 0, bytes: 0, error: null });
      this.armTimers();
    } catch (error) {
      this.disposeCapture();
      this.chunks = [];
      this.patch({ status: 'error', error: readableError(error) });
    }
  }

  pause(): void {
    if (this.destroyed || this.currentState.status !== 'recording' || !this.recorder) return;
    try {
      this.recorder.pause();
      this.freezeClock();
      this.clearTimers();
      this.patch({ status: 'paused', error: null });
      this.pauseHookActive = true;
      this.notifyPause(true);
    } catch (error) {
      this.patch({ error: readableError(error) });
    }
  }

  resume(): void {
    if (this.destroyed || this.currentState.status !== 'paused' || !this.recorder) return;
    try {
      this.recorder.resume();
      this.activeStartedAt = performance.now();
      this.patch({ status: 'recording', error: null });
      this.releasePauseHook();
      this.armTimers();
    } catch (error) {
      this.patch({ error: readableError(error) });
    }
  }

  stop(): void {
    if (this.destroyed || !['recording', 'paused'].includes(this.currentState.status) || !this.recorder) return;
    this.freezeClock();
    this.clearTimers();
    this.releasePauseHook();
    this.patch({ status: 'processing' });
    // stop() 自身不生成文件：最终编码块只会在之后的 dataavailable 中到达。
    if (this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop();
      } catch (error) {
        this.patch({ error: readableError(error) });
      }
    }
  }

  download(): void {
    if (this.destroyed) return;
    const result = this.currentState.result;
    if (!result) {
      this.patch({ error: '视频尚未生成，请先停止录制并等待生成完成。' });
      return;
    }
    try {
      if (!result.url) result.url = URL.createObjectURL(result.blob);
      const anchor = document.createElement('a');
      anchor.href = result.url;
      anchor.download = result.filename;
      document.body.appendChild(anchor);
      try { anchor.click(); } finally { anchor.remove(); }
      this.patch({ status: 'ready', error: null });
    } catch {
      this.patch({ error: '视频下载失败。已保留录制数据，请关闭其他页面后重试。' });
    }
  }

  /** 清除结果；正在录制时调用会取消本次录制并释放资源。 */
  clear(): void {
    if (this.destroyed) return;
    ++this.runId;
    this.clearTimers();
    this.releasePauseHook();
    this.disposeCapture();
    this.revokeResult();
    this.chunks = [];
    this.accumulatedMs = 0;
    this.activeStartedAt = null;
    this.currentState = { status: 'idle', elapsed: 0, bytes: 0, result: null, error: null };
    this.emit();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.clear();
    this.destroyed = true;
  }

  private elapsedMs(): number {
    return this.accumulatedMs + (this.activeStartedAt === null ? 0 : performance.now() - this.activeStartedAt);
  }

  private freezeClock(): void {
    this.accumulatedMs = this.elapsedMs();
    this.activeStartedAt = null;
    this.currentState.elapsed = this.accumulatedMs / 1000;
  }

  private armTimers(): void {
    this.clearTimers();
    this.heartbeat = window.setInterval(() => {
      if (this.currentState.status !== 'recording') return;
      this.patch({ elapsed: this.elapsedMs() / 1000 });
      if (this.elapsedMs() >= MAX_DURATION_MS) this.stop();
    }, 200);
    this.deadline = window.setTimeout(() => this.stop(), Math.max(0, MAX_DURATION_MS - this.elapsedMs()));
  }

  private clearTimers(): void {
    if (this.heartbeat !== null) window.clearInterval(this.heartbeat);
    if (this.deadline !== null) window.clearTimeout(this.deadline);
    this.heartbeat = null;
    this.deadline = null;
  }

  private finalize(): void {
    this.freezeClock();
    this.clearTimers();
    this.releasePauseHook();
    const actualMime = this.recorder?.mimeType || this.chunks.find((chunk) => chunk.type)?.type || this.selectedMimeType;
    this.selectedMimeType = actualMime;
    this.disposeCapture();

    if (this.chunks.length === 0) {
      this.patch({ status: 'error', error: this.currentState.error || '没有收到有效录像数据，请让画面录制片刻后再停止。' });
      return;
    }
    try {
      const blob = new Blob(this.chunks, { type: actualMime });
      this.chunks = [];
      const extension = actualMime.split(';')[0].trim().toLowerCase() === 'video/mp4' ? 'mp4' : 'webm';
      const result: RecordingResult = {
        url: '',
        blob,
        duration: this.currentState.elapsed,
        width: this.outputWidth,
        height: this.outputHeight,
        mimeType: actualMime,
        extension,
        filename: recordingFilename(this.recordingDate, extension, this.recordingProjectName),
      };
      this.currentState.result = result;
      this.currentState.bytes = blob.size;
      result.url = URL.createObjectURL(blob);
      this.patch({
        status: 'ready',
        error: this.currentState.error ? `${this.currentState.error} 已保留收到的视频片段，可尝试预览和下载。` : null,
      });
    } catch {
      this.patch({ status: 'error', error: '视频生成失败，已尽可能保留录制数据，请降低画质后重试。' });
    }
  }

  private disposeCapture(): void {
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      this.recorder.onerror = null;
      if (this.recorder.state !== 'inactive') {
        try { this.recorder.stop(); } catch { /* 释放媒体轨道即可结束无效录制。 */ }
      }
      this.recorder = null;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  private revokeResult(): void {
    const url = this.currentState.result?.url;
    if (url) URL.revokeObjectURL(url);
  }

  private notifyPause(paused: boolean): void {
    try { this.onPause?.(paused); } catch (error) { console.error('录制暂停回调失败', error); }
  }

  private releasePauseHook(): void {
    if (!this.pauseHookActive) return;
    this.pauseHookActive = false;
    this.notifyPause(false);
  }

  private patch(patch: Partial<RecorderState>): void {
    Object.assign(this.currentState, patch);
    this.emit();
  }

  private emit(): void {
    if (this.destroyed) return;
    try { this.onUpdate(this.state); } catch (error) { console.error('录制状态回调失败', error); }
  }
}
