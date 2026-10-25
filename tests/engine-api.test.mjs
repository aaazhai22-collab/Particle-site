import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const bundler = require.resolve('esbuild', { paths: [dirname(require.resolve('vite/package.json'))] });
const { build } = await import(pathToFileURL(bundler).href);

// Bundle the real class, then exercise its public editing APIs without needing
// a GPU. Browser QA separately covers the constructor, shader and render loop.
const bundled = await build({
  entryPoints: ['src/ParticleEngine.ts'], bundle: true, write: false,
  platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
});
const { ParticleEngine, DEFAULT_PARAMS } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

function asset(count, hasOriginalColors = true) {
  return {
    name: 'test.png', kind: 'image', count, hasOriginalColors, notes: [],
    positions: new Float32Array(count * 3).fill(0.2),
    colors: new Float32Array(count * 3).fill(0.5),
    seeds: new Float32Array(count * 3).fill(0.3),
  };
}

function editingEngine(options = {}) {
  const engine = Object.create(ParticleEngine.prototype);
  const uniforms = Object.fromEntries([
    'uSize', 'uSpread', 'uTurbulence', 'uGlow', 'uOriginalColor', 'uOpacity', 'uFade',
    'uAxis', 'uErosion', 'uFlowScale', 'uStringiness', 'uTrail', 'uWaveRhythm', 'uMode',
    'uDepth', 'uScatter', 'uStagger', 'uIsImage', 'uProgress', 'uTime', 'uTrailTimeSpan', 'uTrailProgressSpan',
    'uCurl', 'uSparkle', 'uDensityOpacity',
    'uSurfaceMode', 'uPetalFlow', 'uAmbientPhase', 'uAmbientRange', 'uTimelineActive',
    'uTimelineTime', 'uTimelineDuration', 'uMotionSpeed', 'uProgressHistory',
    'uOutputScale',
  ].map((name) => [name, { value: 0 }]));
  uniforms.uColor = { value: new THREE.Color() };
  uniforms.uDirection = { value: new THREE.Vector3() };
  Object.assign(engine, {
    values: { ...DEFAULT_PARAMS, autoCount: options.auto ?? false, count: options.count ?? 30000 }, asset: asset(options.capacity ?? 40_000),
    current: {
      progress: 0.42, running: true, mode: 'loop', direction: -1, time: 12, fps: 60,
      actualCount: 30_000, ambientCount: 0, filamentCount: 0, timelineTime: 2, timelineDuration: 6, timelineLoop: true,
      adaptiveStatus: '', adaptiveCeiling: 30000, frameMsAvg: 0,
    },
    geometry: new THREE.BufferGeometry(), trailGeometry: new THREE.InstancedBufferGeometry(),
    particleTrailGeometry: new THREE.InstancedBufferGeometry(), particleTrails: {},
    ambientGeometry: new THREE.BufferGeometry(), points: {}, trails: {}, ambientPoints: {}, material: { uniforms },
    renderer: { calls: 0, render() { this.calls++; } },
    controls: Object.assign(new THREE.EventDispatcher(), { update: () => false }),
    object: new THREE.Group(), camera: new THREE.PerspectiveCamera(),
    clip: { duration: 6, keyframes: [
      { id: 'a', time: 0, scale: 1, rotation: [0, 0, 0], progress: 0 },
      { id: 'b', time: 3, scale: 2, rotation: [0, 90, 0], progress: 1 },
      { id: 'c', time: 6, scale: 1, rotation: [0, 180, 0], progress: 0 },
    ] },
    timelineMode: true, effect: 'radial', progressLookup: new Float32Array(1025), ambientClock: 0,
    pendingEffect: null, destroyed: false, onUpdate: () => {},
    lastFrame: 0, lastUpdate: 0, fpsStart: 0, fpsFrames: 0, requestId: 0,
    needsRendering: true, cameraDirty: false, captureActive: false, trailProgressVelocity: 0,
    activeCount: 30000, adaptive: null, recordingLocked: false,
    adaptiveWarmupPending: true, adaptiveWarmupReason: '图形首次编译预热，暂不判断设备性能',
    renderedTrails: false, renderedParticleTrails: false, renderedBloom: false, pageHidden: false,
    postProcessing: { configure() {}, setSize() {}, render() { engine.renderer.render(); } },
  });
  engine.controlsChange = engine.handleControlsChange.bind(engine);
  engine.controls.addEventListener('change', engine.controlsChange);
  engine.synchronizeAdaptive(true);
  engine.updateCount();
  engine.rebuildProgressLookup();
  engine.camera.position.set(1, 2, 3);
  return engine;
}

