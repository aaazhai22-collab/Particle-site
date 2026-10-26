import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import ts from 'typescript';

// Exercise the real MP4 muxer, replacing only browser codec/frame APIs.
const source = await readFile(new URL('../src/HDVideoExporter.ts', import.meta.url), 'utf8');
const muxerUrl = new URL('../node_modules/mp4-muxer/build/mp4-muxer.mjs', import.meta.url).href;
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace("from 'mp4-muxer'", `from '${muxerUrl}'`);
const { exportTimelineVideo, isHDVideoExportSupported, getExportBitrate } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

function createEnvironment() {
  const replacements = [];
  const replace = (target, name, value) => {
    replacements.push([target, name, Object.getOwnPropertyDescriptor(target, name)]);
    Object.defineProperty(target, name, { configurable: true, writable: true, value });
  };
  const env = {
    frames: [], encoders: [], renderTimes: [], configs: [], urls: new Set(),
    supported: true, renderFailure: false, encodeFailure: false, flushFailure: false,
    restored: 0, flushCount: 0, maxQueue: 0, afterRender: null, afterFlush: null,
    chunkSize: 6,
    restore() {
      for (const [target, name, descriptor] of replacements.reverse()) {
        if (descriptor) Object.defineProperty(target, name, descriptor);
        else delete target[name];
      }
    },
  };
  class MockVideoFrame {
    constructor(canvas, init) {
      this.timestamp = init.timestamp;
      this.duration = init.duration;
      this.closed = false;
      assert.equal(canvas.width, env.session.canvas.width);
      env.frames.push(this);
    }
    close() { this.closed = true; }
  }
  class MockEncodedVideoChunk {
    constructor(frame, keyFrame) {
      this.timestamp = frame.timestamp;
      this.duration = frame.duration;
      this.type = keyFrame ? 'key' : 'delta';
      this.byteLength = env.chunkSize;
    }
    copyTo(destination) { destination.set([0, 0, 0, 2, 0x65, 0x88]); }
  }
  class MockVideoEncoder {
    static async isConfigSupported(config) {
      env.configs.push(config);
      return { supported: env.supported, config };
    }
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.state = 'unconfigured';
      this.encodeQueueSize = 0;
      this.pending = [];
      this.keyframes = [];
      env.encoders.push(this);
    }
    configure(config) { this.config = config; this.state = 'configured'; }
    encode(frame, options) {
      if (env.encodeFailure) throw new DOMException('Encoding failed', 'EncodingError');
      this.pending.push(new MockEncodedVideoChunk(frame, options.keyFrame));
      this.keyframes.push(options.keyFrame);
      env.maxQueue = Math.max(env.maxQueue, ++this.encodeQueueSize);
    }
    async flush() {
      env.flushCount++;
      if (env.flushFailure) throw new DOMException('Encoder unavailable', 'EncodingError');
      for (const chunk of this.pending.splice(0)) {
        this.callbacks.output(chunk, {
          decoderConfig: {
            codec: this.config.codec,
            codedWidth: this.config.width,
            codedHeight: this.config.height,
            description: new Uint8Array([1, 100, 0, 42, 255, 225, 0, 2, 103, 100, 1, 0, 2, 104, 0]),
          },
        });
      }
      this.encodeQueueSize = 0;
      env.afterFlush?.();
    }
    close() { this.state = 'closed'; }
  }
  replace(globalThis, 'VideoFrame', MockVideoFrame);
  replace(globalThis, 'VideoEncoder', MockVideoEncoder);
  replace(globalThis, 'EncodedVideoChunk', MockEncodedVideoChunk);
  replace(URL, 'createObjectURL', () => {
    const url = `blob:hd-export-${env.urls.size}`;
    env.urls.add(url);
    return url;
  });
  replace(URL, 'revokeObjectURL', url => env.urls.delete(url));
  env.session = {
    canvas: { width: 1920, height: 1080 },
    duration: 2.1,
    async renderFrame(time) {
      env.renderTimes.push(time);
      if (env.renderFailure) throw new Error('Render failed');
      env.afterRender?.();
    },
    restore() { env.restored++; },
  };
  env.options = { width: 1920, height: 1080, fps: 60, quality: 'high', projectName: '青铜:方鼎.glb' };
  return env;
}

