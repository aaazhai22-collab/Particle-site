import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import ts from 'typescript';

// 编译真实源文件。编码器使用测试替身；真实视频容器与回放另由浏览器验收。
const source = await readFile(new URL('../src/CanvasRecorder.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { CanvasRecorder } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

function createEnvironment() {
  const restoredProperties = [];
  const replace = (target, name, value) => {
    restoredProperties.push([target, name, Object.getOwnPropertyDescriptor(target, name)]);
    Object.defineProperty(target, name, { configurable: true, writable: true, value });
  };
  const environment = {
    replace,
    now: 0,
    timerId: 0,
    timeouts: new Map(),
    intervals: new Map(),
    urls: new Map(),
    revokedUrls: [],
    downloads: [],
    anchors: new Set(),
    streams: [],
    encoders: [],
    supportedTypes: new Set(['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']),
    captureFailure: null,
    updates: [],
    pauseEvents: [],
    advance(milliseconds, runTimers = false) {
      this.now += milliseconds;
      if (runTimers) {
        for (const [id, timer] of [...this.timeouts]) {
          if (timer.at <= this.now) {
            this.timeouts.delete(id);
            timer.callback();
          }
        }
        for (const timer of [...this.intervals.values()]) timer.callback();
      }
    },
    restore() {
      for (const [target, name, descriptor] of restoredProperties.reverse()) {
        if (descriptor) Object.defineProperty(target, name, descriptor);
        else delete target[name];
      }
    },
  };

  replace(globalThis, 'performance', { now: () => environment.now });
  replace(globalThis, 'window', {
    setInterval(callback, delay) {
      const id = ++environment.timerId;
      environment.intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval: (id) => environment.intervals.delete(id),
    setTimeout(callback, delay) {
      const id = ++environment.timerId;
      environment.timeouts.set(id, { callback, at: environment.now + delay });
      return id;
    },
    clearTimeout: (id) => environment.timeouts.delete(id),
  });

  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...arguments_) {
      super(...(arguments_.length ? arguments_ : ['2026-10-06T11:30:00Z']));
    }
    static now() { return new RealDate('2026-10-06T11:30:00Z').getTime(); }
  }
  replace(globalThis, 'Date', FixedDate);

  replace(URL, 'createObjectURL', (blob) => {
    const url = `blob:recorder-test-${++environment.timerId}`;
    environment.urls.set(url, blob);
    return url;
  });
  replace(URL, 'revokeObjectURL', (url) => {
    environment.revokedUrls.push(url);
    environment.urls.delete(url);
  });
  replace(globalThis, 'document', {
    createElement(tag) {
      assert.equal(tag, 'a');
      const anchor = {
        href: '', download: '',
        click() { environment.downloads.push({ href: this.href, filename: this.download }); },
        remove() { environment.anchors.delete(this); },
      };
      return anchor;
    },
    body: { appendChild: (anchor) => environment.anchors.add(anchor) },
  });

  class MockMediaRecorder {
    static isTypeSupported(type) { return environment.supportedTypes.has(type); }
    constructor(stream, options) {
      this.stream = stream;
      this.options = options;
      this.mimeType = options.mimeType;
      this.state = 'inactive';
      this.stopCalls = 0;
      environment.encoders.push(this);
    }
    start(timeslice) { this.timeslice = timeslice; this.state = 'recording'; }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    stop() { this.stopCalls++; this.state = 'inactive'; }
    emitData(blob = new Blob(['frame'], { type: this.mimeType })) {
      this.ondataavailable?.({ data: blob });
    }
    finish(blob = new Blob(['final'], { type: this.mimeType })) {
      this.state = 'inactive';
      this.emitData(blob);
      this.onstop?.();
    }
    fail(error = new DOMException('Encoder unavailable', 'NotSupportedError')) {
      this.onerror?.({ error });
    }
  }
  replace(globalThis, 'MediaRecorder', MockMediaRecorder);

  environment.canvas = {
    width: 1280,
    height: 720,
    captureStream(frameRate) {
      assert.equal(frameRate, environment.manualCapture ? 0 : (environment.targetFps ?? 30));
      if (environment.captureFailure) throw environment.captureFailure;
      const track = { stopped: false, stop() { this.stopped = true; } };
      if (environment.manualCapture) track.requestFrame = () => { environment.frameRequests = (environment.frameRequests || 0) + 1; };
      const stream = { track, getVideoTracks: () => [track], getTracks: () => [track] };
      environment.streams.push(stream);
      return stream;
    },
  };
  environment.createRecorder = () => new CanvasRecorder(
    environment.canvas,
    (state) => environment.updates.push(state),
    (paused) => environment.pauseEvents.push(paused),
  );
  return environment;
}

function recorderTest(name, run) {
  test(name, async () => {
    const environment = createEnvironment();
    try { await run(environment); } finally { environment.restore(); }
  });
}

describe('CanvasRecorder 状态与资源回归', { concurrency: false }, () => {
  recorderTest('1080p60 targets manual requests at 60 FPS and reports the selected capture rate', (env) => {
    env.manualCapture = true;
    env.replace(globalThis, 'CanvasCaptureMediaStreamTrack', { prototype: { requestFrame() {} } });
    env.canvas.width = 1920; env.canvas.height = 1080;
    const recorder = env.createRecorder();
    recorder.start('high', { width: 1920, height: 1080, fps: 60 });
    assert.equal(recorder.state.status, 'recording');
    assert.equal(env.frameRequests, 1);
    assert.equal(env.encoders.at(-1).options.videoBitsPerSecond, 48_000_000);
    env.advance(17, true);
    assert.equal(env.frameRequests, 2, 'a second capture is requested within the 30 FPS interval');
    env.advance(17, true);
    assert.equal(env.frameRequests, 3);
    recorder.pause(); env.advance(1000, true);
    assert.equal(env.frameRequests, 3);
    recorder.resume(); env.advance(17, true);
    assert.equal(env.frameRequests, 4);
    recorder.stop(); env.encoders.at(-1).finish();
    assert.equal(recorder.state.result.fps, 60);
    assert.equal(recorder.state.result.requestedFrames, 4);
    assert.equal(recorder.state.result.captureMode, 'manual');
    recorder.destroy();
  });

  recorderTest('automatic capture receives the selected frame rate; invalid size and FPS never start a stream', (env) => {
    env.targetFps = 60;
    const recorder = env.createRecorder();
    recorder.start('high', { width: 1920, height: 1080, fps: 60 });
    assert.equal(recorder.state.status, 'error');
    assert.equal(env.streams.length, 0);
    recorder.start('high', { width: 1280, height: 720, fps: NaN });
    assert.match(recorder.state.error, /帧率/);
    assert.equal(env.streams.length, 0);
    recorder.start('high', { width: 1280, height: 720, fps: 60 });
    assert.equal(recorder.state.status, 'recording');
    env.advance(100); recorder.stop(); env.encoders.at(-1).finish();
    assert.equal(recorder.state.result.fps, 60);
    assert.equal(recorder.state.result.captureMode, 'automatic');
    assert.equal(recorder.state.result.requestedFrames, 0);
    recorder.destroy();
  });

  recorderTest('manual frame requests follow effective time, pause excludes requests, and teardown clears the pump', (env) => {
    env.manualCapture = true;
    env.replace(globalThis, 'CanvasCaptureMediaStreamTrack', { prototype: { requestFrame() {} } });
    const recorder = env.createRecorder(); recorder.start();
    const encoder = env.encoders.at(-1);
    assert.equal(env.frameRequests, 1);
    env.advance(34, true); assert.equal(env.frameRequests, 2);
    recorder.pause(); const requests = env.frameRequests;
    env.advance(5000, true); assert.equal(env.frameRequests, requests);
    recorder.resume(); env.advance(34, true); assert.equal(env.frameRequests, requests + 1);
    recorder.stop(); encoder.finish();
    assert.equal(recorder.state.result.captureMode, 'manual');
    assert.equal(recorder.state.result.requestedFrames, 3);
    assert.equal(recorder.state.result.duration, .068);
    assert.equal(env.intervals.size, 0); assert.equal(env.timeouts.size, 0);
    assert.ok(env.streams.every(stream => stream.track.stopped)); recorder.destroy();
  });
  recorderTest('1080p captures actual dimensions and uses explicit higher encoding bitrate', (env) => {
    env.canvas.width = 1920; env.canvas.height = 1080;
    const recorder = env.createRecorder(); recorder.start('high');
    const encoder = env.encoders.at(-1);
    assert.equal(encoder.options.videoBitsPerSecond, 24_000_000);
    env.advance(11_000); recorder.stop(); encoder.finish();
    assert.equal(recorder.state.result.width, 1920); assert.equal(recorder.state.result.height, 1080);
    assert.equal(recorder.state.result.duration, 11);
    recorder.start('standard');
    assert.equal(env.encoders.at(-1).options.videoBitsPerSecond, 12_000_000);
    recorder.destroy(); assert.ok(env.streams.every(stream => stream.track.stopped));
  });

  recorderTest('按真实能力优先 MP4，回退 WebM，画质及上海时间文件名正确', (env) => {
    env.supportedTypes.add('video/mp4');
    const recorder = env.createRecorder();
    assert.equal(recorder.supported, true);
    assert.equal(recorder.mimeType, 'video/mp4');
    recorder.start('standard');
    const mp4 = env.encoders.at(-1);
    assert.equal(mp4.timeslice, 1000);
    assert.equal(mp4.options.videoBitsPerSecond, 6_000_000);
    env.advance(10_000);
    recorder.stop();
    mp4.finish();
    assert.equal(recorder.state.result.extension, 'mp4');
    assert.equal(recorder.state.result.blob.type, 'video/mp4');
    assert.equal(recorder.state.result.filename, 'Particle_Sphere_20261006_193000.mp4');

    env.supportedTypes.delete('video/mp4');
    recorder.start('high');
    const webm = env.encoders.at(-1);
    assert.equal(webm.options.videoBitsPerSecond, 12_000_000);
    assert.equal(recorder.mimeType, 'video/webm;codecs=vp9');
    recorder.stop();
    webm.finish();
    assert.equal(recorder.state.result.extension, 'webm');
    assert.equal(recorder.state.result.mimeType, 'video/webm;codecs=vp9');
    assert.equal(recorder.state.result.filename, 'Particle_Sphere_20261006_193000.webm');
    recorder.destroy();
  });

  recorderTest('暂停时间不计入录像，重复开始不覆盖任务，最终块到齐后才生成', async (env) => {
    const recorder = env.createRecorder();
    recorder.start();
    const encoder = env.encoders.at(-1);
    recorder.start();
    assert.equal(env.encoders.length, 1);
    assert.equal(recorder.state.error, null);
    encoder.emitData(new Blob(['first'], { type: encoder.mimeType }));
    env.advance(2500);
    recorder.pause();
    assert.equal(recorder.state.status, 'paused');
    assert.equal(recorder.state.elapsed, 2.5);
    env.advance(10_000);
    recorder.resume();
    env.advance(3000);
    recorder.stop();
    assert.equal(recorder.state.status, 'processing');
    assert.equal(recorder.state.result, null);
    assert.equal(recorder.state.elapsed, 5.5);
    assert.equal(env.streams[0].track.stopped, false);
    env.advance(2000);
    encoder.finish();
    assert.equal(recorder.state.status, 'ready');
    assert.equal(recorder.state.result.duration, 5.5);
    assert.equal(await recorder.state.result.blob.text(), 'firstfinal');
    assert.deepEqual(env.pauseEvents, [true, false]);
    assert.equal(env.streams[0].track.stopped, true);
    const snapshot = recorder.state;
    snapshot.status = 'error';
    snapshot.result.filename = 'changed';
    assert.equal(recorder.state.status, 'ready');
    assert.notEqual(recorder.state.result.filename, 'changed');
    recorder.destroy();
  });

  recorderTest('暂停状态可停止，结束与生成阶段不重复累计时长', (env) => {
    const recorder = env.createRecorder();
    recorder.start();
    const encoder = env.encoders.at(-1);
    env.advance(2000);
    recorder.pause();
    env.advance(10_000);
    recorder.stop();
    assert.equal(encoder.stopCalls, 1);
    assert.deepEqual(env.pauseEvents, [true, false]);
    env.advance(10_000);
    encoder.finish();
    assert.equal(recorder.state.result.duration, 2);
    assert.equal(recorder.state.result.width, 1280);
    assert.equal(recorder.state.result.height, 720);
    assert.equal(env.timeouts.size, 0);
    assert.equal(env.intervals.size, 0);
    recorder.destroy();
  });

  recorderTest('120 秒自动停止使用有效时长，暂停后恢复剩余预算', (env) => {
    const recorder = env.createRecorder();
    recorder.start();
    const encoder = env.encoders.at(-1);
    env.advance(60_000, true);
    recorder.pause();
    env.advance(180_000, true);
    assert.equal(recorder.state.status, 'paused');
    assert.equal(recorder.state.elapsed, 60);
    recorder.resume();
    env.advance(59_000, true);
    assert.equal(recorder.state.status, 'recording');
    env.advance(1000, true);
    assert.equal(recorder.state.status, 'processing');
    assert.equal(encoder.stopCalls, 1);
    encoder.finish();
    assert.equal(recorder.state.result.duration, 120);
    recorder.destroy();
  });

  recorderTest('200 MB 阈值自动停止且保留触发块及最终块', async (env) => {
    const recorder = env.createRecorder();
    recorder.start();
    const encoder = env.encoders.at(-1);
    const chunk = new Blob(['limit'], { type: encoder.mimeType });
    // 模拟编码器报告的块大小，避免测试真实分配 200 MB 内存。
    Object.defineProperty(chunk, 'size', { value: 200 * 1024 * 1024 });
    encoder.emitData(chunk);
    assert.equal(recorder.state.status, 'processing');
    assert.equal(recorder.state.result, null);
    assert.equal(encoder.stopCalls, 1);
    encoder.finish();
    assert.equal(recorder.state.status, 'ready');
    assert.equal(await recorder.state.result.blob.text(), 'limitfinal');
    recorder.destroy();
  });

  recorderTest('编码异常等待结束数据，保留收到的片段；空数据提示错误', (env) => {
    const recorder = env.createRecorder();
    recorder.start();
    const encoder = env.encoders.at(-1);
    encoder.emitData();
    encoder.fail();
    assert.equal(recorder.state.status, 'processing');
    assert.equal(recorder.state.result, null);
    encoder.finish();
    assert.equal(recorder.state.status, 'ready');
    assert.match(recorder.state.error, /已保留/);
    assert.ok(recorder.state.result.blob.size > 0);

    recorder.start();
    const empty = env.encoders.at(-1);
    recorder.stop();
    empty.finish(new Blob([]));
    assert.equal(recorder.state.status, 'error');
    assert.equal(recorder.state.result, null);
    assert.match(recorder.state.error, /没有收到有效录像数据/);
    recorder.destroy();
  });

  recorderTest('五次录制及下载均清理轨道、监听、计时器和旧 URL；取消隔离旧事件', (env) => {
    const recorder = env.createRecorder();
    for (let index = 0; index < 5; index++) {
      recorder.start();
      const encoder = env.encoders.at(-1);
      env.advance(10_000);
      recorder.stop();
      encoder.finish();
      recorder.download();
      assert.equal(recorder.state.status, 'ready');
      assert.equal(env.urls.size, 1);
      assert.equal(env.anchors.size, 0);
      assert.equal(env.streams.at(-1).track.stopped, true);
      assert.equal(encoder.ondataavailable, null);
      assert.equal(encoder.onstop, null);
      assert.equal(encoder.onerror, null);
      assert.equal(env.timeouts.size, 0);
      assert.equal(env.intervals.size, 0);
    }
    assert.equal(env.downloads.length, 5);
    assert.equal(env.revokedUrls.length, 4);

    recorder.start();
    const cancelled = env.encoders.at(-1);
    const staleData = cancelled.ondataavailable;
    const staleStop = cancelled.onstop;
    recorder.pause();
    recorder.clear();
    assert.deepEqual(env.pauseEvents.slice(-2), [true, false]);
    assert.equal(env.streams.at(-1).track.stopped, true);
    assert.equal(env.urls.size, 0);
    recorder.start();
    staleData({ data: new Blob(['stale']) });
    staleStop();
    assert.equal(recorder.state.status, 'recording');
    assert.equal(recorder.state.bytes, 0);
    recorder.destroy();
    const updateCount = env.updates.length;
    recorder.start();
    recorder.pause();
    recorder.resume();
    recorder.stop();
    recorder.clear();
    assert.equal(env.updates.length, updateCount);
    assert.equal(recorder.supported, false);
    assert.equal(env.timeouts.size, 0);
    assert.equal(env.intervals.size, 0);
    assert.ok(env.streams.every((stream) => stream.track.stopped));
  });

  recorderTest('不支持录制、画布尺寸错误及安全错误给出中文提示且不创建无效任务', (env) => {
    env.supportedTypes.clear();
    const recorder = env.createRecorder();
    assert.equal(recorder.supported, false);
    recorder.start();
    assert.equal(recorder.state.status, 'error');
    assert.match(recorder.state.error, /不支持/);
    assert.equal(env.streams.length, 0);

    env.supportedTypes.add('video/webm');
    env.canvas.width = 640;
    recorder.start();
    assert.equal(recorder.state.status, 'error');
    assert.match(recorder.state.error, /1280 × 720/);
    assert.equal(env.encoders.length, 0);

    env.canvas.width = 1280;
    env.captureFailure = new DOMException('Tainted canvas', 'SecurityError');
    recorder.start();
    assert.equal(recorder.state.status, 'error');
    assert.match(recorder.state.error, /跨域图片/);
    assert.equal(env.timeouts.size, 0);
    assert.equal(env.intervals.size, 0);
    recorder.destroy();
  });

  recorderTest('文件名使用录制开始时的素材名，过滤非法字符且重复录制可更新名称', (env) => {
    const recorder = env.createRecorder();
    recorder.setProjectName('  花朵:春天.png  ');
    recorder.start();
    const first = env.encoders.at(-1);
    recorder.setProjectName('New Flower.glb');
    recorder.stop();
    first.finish();
    assert.equal(recorder.state.result.filename, 'Particle_花朵_春天_20261006_193000.webm');
    recorder.start();
    const second = env.encoders.at(-1);
    recorder.stop();
    second.finish();
    assert.equal(recorder.state.result.filename, 'Particle_New_Flower_20261006_193000.webm');
    recorder.setProjectName(' /:*? ');
    recorder.start();
    const third = env.encoders.at(-1);
    recorder.stop();
    third.finish();
    assert.equal(recorder.state.result.filename, 'Particle_Sphere_20261006_193000.webm');
    recorder.destroy();
  });
});