test('changing density keeps camera, source geometry, progress and running task', () => {
  const engine = editingEngine();
  const before = engine.state;
  const geometry = engine.geometry;
  const camera = engine.camera.position.clone();
  engine.setParams({ count: 10_000 });
  assert.equal(engine.geometry, geometry);
  assert.deepEqual(engine.camera.position, camera);
  assert.deepEqual(engine.state, { ...before, actualCount: 10_000, adaptiveCeiling: 10000 });
  assert.equal(engine.geometry.drawRange.count, 10_000);
  assert.equal(engine.trailGeometry.instanceCount, 10_000);
});

test('valid asset replacement preserves playback/view and disposes both prior geometries', () => {
  const engine = editingEngine();
  const before = engine.state;
  const camera = engine.camera.position.clone();
  let disposed = 0;
  engine.geometry.addEventListener('dispose', () => disposed++);
  engine.trailGeometry.addEventListener('dispose', () => disposed++);
  const replacement = asset(12);
  engine.setAsset(replacement);
  assert.equal(disposed, 2);
  assert.equal(engine.geometry.getAttribute('position').array, replacement.positions);
  assert.equal(engine.state.actualCount, 12);
  assert.deepEqual(engine.state, { ...before, actualCount: 12, adaptiveCeiling: 12 });
  assert.deepEqual(engine.camera.position, camera);
});

test('invalid replacement leaves the valid asset and geometry alive', () => {
  const engine = editingEngine();
  const before = engine.geometry;
  let disposed = false;
  before.addEventListener('dispose', () => { disposed = true; });
  const invalid = asset(3);
  invalid.positions[2] = NaN;
  assert.throws(() => engine.setAsset(invalid), /原有场景已保留/);
  assert.equal(engine.geometry, before);
  assert.equal(disposed, false);
  assert.equal(engine.state.actualCount, 30_000);
});

test('timeline seek samples object transforms; manual shape keeps the actual pose', () => {
  const engine = editingEngine();
  engine.seekTimeline(1.5);
  assert.equal(engine.state.running, false);
  assert.deepEqual(engine.currentSample, { scale: 1.5, rotation: [0, 45, 0], progress: 0.5 });
  engine.setProgress(0.75);
  assert.ok(engine.state.timelineTime > 1.5 && engine.state.timelineTime < 3);
  assert.deepEqual(engine.currentSample, { scale: 1.5, rotation: [0, 45, 0], progress: 0.75 });
  engine.setEffect('erosion');
  assert.equal(engine.state.mode, 'assemble');
  assert.equal(engine.state.running, true);
  assert.deepEqual(engine.currentSample, { scale: 1.5, rotation: [0, 45, 0], progress: 0.75 });
});

test('original color mode falls back to the uniform when the asset has no original RGB', () => {
  const engine = editingEngine();
  engine.setParams({ colorMode: 'original' });
  assert.equal(engine.material.uniforms.uOriginalColor.value, 1);
  engine.setAsset(asset(30, false));
  assert.equal(engine.material.uniforms.uOriginalColor.value, 0);
});

test('3D controls are clamped and reach the actual shader uniforms without editing source positions', () => {
  const engine = editingEngine();
  const before = engine.asset.positions.slice();
  engine.setParams({ depth: 9, scatter: -2, stagger: 4 });
  assert.equal(engine.params.depth, 3);
  assert.equal(engine.params.scatter, 0);
  assert.equal(engine.params.stagger, 1);
  assert.equal(engine.material.uniforms.uDepth.value, 3);
  assert.equal(engine.material.uniforms.uScatter.value, 0);
  assert.equal(engine.material.uniforms.uStagger.value, 1);
  assert.equal(engine.material.uniforms.uIsImage.value, 1);
  assert.deepEqual(engine.asset.positions, before);
  engine.setAsset({ ...asset(10), kind: 'model' });
  assert.equal(engine.material.uniforms.uIsImage.value, 0);
});

test('manual progress reports a free task and Space continues it without sampling a different object pose', () => {
  const engine = editingEngine();
  engine.seekTimeline(1.5);
  assert.equal(engine.state.playbackSource, 'timeline');
  engine.setProgress(0.75);
  assert.equal(engine.state.playbackSource, 'free');
  engine.togglePause();
  assert.equal(engine.state.running, true);
  assert.deepEqual(engine.currentSample, { scale: 1.5, rotation: [0, 45, 0], progress: 0.75 });
});