function exportTest(name, run) {
  test(name, async () => {
    const env = createEnvironment();
    try { await run(env); } finally { env.restore(); }
  });
}

function boxes(buffer, start = 0, end = buffer.length) {
  const result = [];
  for (let position = start; position + 8 <= end;) {
    const size = buffer.readUInt32BE(position);
    assert.ok(size >= 8 && position + size <= end, 'MP4 box is bounded');
    const box = { type: buffer.toString('ascii', position + 4, position + 8), start: position, data: position + 8, end: position + size };
    result.push(box);
    if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(box.type)) result.push(...boxes(buffer, box.data, box.end));
    position += size;
  }
  return result;
}

describe('逐帧高清视频导出', { concurrency: false }, () => {
  exportTest('1080p60 精确渲染全部帧，真实 MP4 包含正确时长、帧数和恒定帧率', async env => {
    const progress = [];
    assert.equal(isHDVideoExportSupported(), true);
    const result = await exportTimelineVideo(env.session, env.options, value => progress.push(value));
    assert.equal(env.frames.length, 126);
    assert.equal(env.renderTimes.length, 126);
    for (let index = 0; index < 126; index++) {
      assert.equal(env.renderTimes[index], index / 60);
      assert.equal(env.frames[index].timestamp, Math.round(index * 1e6 / 60));
      assert.equal(env.frames[index].duration, Math.round((index + 1) * 1e6 / 60) - Math.round(index * 1e6 / 60));
    }
    assert.ok(env.frames.every(frame => frame.closed));
    assert.ok(env.maxQueue <= 4);
    assert.equal(env.encoders[0].state, 'closed');
    assert.equal(env.encoders[0].config.bitrate, 32_000_000);
    assert.deepEqual(env.encoders[0].keyframes.flatMap((key, index) => key ? [index] : []), [0, 120]);
    assert.equal(env.restored, 1);
    assert.equal(result.mimeType, 'video/mp4');
    assert.equal(result.fps, 60);
    assert.equal(result.duration, 2.1);
    assert.match(result.filename, /^Particle_青铜_方鼎_1920x1080_60fps_\d{8}_\d{6}\.mp4$/);
    assert.equal(progress[0], 0);
    assert.equal(progress.at(-1), 1);
    assert.ok(progress.every((value, index) => !index || value >= progress[index - 1]));
    const buffer = Buffer.from(await result.blob.arrayBuffer());
    const atoms = boxes(buffer);
    assert.equal(atoms[0].type, 'ftyp');
    assert.ok(atoms.find(box => box.type === 'moov').start < atoms.find(box => box.type === 'mdat').start, 'Fast Start MP4');
    const sampleSize = atoms.find(box => box.type === 'stsz');
    assert.equal(buffer.readUInt32BE(sampleSize.data + 8), 126);
    const mediaHeader = atoms.find(box => box.type === 'mdhd');
    const timeScale = buffer.readUInt32BE(mediaHeader.data + 12);
    const duration = buffer.readUInt32BE(mediaHeader.data + 16);
    assert.ok(Math.abs(duration / timeScale - 2.1) < 1 / timeScale);
    const timing = atoms.find(box => box.type === 'stts');
    assert.equal(buffer.readUInt32BE(timing.data + 4), 1, 'one constant-frame-rate run');
    assert.equal(buffer.readUInt32BE(timing.data + 8), 126);
    assert.equal(buffer.readUInt32BE(timing.data + 12), timeScale / 60);
  });

  exportTest('4K30 使用相应编码级别和高码率，非整数帧时长向上补齐一帧', async env => {
    Object.assign(env.session.canvas, { width: 3840, height: 2160 });
    Object.assign(env.options, { width: 3840, height: 2160, fps: 30 });
    env.session.duration = 0.05;
    const result = await exportTimelineVideo(env.session, env.options);
    assert.equal(env.frames.length, 2);
    assert.equal(env.configs[0].codec, 'avc1.640033');
    assert.equal(env.configs[0].bitrate, 64_000_000);
    assert.equal(result.duration, 2 / 30);
    assert.equal(result.width, 3840);
    assert.equal(result.height, 2160);
    assert.equal(result.fps, 30);
    assert.equal(getExportBitrate(1920, 1080, 60, 'standard'), 20_000_000);
  });

  exportTest('浏览器能力和编码分辨率不支持时提示操作方法并恢复现场', async env => {
    env.supported = false;
    await assert.rejects(exportTimelineVideo(env.session, env.options), /无法编码.*1080p \/ 30 FPS/);
    assert.equal(env.encoders.length, 0);
    assert.equal(env.restored, 1);
    globalThis.VideoEncoder = undefined;
    assert.equal(isHDVideoExportSupported(), false);
    await assert.rejects(exportTimelineVideo(env.session, env.options), /最新版 Chrome/);
    assert.equal(env.restored, 2);
  });

  exportTest('取消支持编码前、渲染中和队列排空时，释放帧与编码器且无残留 URL', async env => {
    const controller = new AbortController();
    env.options.signal = controller.signal;
    controller.abort();
    await assert.rejects(exportTimelineVideo(env.session, env.options), { name: 'AbortError' });
    assert.equal(env.frames.length, 0);
    assert.equal(env.restored, 1);
    const renderController = new AbortController();
    env.options.signal = renderController.signal;
    env.afterRender = () => renderController.abort();
    await assert.rejects(exportTimelineVideo(env.session, env.options), { name: 'AbortError' });
    assert.equal(env.frames.length, 0);
    assert.equal(env.encoders.at(-1).state, 'closed');
    const flushController = new AbortController();
    env.options.signal = flushController.signal;
    env.afterRender = null;
    env.afterFlush = () => flushController.abort();
    await assert.rejects(exportTimelineVideo(env.session, env.options), { name: 'AbortError' });
    assert.equal(env.frames.length, 4);
    assert.ok(env.frames.every(frame => frame.closed));
    assert.equal(env.encoders.at(-1).state, 'closed');
    assert.equal(env.restored, 3);
    assert.equal(env.urls.size, 0);
  });

  exportTest('渲染与编码/flush异常均恢复预览，编码异常有中文处理建议', async env => {
    env.renderFailure = true;
    await assert.rejects(exportTimelineVideo(env.session, env.options), /Render failed/);
    env.renderFailure = false;
    env.encodeFailure = true;
    await assert.rejects(exportTimelineVideo(env.session, env.options), /1080p \/ 30 FPS/);
    env.encodeFailure = false;
    env.flushFailure = true;
    await assert.rejects(exportTimelineVideo(env.session, env.options), /1080p \/ 30 FPS/);
    assert.equal(env.restored, 3);
    assert.ok(env.frames.every(frame => frame.closed));
    assert.ok(env.encoders.every(encoder => encoder.state === 'closed'));
    assert.equal(env.urls.size, 0);
  });

  exportTest('尺寸校验失败也恢复现场；进度回调失败后清理 URL', async env => {
    env.session.canvas.width = 1280;
    await assert.rejects(exportTimelineVideo(env.session, env.options), /画布尚未切换到 1920/);
    assert.equal(env.encoders.length, 0);
    assert.equal(env.restored, 1);
    env.session.canvas.width = 1920;
    env.session.duration = 1 / 60;
    await assert.rejects(exportTimelineVideo(env.session, env.options, progress => {
      if (progress === 1) throw new Error('Preview gone');
    }), /Preview gone/);
    assert.equal(env.restored, 2);
    assert.equal(env.urls.size, 0);
  });

  exportTest('256 MB 编码上限阻止内存膨胀，给出缩短时间轴建议并恢复现场', async env => {
    env.chunkSize = 256 * 1024 * 1024 + 1;
    await assert.rejects(exportTimelineVideo(env.session, env.options), /超过 256 MB.*缩短时间轴/);
    assert.equal(env.restored, 1);
    assert.ok(env.frames.every(frame => frame.closed));
    assert.equal(env.encoders[0].state, 'closed');
    assert.equal(env.urls.size, 0);
  });
});
