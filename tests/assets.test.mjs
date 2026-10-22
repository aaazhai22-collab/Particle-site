import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as THREE from 'three';

const source = await readFile(new URL('../src/assets.ts', import.meta.url), 'utf8');
let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
outputText = outputText.replace(/from (['"])(three(?:\/[^'"]*)?)\1/g, (_, quote, name) => `from ${JSON.stringify(import.meta.resolve(name))}`);
const assets = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const maximumRadius = positions => { let value = 0; for (let i = 0; i < positions.length; i += 3) value = Math.max(value, Math.hypot(positions[i], positions[i + 1], positions[i + 2])); return value; };
const geometry = () => new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 2, 0, 0, 0, 1, 0], 3));

test('sphere and seed pools retain an identical prefix and exact source radius', () => {
  const first = assets.createSphereAsset(); const second = assets.createSphereAsset();
  assert.equal(first.count, 100000); assert.equal(first.kind, 'sphere');
  assert.deepEqual(first.positions, second.positions); assert.deepEqual(first.seeds, second.seeds);
  assert.deepEqual(assets.createParticleSeeds(100), assets.createParticleSeeds(200).slice(0, 300));
  assert.ok(Math.abs(maximumRadius(first.positions) - 1.35) < 2e-7);
  for (const seed of first.seeds) assert.ok(seed >= 0 && seed <= 1);
});

test('normalization centers a translated shape without stretching its proportions', () => {
  const result = assets.normalizeParticlePositions(new Float32Array([100, 10, -2, 104, 12, 0]));
  assert.ok(Math.abs(maximumRadius(result) - 1.35) < 1e-7);
  assert.ok(Math.abs(result[0] + result[3]) < 1e-7);
  assert.ok(Math.abs((result[3] - result[0]) / (result[4] - result[1]) - 2) < 1e-7);
  assert.throws(() => assets.normalizeParticlePositions(new Float32Array([NaN, 0, 0])), /无效/);
});

test('transparent image pixels are omitted, faint alpha retained, and sRGB converted to linear', () => {
  const pixels = new Uint8ClampedArray([255, 0, 0, 0, 128, 128, 128, 255, 0, 255, 0, 1, 0, 0, 255, 255]);
  const asset = assets.sampleImagePixels(2, 2, pixels, 'alpha.png');
  assert.equal(asset.count, 3); assert.equal(asset.hasOriginalColors, true);
  assert.ok(asset.notes[0].includes('3'));
  assert.ok([...asset.positions].filter((_, i) => i % 3 === 2).every(value => value === 0));
  assert.ok([...asset.colors].some(value => Math.abs(value - 0.2158605) < 1e-6));
  assert.equal([...asset.colors].filter((_, i) => i % 3 === 0).filter(value => value === 1).length, 0);
  assert.throws(() => assets.sampleImagePixels(2, 2, new Uint8ClampedArray(16), 'clear.png'), /完全透明/);
});

test('seeded image shuffle generates unique sample prefixes at the 100k cap', () => {
  const pixels = new Uint8ClampedArray(500 * 500 * 4).fill(255);
  const asset = assets.sampleImagePixels(500, 500, pixels, 'large.jpg');
  assert.equal(asset.count, 100000);
  const points = new Set();
  for (let i = 0; i < asset.positions.length; i += 3) points.add(`${asset.positions[i]},${asset.positions[i + 1]}`);
  assert.equal(points.size, 100000);
  assert.ok(maximumRadius(asset.positions) <= 1.3500001);
});