test('paused frames stop issuing repeated GPU draws but camera and parameter changes still render', () => {
  const engine = editingEngine();
  engine.current.running = false;
  for (let now = 1000; now <= 2100; now += 100) engine.tick(now);
  assert.equal(engine.renderer.calls, 1);
  assert.equal(engine.state.fps, 1);
  assert.equal(engine.state.time, 12);
  assert.equal(engine.state.progress, 0.42);
  engine.setParams({ size: 3 });
  engine.tick(2200);
  assert.equal(engine.renderer.calls, 2);
  engine.controls.update = () => true;
  engine.tick(2300);
  assert.equal(engine.renderer.calls, 3);
});

test('a controls change already applied outside RAF redraws a paused view once without advancing animation', () => {
  const oldDocument = globalThis.document;
  const oldRAF = globalThis.requestAnimationFrame;
  let scheduled = 0;
  globalThis.document = { hidden: false };
  globalThis.requestAnimationFrame = () => { scheduled++; return 7; };
  try {
    const engine = editingEngine();
    engine.current.running = false;
    engine.tick(1000);
    const before = engine.state;
    const pose = engine.currentSample;
    engine.camera.position.multiplyScalar(0.8);
    engine.controls.dispatchEvent({ type: 'change' });
    engine.controls.dispatchEvent({ type: 'change' });
    assert.equal(engine.renderer.calls, 1, 'the listener invalidates instead of rendering recursively');
    assert.equal(scheduled, 1, 'several input events share the next scheduled frame');
    assert.equal(engine.cameraDirty, true);
    engine.tick(1016);
    assert.equal(engine.renderer.calls, 2, 'update() returning false does not lose the earlier camera change');
    assert.equal(engine.cameraDirty, false);
    assert.equal(engine.state.time, before.time);
    assert.equal(engine.state.timelineTime, before.timelineTime);
    assert.equal(engine.state.progress, before.progress);
    assert.deepEqual(engine.currentSample, pose);
    for (let now = 1032; now < 1400; now += 16) engine.tick(now);
    assert.equal(engine.renderer.calls, 2, 'a settled paused view returns to zero repeated draws');
  } finally {
    globalThis.document = oldDocument;
    globalThis.requestAnimationFrame = oldRAF;
  }
});

test('externally applied camera motion qualifies as a real adaptive sample while paused', () => {
  const oldDocument = globalThis.document;
  const oldRAF = globalThis.requestAnimationFrame;
  globalThis.document = { hidden: false };
  globalThis.requestAnimationFrame = () => 7;
  try {
    const engine = editingEngine({ auto: true, count: 300000, capacity: 500000 });
    engine.current.running = false;
    engine.adaptiveWarmupPending = false;
    engine.renderedBloom = true;
    engine.renderedTrails = true;
    engine.tick(1000);
    engine.controls.dispatchEvent({ type: 'change' });
    engine.tick(1016);
    assert.equal(engine.state.frameMsAvg, 16);
    assert.equal(engine.cameraDirty, false);
    assert.equal(engine.state.time, 12);
  } finally {
    globalThis.document = oldDocument;
    globalThis.requestAnimationFrame = oldRAF;
  }
});

test('destroy removes the controls change listener', () => {
  const oldDocument = globalThis.document;
  const oldCancel = globalThis.cancelAnimationFrame;
  globalThis.document = { removeEventListener() {} };
  globalThis.cancelAnimationFrame = () => {};
  try {
    const engine = editingEngine();
    engine.resizeObserver = { disconnect() {} };
    engine.controls.dispose = () => {};
    engine.canvas = { removeEventListener() {}, remove() {} };
    engine.material.dispose = () => {};
    engine.trailMaterial = { dispose() {} };
    engine.particleTrailMaterial = { dispose() {} };
    engine.ambientMaterial = { dispose() {} };
    engine.postProcessing.dispose = () => {};
    engine.renderer.dispose = () => {};
    engine.renderer.forceContextLoss = () => {};
    assert.equal(engine.controls.hasEventListener('change', engine.controlsChange), true);
    engine.destroy();
    assert.equal(engine.controls.hasEventListener('change', engine.controlsChange), false);
    engine.destroy();
  } finally {
    globalThis.document = oldDocument;
    globalThis.cancelAnimationFrame = oldCancel;
  }
});

