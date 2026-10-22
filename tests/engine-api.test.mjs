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

function editingEngine() {
  const engine = Object.create(ParticleEngine.prototype);
  const uniforms = Object.fromEntries([
    'uSize', 'uSpread', 'uTurbulence', 'uGlow', 'uOriginalColor', 'uOpacity', 'uFade',
    'uAxis', 'uErosion', 'uFlowScale', 'uStringiness', 'uTrail', 'uWaveRhythm', 'uMode',
    'uDepth', 'uScatter', 'uStagger', 'uIsImage', 'uProgress', 'uTime', 'uTrailTimeSpan', 'uTrailProgressSpan',
  ].map((name) => [name, { value: 0 }]));
  uniforms.uColor = { value: new THREE.Color() };
  uniforms.uDirection = { value: new THREE.Vector3() };
  Object.assign(engine, {
    values: { ...DEFAULT_PARAMS }, asset: asset(40_000),
    current: {
      progress: 0.42, running: true, mode: 'loop', direction: -1, time: 12, fps: 60,
      actualCount: 30_000, timelineTime: 2, timelineDuration: 6, timelineLoop: true,
    },
    geometry: new THREE.BufferGeometry(), trailGeometry: new THREE.InstancedBufferGeometry(),
    points: {}, trails: {}, material: { uniforms },
    renderer: { calls: 0, render() { this.calls++; } },
    controls: { update: () => false },
    object: new THREE.Group(), camera: new THREE.PerspectiveCamera(),
    clip: { duration: 6, keyframes: [
      { id: 'a', time: 0, scale: 1, rotation: [0, 0, 0], progress: 0 },
      { id: 'b', time: 3, scale: 2, rotation: [0, 90, 0], progress: 1 },
      { id: 'c', time: 6, scale: 1, rotation: [0, 180, 0], progress: 0 },
    ] },
    timelineMode: true, progressLookup: new Float32Array(1025),
    pendingEffect: null, destroyed: false, onUpdate: () => {},
    lastFrame: 0, lastUpdate: 0, fpsStart: 0, fpsFrames: 0, requestId: 0,
    needsRendering: true, captureActive: false, trailProgressVelocity: 0,
  });
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
  assert.deepEqual(engine.state, { ...before, actualCount: 10_000 });
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
  assert.deepEqual(engine.state, { ...before, actualCount: 12 });
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
    assert.equal(engine.state.time, 12);
    engine.tick(100016);
    assert.ok(Math.abs(engine.state.time - 12.016) < 1e-9);
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