test('736px portrait image prefixes cover rows/columns without periodic stripe bias', () => {
  const width = 736; const height = 981;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  const first = assets.sampleImagePixels(width, height, pixels, 'portrait.jpg');
  const second = assets.sampleImagePixels(width, height, pixels, 'portrait.jpg');
  const centerX = (width - 1) / 2; const centerY = (height - 1) / 2;
  const scale = 1.35 / Math.hypot(centerX, centerY);
  const columns = new Set(); const rows = new Set(); const unique = new Set();
  const cells = new Uint32Array(64); const xResidues = new Uint32Array(16); const yResidues = new Uint32Array(16);
  for (let i = 0; i < first.count; i++) {
    const x = Math.round(first.positions[i * 3] / scale + centerX);
    const y = Math.round(centerY - first.positions[i * 3 + 1] / scale);
    assert.ok(x >= 0 && x < width && y >= 0 && y < height);
    unique.add(y * width + x);
    if (i < 30000) { columns.add(x); rows.add(y); }
    if (i < 1000) {
      cells[Math.floor(y / height * 8) * 8 + Math.floor(x / width * 8)]++;
      xResidues[x % 16]++; yResidues[y % 16]++;
    }
  }
  assert.equal(first.count, 100000);
  assert.equal(unique.size, first.count, 'the capped pool must contain distinct valid pixels');
  assert.ok(columns.size / width > 0.95, `30k prefix covers ${columns.size}/${width} columns`);
  assert.ok(rows.size / height > 0.95, `30k prefix covers ${rows.size}/${height} rows`);
  assert.ok(cells.every(count => count >= 3 && count <= 34), `1k spatial cells: ${[...cells]}`);
  assert.ok(xResidues.every(count => count >= 30 && count <= 100), `1k x mod 16 bins: ${[...xResidues]}`);
  assert.ok(yResidues.every(count => count >= 30 && count <= 100), `1k y mod 16 bins: ${[...yResidues]}`);
  for (const count of [1000, 30000, 100000]) {
    assert.deepEqual(first.positions.subarray(0, count * 3), second.positions.subarray(0, count * 3));
    assert.deepEqual(first.seeds.subarray(0, count * 3), second.seeds.subarray(0, count * 3));
  }
});

test('world scale changes triangle sampling probability by transformed surface area', () => {
  const scene = new THREE.Group(); const small = new THREE.Mesh(geometry(), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
  const large = new THREE.Mesh(geometry(), new THREE.MeshBasicMaterial({ color: 0x00ff00 }));
  large.scale.set(3, 3, 3); large.position.set(10, 0, 0); scene.add(small, large);
  const asset = assets.sampleModelScene(scene, 'scaled.glb');
  let red = 0; let green = 0;
  for (let i = 0; i < asset.colors.length; i += 3) { if (asset.colors[i] > 0.9) red++; if (asset.colors[i + 1] > 0.9) green++; }
  assert.ok(Math.abs(red / asset.count - 0.1) < 0.0001); assert.equal(red + green, asset.count);
  assert.ok(maximumRadius(asset.positions) <= 1.3500001);
  // The larger transformed mesh remains on the opposite side of the smaller mesh.
  for (let i = 0; i < asset.count; i++) if (asset.colors[i * 3] > 0.9) assert.ok(asset.positions[i * 3] < 0); else assert.ok(asset.positions[i * 3] > 0);
});

test('linear vertex colors are barycentrically interpolated and multiplied by material base color', () => {
  const g = geometry().setAttribute('color', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1], 3));
  const material = new THREE.MeshBasicMaterial(); material.color.setRGB(0.5, 0.5, 0.5, THREE.LinearSRGBColorSpace);
  const scene = new THREE.Group(); scene.add(new THREE.Mesh(g, material));
  const asset = assets.sampleModelScene(scene, 'colors.glb');
  assert.equal(asset.hasOriginalColors, true);
  for (let i = 0; i < asset.colors.length; i += 3) assert.ok(Math.abs(asset.colors[i] + asset.colors[i + 1] + asset.colors[i + 2] - 0.5) < 1e-7);
});

test('UV base map sampling retains four color regions and converts sRGB texels to linear', () => {
  const priorDocument = globalThis.document;
  const pixels = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]);
  // Stub only the browser pixel-read surface; geometry, UV transforms and sampling are real.
  globalThis.document = { createElement: () => ({ width: 2, height: 2, getContext: () => ({ drawImage() {}, getImageData: () => ({ data: pixels }) }) }) };
  try {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0.75, 0, 1, 0.75, 0, -1, -0.75, 0, 1, -0.75, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2)); g.setIndex([0, 2, 1, 1, 2, 3]);
    const texture = new THREE.Texture({ width: 2, height: 2 }); texture.flipY = false; texture.colorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Group(); scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: texture })));
    const asset = assets.sampleModelScene(scene, 'uv.glb');
    const histogram = new Map();
    for (let i = 0; i < asset.colors.length; i += 3) { const key = `${asset.colors[i]},${asset.colors[i + 1]},${asset.colors[i + 2]}`; histogram.set(key, (histogram.get(key) || 0) + 1); }
    for (const color of ['1,0,0', '0,1,0', '0,0,1', '1,1,0']) assert.ok(Math.abs(histogram.get(color) / asset.count - 0.25) < 0.002);
    assert.equal(histogram.size, 4);
    for (let i = 0; i < pixels.length; i += 4) { pixels[i] = pixels[i + 1] = pixels[i + 2] = 128; }
    const gray = assets.sampleModelScene(scene, 'gray.glb');
    assert.ok(Math.abs(gray.colors[0] - 0.2158605) < 1e-6);
  } finally { if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument; }
});