test('a one-shot endpoint receives its final frame even though the task stops in that frame', () => {
  const engine = editingEngine();
  engine.timelineMode = false;
  engine.current.mode = 'disperse';
  engine.current.direction = 1;
  engine.current.progress = 0.95;
  engine.tick(1000);
  engine.tick(2000);
  assert.equal(engine.state.progress, 1);
  assert.equal(engine.state.running, false);
  assert.equal(engine.material.uniforms.uProgress.value, 1);
  assert.equal(engine.renderer.calls, 2);
  engine.tick(2100);
  assert.equal(engine.renderer.calls, 2);
});

test('recording keeps paused images producing frames, and repeated activation does not reset time', () => {
  const oldDocument = globalThis.document;
  const oldRAF = globalThis.requestAnimationFrame;
  globalThis.document = { hidden: false };
  globalThis.requestAnimationFrame = () => 7;
  try {
    const engine = editingEngine();
    engine.current.running = false;
    engine.setCaptureActive(true);
    engine.tick(1000);
    engine.setCaptureActive(true);
    assert.equal(engine.lastFrame, 1000);
    engine.tick(1100);
    engine.tick(1200);
    assert.equal(engine.renderer.calls, 3);
    assert.equal(engine.state.time, 12);
  } finally {
    globalThis.document = oldDocument;
    globalThis.requestAnimationFrame = oldRAF;
  }
});

test('hidden idle editors cancel RAF and resuming does not integrate the hidden interval', () => {
  const oldDocument = globalThis.document;
  const oldRAF = globalThis.requestAnimationFrame;
  const oldCancel = globalThis.cancelAnimationFrame;
  globalThis.document = { hidden: true };
  globalThis.requestAnimationFrame = () => 8;
  const canceled = [];
  globalThis.cancelAnimationFrame = id => canceled.push(id);
  try {
    const engine = editingEngine();
    engine.requestId = 42;
    engine.syncVisibility();
    assert.deepEqual(canceled, [42]);
    assert.equal(engine.requestId, 0);
    assert.equal(engine.state.fps, 0);
    assert.equal(engine.state.running, true);
    globalThis.document.hidden = false;
    engine.syncVisibility();
    assert.equal(engine.requestId, 8);
    engine.tick(100000);
    assert.equal(engine.state.time, 2);
    engine.tick(100016);
    assert.ok(Math.abs(engine.state.time - 2.016) < 1e-9);
  } finally {
    globalThis.document = oldDocument;
    globalThis.requestAnimationFrame = oldRAF;
    globalThis.cancelAnimationFrame = oldCancel;
  }
});

test('dense scenes retain actual short GPU trails with a bounded extra vertex budget', () => {
  const engine = editingEngine();
  engine.setAsset(asset(100000));
  engine.setParams({ count: 80000 });
  assert.equal(engine.state.actualCount, 80000);
  assert.equal(engine.trailGeometry.instanceCount, 12000);
  assert.equal(engine.trailGeometry.getAttribute('position').count, 6);
  engine.setProgress(0);
  engine.render();
  assert.equal(engine.trails.visible, false);
});

test('visual controls reach the HDR pipeline and curl/sparkle shader uniforms', () => {
  const engine = editingEngine();
  const calls = [];
  engine.postProcessing.configure = (...parameters) => calls.push(parameters);
  engine.setParams({ glow: 0.8, exposure: 9, contrast: 0, curl: 2.4, sparkle: 0.75 });
  assert.equal(engine.params.exposure, 3);
  assert.equal(engine.params.contrast, 0.5);
  assert.equal(engine.material.uniforms.uCurl.value, 2.4);
  assert.equal(engine.material.uniforms.uSparkle.value, 0.75);
  assert.deepEqual(calls.at(-1), [0.8, 3, 0.5, false]);
});

test('manual 180k and 300k settings draw the real prefix without creating another full trail pool', () => {
  const engine = editingEngine({ capacity: 500000 });
  engine.setAsset(asset(500000));
  const geometry = engine.geometry;
  const seeds = engine.geometry.getAttribute('aSeed').array;
  for (const count of [180000, 300000, 500000]) {
    engine.setParams({ autoCount: false, count });
    assert.equal(engine.state.actualCount, count);
    assert.equal(engine.geometry.drawRange.count, count);
    assert.equal(engine.geometry, geometry);
    assert.equal(engine.geometry.getAttribute('aSeed').array, seeds);
    assert.ok(engine.trailGeometry.getAttribute('aSeed').count <= 16000);
  }
});

