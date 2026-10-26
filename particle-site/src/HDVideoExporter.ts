import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type { RecordingResult } from './CanvasRecorder';

export interface OfflineExportSession {
  canvas: HTMLCanvasElement;
  duration: number;
  renderFrame(timeSeconds: number): void | Promise<void>;
  restore(): void | Promise<void>;
}

export interface HDVideoExportOptions {
  width: number;
  height: number;
  fps: 30 | 60;
  quality: 'standard' | 'high';
  projectName: string;
  signal?: AbortSignal;
}

// The in-memory muxer needs room for its samples and final MP4 buffer.
const MAX_ENCODED_BYTES = 256 * 1024 * 1024;

/** Capability detection is followed by a resolution/codec check before encoding. */
export function isHDVideoExportSupported(): boolean {
  return typeof VideoEncoder !== 'undefined'
    && typeof VideoEncoder.isConfigSupported === 'function'
    && typeof VideoFrame !== 'undefined';
}

export function getExportBitrate(width: number, height: number, fps: number, quality: 'standard' | 'high'): number {
  const scale = (width * height * fps) / (1920 * 1080 * 60);
  return Math.round(Math.max(8_000_000, (quality === 'high' ? 32_000_000 : 20_000_000) * scale));
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('已取消视频导出。', 'AbortError');
}

function validateSession(session: OfflineExportSession, options: HDVideoExportOptions): void {
  if (!Number.isInteger(options.width) || !Number.isInteger(options.height)
    || options.width < 2 || options.height < 2 || options.width > 4096 || options.height > 4096
    || options.width % 2 !== 0 || options.height % 2 !== 0 || ![30, 60].includes(options.fps)) {
    throw new Error('请选择有效的偶数分辨率与 30 / 60 FPS。');
  }
  if (!Number.isFinite(session.duration) || session.duration <= 0 || session.duration > 120) {
    throw new Error('视频时间轴时长须在 0 到 120 秒之间。');
  }
  if (session.canvas.width !== options.width || session.canvas.height !== options.height) {
    throw new Error(`画布尚未切换到 ${options.width} × ${options.height}，请重新开始导出。`);
  }
}

async function supportedConfig(options: HDVideoExportOptions): Promise<VideoEncoderConfig> {
  // H.264 Level 4.2 covers 1080p60; Level 5.1 covers 4K30.
  const level = options.width * options.height > 1920 * 1080 ? '33' : '2A';
  for (const acceleration of ['prefer-hardware', 'no-preference'] as const) {
    for (const profile of ['64', '4D', '42']) {
      checkCancelled(options.signal);
      const config: VideoEncoderConfig = {
        codec: `avc1.${profile}00${level}`,
        width: options.width,
        height: options.height,
        framerate: options.fps,
        bitrate: getExportBitrate(options.width, options.height, options.fps, options.quality),
        bitrateMode: 'variable',
        latencyMode: 'quality',
        hardwareAcceleration: acceleration,
        avc: { format: 'avc' },
      };
      try {
        const support = await VideoEncoder.isConfigSupported(config);
        if (support.supported) return config;
      } catch { /* Try a different supported H.264 profile. */ }
    }
  }
  throw new Error(`当前设备无法编码 ${options.width} × ${options.height} / ${options.fps} FPS 的 H.264 视频，请选择 1080p / 30 FPS 或使用最新版 Chrome、Edge。`);
}

function filename(options: HDVideoExportOptions): string {
  const name = options.projectName.normalize('NFKC').trim().replace(/\.(png|jpe?g|glb)$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, '_').replace(/^[._]+|[._]+$/g, '');
  const date = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date()).replace(/[-:]/g, '').replace(' ', '_');
  return `Particle_${Array.from(name).slice(0, 64).join('') || 'Sphere'}_${options.width}x${options.height}_${options.fps}fps_${date}.mp4`;
}

function friendlyError(error: unknown): Error {
  if (error instanceof DOMException) {
    if (error.name === 'AbortError') return error;
    if (error.name === 'SecurityError') return new Error('素材导致画布跨域限制，请使用本地素材重新导出。');
    if (['EncodingError', 'NotSupportedError', 'QuotaExceededError'].includes(error.name)) {
      return new Error('设备编码器无法完成此高清导出，请尝试 1080p / 30 FPS，或关闭其他占用显存的页面后重试。');
    }
  }
  return error instanceof Error ? error : new Error('高清视频导出失败，请重试。');
}