test('unsupported or degenerate meshes cannot produce a fake usable model', () => {
  const scene = new THREE.Group(); scene.add(new THREE.SkinnedMesh(geometry(), new THREE.MeshBasicMaterial()));
  assert.throws(() => assets.sampleModelScene(scene, 'skin.glb'), /没有有效的静态/);
  const broken = new THREE.Group(); broken.add(new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3)), new THREE.MeshBasicMaterial()));
  assert.throws(() => assets.sampleModelScene(broken, 'broken.glb'), /没有有效的静态/);
});

test('real multi mesh GLB fixture parses and unsupported or corrupt files fail in Chinese', async () => {
  const bytes = await readFile(new URL('../public/examples/sample-sphere.glb', import.meta.url));
  const asset = await assets.loadParticleAsset(new File([bytes], 'sample-sphere.glb'));
  assert.equal(asset.kind, 'model'); assert.equal(asset.count, 100000); assert.equal(asset.hasOriginalColors, true);
  assert.ok(maximumRadius(asset.positions) <= 1.3500001);
  await assert.rejects(assets.loadParticleAsset(new File(['broken'], 'broken.glb')), /损坏/);
  const empty = await readFile(new URL('../public/examples/no-static-mesh.glb', import.meta.url));
  await assert.rejects(assets.loadParticleAsset(new File([empty], 'empty.glb')), /没有有效的静态/);
  await assert.rejects(assets.loadParticleAsset(new File(['x'], 'unknown.obj')), /不支持的文件格式/);
});

test('image effective region stays centered with equal pixel spacing after removing asymmetric padding', () => {
  const pixels = new Uint8ClampedArray(8 * 4 * 4);
  for (let y = 1; y <= 2; y++) for (let x = 3; x <= 6; x++) pixels.set([10, 20, 30, 128], (y * 8 + x) * 4);
  const asset = assets.sampleImagePixels(8, 4, pixels, 'padded.png');
  const x = [...asset.positions].filter((_, i) => i % 3 === 0); const y = [...asset.positions].filter((_, i) => i % 3 === 1);
  assert.equal(asset.count, 8);
  assert.ok(Math.abs(Math.min(...x) + Math.max(...x)) < 1e-7);
  assert.ok(Math.abs(Math.min(...y) + Math.max(...y)) < 1e-7);
  assert.ok(Math.abs((Math.max(...x) - Math.min(...x)) / (Math.max(...y) - Math.min(...y)) - 3) < 1e-6);
  assert.ok(asset.notes.some(note => note.includes('半透明')));
});

test('PNG and real JPEG dimensions are read before decode and memory limits reject before allocating', async () => {
  const png = await readFile(new URL('../public/examples/color-flower.png', import.meta.url));
  const jpeg = await readFile(new URL('../public/examples/sample-background.jpg', import.meta.url));
  assert.deepEqual(assets.readImageDimensions(png), { width: 768, height: 768 });
  assert.deepEqual(assets.readImageDimensions(jpeg), { width: 480, height: 320 });
  assert.throws(() => assets.readImageDimensions(new Uint8Array([1, 2, 3])), /尺寸无法安全读取/);
  await assert.rejects(assets.loadParticleAsset({ name: 'large.png', size: 51 * 1024 * 1024, slice() { throw new Error('must not read'); } }), /50 MiB/);
  await assert.rejects(assets.loadParticleAsset({ name: 'large.glb', size: 101 * 1024 * 1024, arrayBuffer() { throw new Error('must not read'); } }), /100 MiB/);
  const header = new Uint8Array(png.subarray(0, 24)); const view = new DataView(header.buffer); view.setUint32(16, 10000); view.setUint32(20, 10000);
  await assert.rejects(assets.loadParticleAsset(new File([header], 'decompression-bomb.png')), /3,600 万像素/);
});