test('automatic density uses motion pacing, preserves the user ceiling and does not rebuild geometry', () => {
  const engine = editingEngine({ auto: true, count: 300000, capacity: 500000 });
  engine.setAsset(asset(500000));
  assert.equal(engine.state.actualCount, 30000);
  assert.equal(engine.params.count, 300000);
  const geometry = engine.geometry;
  const camera = engine.camera.position.clone();
  for (let now = 1000; now < 16000; now += 1000 / 60) engine.tick(now);
  assert.ok(engine.state.actualCount > 30000);
  assert.ok(engine.state.actualCount <= 300000);
  assert.equal(engine.params.count, 300000);
  assert.equal(engine.state.adaptiveCeiling, 300000);
  assert.equal(engine.geometry, geometry);
  assert.equal(engine.geometry.drawRange.count, engine.state.actualCount);
  assert.deepEqual(engine.camera.position, camera);
  assert.ok(engine.state.frameMsAvg > 16 && engine.state.frameMsAvg < 17);
});

test('idle paused zero-FPS periods do not shrink automatic density', () => {
  const engine = editingEngine({ auto: true, count: 300000, capacity: 500000 });
  engine.current.running = false;
  for (let now = 1000; now < 60000; now += 1000) engine.tick(now);
  assert.equal(engine.state.actualCount, 30000);
  assert.equal(engine.state.frameMsAvg, 0);
  assert.equal(engine.state.fps, 0);
});

test('recording and its paused phase freeze automatic density, then resume with a clean measurement window', () => {
  const oldDocument = globalThis.document;
  const oldRAF = globalThis.requestAnimationFrame;
  globalThis.document = { hidden: false };
  globalThis.requestAnimationFrame = () => 7;
  try {
    const engine = editingEngine({ auto: true, count: 300000, capacity: 500000 });
    for (let now = 1000; now < 8000; now += 1000 / 60) engine.tick(now);
    const frozenCount = engine.state.actualCount;
    engine.setRecordingLocked(true);
    engine.setCaptureActive(true);
    for (let now = 8000; now < 11000; now += 100) engine.tick(now);
    engine.setCaptureActive(false);
    for (let now = 11000; now < 14000; now += 100) engine.tick(now);
    assert.equal(engine.state.actualCount, frozenCount);
    assert.match(engine.state.adaptiveStatus, /录制/);
    assert.equal(engine.adaptiveController().state.sampleSeconds, 0);
    engine.setRecordingLocked(false);
    assert.equal(engine.adaptiveController().state.sampleSeconds, 0);
    assert.equal(engine.state.actualCount, frozenCount);
  } finally {
    globalThis.document = oldDocument;
    globalThis.requestAnimationFrame = oldRAF;
  }
});

test('initial compilation frames are excluded for two seconds, then healthy motion can raise density', () => {
  const engine = editingEngine({ auto: true, count: 300000, capacity: 500000 });
  engine.tick(1000);
  engine.tick(2000);
  engine.tick(3000);
  assert.equal(engine.state.actualCount, 30000);
  assert.equal(engine.adaptiveController().state.sampleSeconds, 0);
  assert.equal(engine.state.frameMsAvg, 0);
  assert.match(engine.state.adaptiveStatus, /预热/);
  for (let now = 3017; now < 8500; now += 1000 / 60) engine.tick(now);
  assert.ok(engine.state.actualCount > 30000);
  assert.ok(engine.state.frameMsAvg > 16 && engine.state.frameMsAvg < 17);
});

test('repeated identical settings and colour/exposure editing cannot starve adaptive sampling', () => {
  const engine = editingEngine({ auto: true, count: 300000, capacity: 500000 });
  const originalCeiling = engine.params.count;
  for (let frame = 0; frame < 900; frame++) {
    engine.setParams({ autoCount: true, count: originalCeiling, color: '#b6a4ff', exposure: 1.3,
      opacity: 0.85 + Math.sin(frame * 0.1) * 0.01 });
    engine.tick(1000 + frame * 1000 / 60);
  }
  assert.ok(engine.state.actualCount > 30000, 'a real measurement window completes while non-cost settings are synced');
  assert.equal(engine.params.count, originalCeiling);
});