/**
 * Render and encode every timeline frame, independent of preview frame rate.
 * Never use captureStream / MediaRecorder here: slow devices may take longer,
 * but exported frames keep their exact presentation timestamps without drops.
 * The caller owns the returned object URL and must revoke it when discarded.
 */
export async function exportTimelineVideo(
  session: OfflineExportSession,
  options: HDVideoExportOptions,
  onProgress?: (fraction: number) => void,
): Promise<RecordingResult> {
  let encoder: VideoEncoder | null = null;
  let encoderError: Error | null = null;
  let encodedBytes = 0;
  let abortHandler: (() => void) | undefined;
  let resultUrl = '';
  let completed = false;
  try {
    checkCancelled(options.signal);
    validateSession(session, options);
    if (!isHDVideoExportSupported()) {
      throw new Error('当前浏览器不支持逐帧高清视频导出，请使用最新版 Chrome 或 Edge。');
    }
    const config = await supportedConfig(options);
    checkCancelled(options.signal);
    const frameCount = Math.ceil(session.duration * options.fps);
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: 'avc', width: options.width, height: options.height, frameRate: options.fps },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'strict',
    });
    encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        if (encoderError || options.signal?.aborted) return;
        encodedBytes += chunk.byteLength;
        if (encodedBytes > MAX_ENCODED_BYTES) {
          encoderError = new Error('视频数据超过 256 MB，请缩短时间轴、选择 1080p 或使用标准画质后重新导出。');
          return;
        }
        try { muxer.addVideoChunk(chunk, metadata); }
        catch (error) { encoderError = friendlyError(error); }
      },
      error: (error) => { encoderError = friendlyError(error); },
    });
    abortHandler = () => {
      // Closing the encoder also rejects a pending flush promptly.
      if (encoder && encoder.state !== 'closed') encoder.close();
    };
    options.signal?.addEventListener('abort', abortHandler, { once: true });
    encoder.configure(config);
    onProgress?.(0);
    for (let index = 0; index < frameCount; index++) {
      checkCancelled(options.signal);
      if (encoderError) throw encoderError;
      await session.renderFrame(index / options.fps);
      checkCancelled(options.signal);
      const timestamp = Math.round(index * 1_000_000 / options.fps);
      const nextTimestamp = Math.round((index + 1) * 1_000_000 / options.fps);
      const frame = new VideoFrame(session.canvas, { timestamp, duration: nextTimestamp - timestamp });
      try { encoder.encode(frame, { keyFrame: index % (options.fps * 2) === 0 }); }
      finally { frame.close(); }
      // Bound GPU/codec work instead of queuing an entire 4K timeline in memory.
      // flush() also yields the main thread, so progress/cancel remain responsive.
      if (encoder.encodeQueueSize >= 4 || (index + 1) % 8 === 0) {
        await encoder.flush();
        if (encoderError) throw encoderError;
        onProgress?.(((index + 1) / frameCount) * 0.98);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    await encoder.flush();
    checkCancelled(options.signal);
    if (encoderError) throw encoderError;
    muxer.finalize();
    const blob = new Blob([target.buffer], { type: 'video/mp4' });
    if (!blob.size) throw new Error('编码器没有生成视频数据，请重试。');
    resultUrl = URL.createObjectURL(blob);
    const result: RecordingResult = {
      url: resultUrl,
      blob,
      duration: frameCount / options.fps,
      width: options.width,
      height: options.height,
      fps: options.fps,
      captureMode: 'manual',
      requestedFrames: frameCount,
      mimeType: 'video/mp4',
      extension: 'mp4',
      filename: filename(options),
    };
    onProgress?.(1);
    completed = true;
    return result;
  } catch (error) {
    checkCancelled(options.signal);
    throw friendlyError(error);
  } finally {
    if (abortHandler) options.signal?.removeEventListener('abort', abortHandler);
    try {
      if (encoder && encoder.state !== 'closed') encoder.close();
    } finally {
      if (!completed && resultUrl) URL.revokeObjectURL(resultUrl);
      try { await session.restore(); }
      catch (error) {
        if (completed && resultUrl) URL.revokeObjectURL(resultUrl);
        throw friendlyError(error);
      }
    }
  }
}