test('ImageBitmap and canvases close on successful sampling and transparent-image rejection', async () => {
  const priorDocument = globalThis.document; const priorBitmap = globalThis.createImageBitmap;
  const png = await readFile(new URL('../public/examples/color-flower.png', import.meta.url));
  let closed = 0; let transparent = false; const canvases = [];
  globalThis.createImageBitmap = async () => ({ width: 2, height: 2, close() { closed++; } });
  globalThis.document = { createElement: () => {
    const canvas = { width: 2, height: 2, toDataURL: () => 'data:image/png;base64,test', getContext: () => ({ drawImage() {}, getImageData: () => ({ data: transparent ? new Uint8ClampedArray(16) : new Uint8ClampedArray(16).fill(255) }) }) }; canvases.push(canvas); return canvas;
  } };
  try {
    const result = await assets.loadParticleAsset(new File([png], 'valid.png')); assert.equal(result.count, 4); assert.equal(closed, 1);
    transparent = true; await assert.rejects(assets.loadParticleAsset(new File([png], 'clear.png')), /完全透明/); assert.equal(closed, 2);
    assert.ok(canvases.every(canvas => canvas.width === 1 && canvas.height === 1));
  } finally { if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument; if (priorBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = priorBitmap; }
});

test('hierarchical rotated nonuniform world transforms retain area weighting and large translation precision', () => {
  const scene = new THREE.Group(); scene.position.set(100000000, -100000000, 0); scene.rotation.z = 0.4;
  const small = new THREE.Mesh(geometry(), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
  const large = new THREE.Mesh(geometry(), new THREE.MeshBasicMaterial({ color: 0x00ff00 })); large.scale.set(3, 2, 1); large.position.set(10, 0, 0); scene.add(small, large);
  const asset = assets.sampleModelScene(scene, 'world.glb');
  let red = 0; for (let i = 0; i < asset.colors.length; i += 3) if (asset.colors[i] > 0.9) red++;
  assert.ok(Math.abs(red / asset.count - 1 / 7) < 0.0001);
  assert.ok(maximumRadius(asset.positions) > 1.34 && maximumRadius(asset.positions) <= 1.3500001);
});

test('one invalid triangle is skipped while valid static geometry remains available', () => {
  const g = geometry().setIndex([0, 1, 2, 0, 1, 999]); const scene = new THREE.Group(); scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
  const asset = assets.sampleModelScene(scene, 'partly-invalid.glb');
  assert.equal(asset.count, 100000); assert.ok(asset.notes.some(note => note.includes('1 个退化或无效')));
});

test('UV transform and flipY swap sampled regions; missing UV falls back and warns', () => {
  const priorDocument = globalThis.document;
  const pixels = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]);
  globalThis.document = { createElement: () => ({ width: 2, height: 2, getContext: () => ({ drawImage() {}, getImageData: () => ({ data: pixels }) }) }) };
  try {
    const g = geometry().setAttribute('uv', new THREE.Float32BufferAttribute([0.25, 0.25, 0.25, 0.25, 0.25, 0.25], 2));
    const texture = new THREE.Texture({ width: 2, height: 2 }); texture.colorSpace = THREE.SRGBColorSpace; texture.flipY = false;
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.5 }); const scene = new THREE.Group(); scene.add(new THREE.Mesh(g, material));
    const original = assets.sampleModelScene(scene, 'texture.glb'); assert.deepEqual([...original.colors.slice(0, 3)], [1, 0, 0]);
    texture.offset.x = 0.5; const offset = assets.sampleModelScene(scene, 'texture.glb'); assert.deepEqual([...offset.colors.slice(0, 3)], [0, 1, 0]);
    texture.flipY = true; const flipped = assets.sampleModelScene(scene, 'texture.glb'); assert.deepEqual([...flipped.colors.slice(0, 3)], [1, 1, 0]);
    assert.ok(flipped.notes.some(note => note.includes('透明材质')));
    g.deleteAttribute('uv'); const missing = assets.sampleModelScene(scene, 'texture.glb'); assert.deepEqual([...missing.colors.slice(0, 3)], [1, 1, 1]); assert.ok(missing.notes.some(note => note.includes('UV')));
  } finally { if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument; }
});

test('all loaded scenes release shared geometry, materials, textures and bitmaps once', () => {
  const first = new THREE.Group(); const second = new THREE.Group(); const g = geometry();
  let geometryDisposed = 0; let materialDisposed = 0; let textureDisposed = 0; let bitmapClosed = 0;
  const texture = new THREE.Texture({ width: 2, height: 2, close() { bitmapClosed++; } }); const material = new THREE.MeshBasicMaterial({ map: texture });
  g.addEventListener('dispose', () => geometryDisposed++); material.addEventListener('dispose', () => materialDisposed++); texture.addEventListener('dispose', () => textureDisposed++);
  first.add(new THREE.Mesh(g, material)); second.add(new THREE.Mesh(g, material)); assets.disposeAssetScenes([first, second]);
  assert.deepEqual([geometryDisposed, materialDisposed, textureDisposed, bitmapClosed], [1, 1, 1, 1]);
});