test('restoring a visible page excludes the resumed warmup instead of judging it as low device performance', () => {
  const oldDocument = globalThis.document;
  const oldRAF = globalThis.requestAnimationFrame;
  const oldCancel = globalThis.cancelAnimationFrame;
  globalThis.document = { hidden: false };
  globalThis.requestAnimationFrame = () => 8;
  globalThis.cancelAnimationFrame = () => {};
  try {
    const engine = editingEngine({ auto: true, count: 300000, capacity: 500000 });
    for (let now = 1000; now < 9000; now += 1000 / 60) engine.tick(now);
    const before = engine.state.actualCount;
    globalThis.document.hidden = true; engine.syncVisibility();
    globalThis.document.hidden = false; engine.syncVisibility();
    engine.tick(100000); engine.tick(101000); engine.tick(102000);
    assert.equal(engine.state.actualCount, before);
    assert.equal(engine.adaptiveController().state.sampleSeconds, 0);
    assert.equal(engine.state.frameMsAvg, 0);
    assert.match(engine.state.adaptiveStatus, /预热/);
  } finally {
    globalThis.document = oldDocument;
    globalThis.requestAnimationFrame = oldRAF;
    globalThis.cancelAnimationFrame = oldCancel;
  }
});

test('fully faded black motion frames cannot cause automatic count growth or reduction', () => {
  const engine = editingEngine({ auto: true, count: 300000, capacity: 500000 });
  engine.setParams({ fade: true });
  engine.setProgress(1);
  engine.current.mode = 'idle'; engine.current.running = true;
  for (let frame = 0; frame < 1200; frame++) engine.tick(1000 + frame * 1000 / 60);
  assert.equal(engine.state.actualCount, 30000);
  assert.equal(engine.adaptiveController().state.sampleSeconds, 0);
  assert.equal(engine.state.frameMsAvg, 0);
  assert.match(engine.state.adaptiveStatus, /完全淡出/);
});

test('free recording still applies manual density changes during capture and its paused phase', () => {
  const oldDocument = globalThis.document;
  const oldRAF = globalThis.requestAnimationFrame;
  globalThis.document = { hidden: false };
  globalThis.requestAnimationFrame = () => 7;
  try {
    const engine = editingEngine({ auto: false, count: 30000, capacity: 500000 });
    const camera = engine.camera.position.clone();
    const progress = engine.state.progress;
    const geometry = engine.geometry;
    engine.setRecordingLocked(true); engine.setCaptureActive(true);
    engine.setParams({ count: 180000 });
    assert.equal(engine.state.actualCount, 180000);
    assert.equal(engine.geometry.drawRange.count, 180000);
    engine.setCaptureActive(false);
    engine.setParams({ count: 90000 });
    assert.equal(engine.state.actualCount, 90000);
    assert.equal(engine.geometry.drawRange.count, 90000);
    assert.equal(engine.geometry, geometry);
    assert.deepEqual(engine.camera.position, camera);
    assert.equal(engine.state.progress, progress);
    assert.match(engine.state.adaptiveStatus, /手动/);
  } finally {
    globalThis.document = oldDocument;
    globalThis.requestAnimationFrame = oldRAF;
  }
});

test('petal layers use independent bounded prefixes while the main geometry and playback remain stable', () => {
  const engine = editingEngine({ count: 30000, capacity: 500000 });
  engine.effect = 'erosion';
  engine.setAsset(asset(500000));
  const geometry = engine.geometry;
  const mainSeed = geometry.getAttribute('aSeed').array;
  const progress = engine.state.progress;
  engine.setParams({ surfaceMode: true, petalFlow: true, ambient: 0.02, trail: 0.6, colorMode: 'uniform' });
  assert.equal(engine.state.actualCount, 30000);
  assert.equal(engine.state.ambientCount, 600);
  assert.equal(engine.state.filamentCount, 900);
  assert.equal(engine.ambientGeometry.drawRange.count, 600);
  assert.equal(engine.trailGeometry.instanceCount, 0, 'petal preset never submits line segments');
  assert.equal(engine.particleTrailGeometry.instanceCount, 900);
  assert.equal(engine.trailGeometry.getAttribute('position').count, 6);
  assert.equal(engine.material.depthWrite, true);
  assert.equal(engine.material.blending, THREE.NormalBlending);
  assert.equal(engine.material.uniforms.uOriginalColor.value, 0, 'the user can override the preset with uniform colour');
  engine.setParams({ count: 180000 });
  assert.equal(engine.state.ambientCount, 3600);
  assert.equal(engine.state.filamentCount, 1000);
  assert.equal(engine.geometry, geometry);
  assert.equal(engine.geometry.getAttribute('aSeed').array, mainSeed);
  assert.equal(engine.state.progress, progress);
  engine.setParams({ surfaceMode: false, petalFlow: false });
  assert.equal(engine.state.ambientCount, 0);
  assert.equal(engine.state.filamentCount, 0);
  assert.equal(engine.trailGeometry.getAttribute('position').count, 6);
  assert.equal(engine.material.depthWrite, false);
  assert.equal(engine.material.blending, THREE.AdditiveBlending);
});

test('the retained petal preset flag cannot override the other five effect modes', () => {
  const engine = editingEngine();
  engine.setParams({ surfaceMode: true, petalFlow: true, trail: 0.6 });
  for (const [index, effect] of ['radial', 'noise', 'vortex', 'directional', 'wave', 'erosion'].entries()) {
    engine.setProgress(0);
    engine.setEffect(effect);
    assert.equal(engine.params.petalFlow, true, 'switching modes keeps the shared preset controls');
    assert.equal(engine.material.uniforms.uMode.value, index);
    assert.equal(engine.material.uniforms.uPetalFlow.value, effect === 'erosion' ? 1 : 0);
    assert.equal(engine.trailGeometry.getAttribute('position').count, 6);
    assert.equal(engine.state.filamentCount, effect === 'erosion' ? 900 : 0);
  }
});

test('ending particle paths have 25 unique history samples and retain the existing path budget', () => {
  const engine = editingEngine({ count: 180000, capacity: 500000 });
  engine.effect = 'erosion';
  engine.setAsset(asset(500000));
  engine.setParams({ surfaceMode: true, petalFlow: true, trail: 0.55 });
  const positions = engine.particleTrailGeometry.getAttribute('position');
  const history = Array.from({ length: positions.count }, (_, i) => positions.getX(i));
  assert.equal(positions.count, 25);
  assert.equal(new Set(history).size, 25, 'line segment endpoints must not double the particle grain brightness');
  assert.equal(history[0], 0);
  assert.equal(history.at(-1), 1);
  assert.equal(engine.particleTrailGeometry.instanceCount, engine.state.filamentCount);
  assert.equal(engine.state.filamentCount, 1000);
  const old = engine.particleTrailGeometry;
  let disposed = 0;
  old.addEventListener('dispose', () => disposed++);
  engine.setAsset(asset(12000));
  assert.equal(disposed, 1);
  assert.equal(engine.particleTrails.geometry, engine.particleTrailGeometry);
});

test('petal preset uses only point tails throughout release, with no lines at any progress', () => {
  const engine = editingEngine();
  engine.effect = 'erosion';
  engine.setParams({ surfaceMode: true, petalFlow: true, fade: true, trail: 0.55 });
  for (const progress of [0.02, 0.2, 0.45, 0.65, 0.85, 0.99]) {
    engine.setProgress(progress); engine.render();
    assert.equal(engine.particleTrails.visible, true);
    assert.equal(engine.trails.visible, false);
    assert.equal(engine.trailGeometry.instanceCount, 0);
  }
  engine.setProgress(1); engine.render();
  assert.equal(engine.points.visible, false);
  assert.equal(engine.particleTrails.visible, false);
  assert.equal(engine.trails.visible, false);
  engine.setProgress(0); engine.render();
  assert.equal(engine.particleTrails.visible, false);
  assert.equal(engine.trails.visible, false);
});

test('petal flow respects switching between original and the selected uniform colour', () => {
  const engine = editingEngine();
  engine.effect = 'erosion';
  const originalColours = engine.asset.colors.slice();
  engine.setParams({ surfaceMode: true, petalFlow: true, colorMode: 'original' });
  assert.equal(engine.material.uniforms.uOriginalColor.value, 1);
  engine.setParams({ colorMode: 'uniform', color: '#22ccff' });
  assert.equal(engine.params.colorMode, 'uniform');
  assert.equal(engine.material.uniforms.uOriginalColor.value, 0);
  const expected = new THREE.Color('#22ccff');
  for (const channel of ['r', 'g', 'b']) assert.equal(engine.material.uniforms.uColor.value[channel], expected[channel]);
  engine.setParams({ colorMode: 'original' });
  assert.equal(engine.material.uniforms.uOriginalColor.value, 1);
  assert.deepEqual(engine.asset.colors, originalColours);
});

test('surface inputs reach all three layers and missing or invalid optional data has a finite fallback', () => {
  const engine = editingEngine();
  const source = asset(4);
  source.normals = new Float32Array([0, 2, 0, NaN, 0, 0, 0, 0, 0, 0, 0, -1]);
  source.surface = new Float32Array([0.25, 0.8, 1, NaN, 0, 0, 0.5, 0.7, 2, 0.75, 1, 0]);
  engine.setAsset(source);
  assert.deepEqual([...engine.geometry.getAttribute('aNormal').array.slice(0, 3)], [0, 1, 0]);
  assert.deepEqual([...engine.geometry.getAttribute('aSurface').array.slice(0, 3)], [0.25, Math.fround(0.8), 1]);
  for (const geometry of [engine.geometry, engine.trailGeometry, engine.ambientGeometry]) {
    assert.ok([...geometry.getAttribute('aNormal').array].every(Number.isFinite));
    assert.ok([...geometry.getAttribute('aSurface').array].every(Number.isFinite));
  }
  assert.equal(engine.geometry.getAttribute('position').array, source.positions);
});

test('seeking and playing to the same timeline second use identical motion phases and trail inputs', () => {
  const engine = editingEngine();
  engine.effect = 'erosion';
  engine.setParams({ surfaceMode: true, petalFlow: true, motionSpeed: 0.7 });
  engine.setTimeline({ duration: 36, keyframes: [
    { id: 'a', time: 0, scale: 1, rotation: [0, 0, 0], progress: 0 },
    { id: 'b', time: 24, scale: 1, rotation: [0, 0, 0], progress: 1 },
    { id: 'c', time: 36, scale: 1, rotation: [0, 0, 0], progress: 0 },
  ] });
  const inputs = () => Object.fromEntries(['uProgress', 'uTime', 'uAmbientPhase', 'uTimelineTime', 'uTrailTimeSpan', 'uTrailProgressSpan']
    .map(name => [name, engine.material.uniforms[name].value]));
  engine.seekTimeline(12); engine.render();
  const sought = inputs();
  assert.ok(Math.abs(engine.state.time - 8.4) < 1e-10);
  engine.seekTimeline(0); engine.setTimelinePlaying(true);
  engine.tick(1000); engine.tick(13000);
  assert.deepEqual(inputs(), sought);
  engine.seekTimeline(30); engine.seekTimeline(12); engine.render();
  assert.deepEqual(inputs(), sought);
  const texture = engine.material.uniforms.uProgressHistory.value;
  assert.equal(texture.image.data, engine.progressLookup);
  assert.equal(texture.image.width, 1025);
  assert.equal(texture.minFilter, THREE.NearestFilter);
});

test('36-second endpoints close the ambient layer exactly and fade hides every layer', () => {
  const engine = editingEngine();
  engine.effect = 'erosion';
  engine.setParams({ surfaceMode: true, petalFlow: true, fade: true });
  engine.setTimeline({ duration: 36, keyframes: [
    { id: 'a', time: 0, scale: 1, rotation: [0, 0, 0], progress: 0 },
    { id: 'b', time: 25, scale: 1, rotation: [0, 0, 0], progress: 1 },
    { id: 'c', time: 36, scale: 1, rotation: [0, 0, 0], progress: 0 },
  ] });
  engine.seekTimeline(0); engine.render();
  assert.equal(engine.ambientPoints.visible, true);
  const phase = engine.material.uniforms.uAmbientPhase.value;
  engine.seekTimeline(36); engine.render();
  assert.equal(engine.material.uniforms.uAmbientPhase.value, phase);
  assert.equal(engine.state.progress, 0);
  assert.equal(engine.trails.visible, false);
  engine.seekTimeline(25); engine.render();
  assert.equal(engine.points.visible, false);
  assert.equal(engine.trails.visible, false);
  assert.equal(engine.ambientPoints.visible, false);
});

test('output resolution resizes the real canvas/HDR graph and is locked throughout recording', () => {
  const engine = editingEngine();
  const calls = [];
  engine.renderer.setSize = (...args) => calls.push(['canvas', ...args]);
  engine.postProcessing.setSize = (...args) => calls.push(['hdr', ...args]);
  const camera = engine.camera.position.clone();
  const before = engine.state;
  engine.setParams({ resolution: '1080p' });
  assert.deepEqual(calls, [['canvas', 1920, 1080, false], ['hdr', 1920, 1080]]);
  assert.equal(engine.params.resolution, '1080p');
  assert.equal(engine.state.progress, before.progress);
  assert.equal(engine.state.running, before.running);
  assert.deepEqual(engine.camera.position, camera);
  assert.equal(engine.adaptiveWarmupPending, true);
  engine.setRecordingLocked(true);
  engine.setParams({ resolution: '720p' });
  assert.equal(engine.params.resolution, '1080p');
  assert.equal(calls.length, 2);
  engine.setRecordingLocked(false);
  engine.setParams({ resolution: '720p' });
  assert.deepEqual(calls.slice(-2), [['canvas', 1280, 720, false], ['hdr', 1280, 720]]);
});
