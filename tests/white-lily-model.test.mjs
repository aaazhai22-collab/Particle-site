import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const bytes = await readFile(new URL('../public/examples/white-lily-model.glb', import.meta.url));
const metadata = JSON.parse(await readFile(new URL('../public/examples/white-lily-model-metadata.json', import.meta.url), 'utf8'));
const jsonLength = bytes.readUInt32LE(12);
const gltf = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
const binary = bytes.subarray(jsonLength + 28);
const sRGB = value => value <= .0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - .055;

function readAccessor(index) {
  const entry = gltf.accessors[index], view = gltf.bufferViews[entry.bufferView];
  const components = entry.type === 'VEC3' ? 3 : entry.type === 'SCALAR' ? 1 : 0;
  const size = { 5123: 2, 5125: 4, 5126: 4 }[entry.componentType];
  assert.ok(size && components);
  const start = (view.byteOffset || 0) + (entry.byteOffset || 0), stride = view.byteStride || components * size;
  assert.ok(start + (entry.count - 1) * stride + components * size <= binary.length);
  const values = new Float64Array(entry.count * components);
  for (let vertex = 0; vertex < entry.count; vertex++) for (let axis = 0; axis < components; axis++) {
    const offset = start + vertex * stride + axis * size;
    values[vertex * components + axis] = entry.componentType === 5126 ? binary.readFloatLE(offset) : entry.componentType === 5125 ? binary.readUInt32LE(offset) : binary.readUInt16LE(offset);
  }
  return values;
}

const meshes = gltf.meshes.map(mesh => {
  assert.equal(mesh.primitives.length, 1);
  const primitive = mesh.primitives[0], attributes = primitive.attributes;
  return { ...mesh, primitive, positions: readAccessor(attributes.POSITION), normals: readAccessor(attributes.NORMAL),
    colors: readAccessor(attributes.COLOR_0), surface: readAccessor(attributes._SURFACE), indices: readAccessor(primitive.indices) };
});

function geometry(mesh) {
  const p = mesh.positions, f = mesh.indices, n = mesh.normals, edges = new Map();
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let volume = 0, minimumArea = Infinity, minimumNormal = Infinity;
  for (let at = 0; at < p.length; at++) { const axis = at % 3; min[axis] = Math.min(min[axis], p[at]); max[axis] = Math.max(max[axis], p[at]); }
  for (let at = 0; at < f.length; at += 3) {
    const ids = [f[at], f[at + 1], f[at + 2]], [a, b, c] = ids.map(id => [...p.subarray(id * 3, id * 3 + 3)]);
    const ab = b.map((v, i) => v - a[i]), ac = c.map((v, i) => v - a[i]);
    const cross = [ab[1]*ac[2]-ab[2]*ac[1], ab[2]*ac[0]-ab[0]*ac[2], ab[0]*ac[1]-ab[1]*ac[0]];
    const area2 = Math.hypot(...cross);
    minimumArea = Math.min(minimumArea, area2 / 2);
    const averageNormal = [0, 1, 2].map(axis => ids.reduce((sum, id) => sum + n[id * 3 + axis], 0) / 3);
    minimumNormal = Math.min(minimumNormal, cross.reduce((sum, value, axis) => sum + value * averageNormal[axis], 0) / area2);
    volume += (a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
    for (const [i, j] of [[ids[0], ids[1]], [ids[1], ids[2]], [ids[2], ids[0]]]) { const key = i < j ? `${i},${j}` : `${j},${i}`; edges.set(key, (edges.get(key) || 0) + 1); }
  }
  return { min, max, volume, minimumArea, minimumNormal, closed: [...edges.values()].every(value => value === 2) };
}

test('白百合GLB自包含、与文件摘要对应，没有背景矩形或外部贴图依赖', async () => {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67); assert.equal(bytes.readUInt32LE(4), 2); assert.equal(bytes.readUInt32LE(8), bytes.length);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a); assert.equal(bytes.readUInt32LE(jsonLength + 24), 0x004e4942);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256); assert.equal(bytes.length, metadata.bytes);
  assert.ok(bytes.length < 10 * 1024 * 1024);
  assert.ok(!gltf.images?.length && !gltf.textures?.length && !gltf.skins?.length && !gltf.animations?.length && !gltf.extensionsRequired?.length);
  assert.ok(gltf.buffers.every(buffer => !buffer.uri)); assert.equal(metadata.source.exactReconstruction, false); assert.equal(metadata.source.unseenBackInferred, true);
  const reference = await readFile(new URL('../public/examples/white-lily-reference.png', import.meta.url));
  assert.equal(createHash('sha256').update(reference).digest('hex'), metadata.source.referenceSha256);
});

test('每个独立器官都是有体积的闭合有效三角网格，法线与绕序一致', () => {
  let vertices = 0, triangles = 0;
  for (const mesh of meshes) {
    assert.equal(mesh.primitive.mode, 4); assert.equal(mesh.positions.length, mesh.normals.length); assert.equal(mesh.positions.length, mesh.colors.length);
    assert.ok(mesh.positions.every(Number.isFinite)); assert.ok(mesh.indices.every(value => Number.isInteger(value) && value >= 0 && value < mesh.positions.length / 3));
    for (let at = 0; at < mesh.normals.length; at += 3) assert.ok(Math.abs(Math.hypot(...mesh.normals.subarray(at, at + 3)) - 1) < 1e-6);
    const report = geometry(mesh);
    assert.equal(report.closed, true, `${mesh.name} 每条边恰好连接两面`); assert.ok(report.volume > 0, `${mesh.name} 体积与朝向`);
    assert.ok(report.minimumArea > 1e-12, `${mesh.name} 不退化`); assert.ok(report.minimumNormal > -.025, `${mesh.name} 法线朝外`);
    vertices += mesh.positions.length / 3; triangles += mesh.indices.length / 3;
  }
  assert.equal(vertices, metadata.vertices); assert.equal(triangles, metadata.triangles); assert.equal(meshes.length, metadata.meshCount);
});

test('六片独立白瓣有厚度与前后曲率，花药、花丝和三瓣柱头保留完整立体结构', () => {
  const petals = meshes.filter(mesh => mesh.extras.category === 'closed-petal'); assert.equal(petals.length, 6);
  const volumes = [], elevations = [];
  for (const petal of petals) {
    const report = geometry(petal); volumes.push(report.volume); elevations.push(report.max[2]);
    assert.ok(report.max[2] - report.min[2] > .35, `${petal.name} 具有明显立体弯曲`);
    assert.ok(report.volume > .004, `${petal.name} 具有真实薄实体厚度`);
  }
  assert.ok(Math.max(...elevations) - Math.min(...elevations) > .15, '花瓣前后层次不同');
  assert.ok(metadata.bounds.depthToWidth > .5, '花药伸出花心，背面花托保留深度');
  assert.equal(meshes.filter(mesh => mesh.extras.category === 'anther').length, 6);
  assert.equal(meshes.filter(mesh => mesh.extras.category === 'filament').length, 6);
  assert.equal(meshes.filter(mesh => mesh.extras.category === 'stigma').length, 3);
});

test('原色包含乳白瓣、淡绿喉部与棕红花药；SURFACE能区分器官和每瓣局部侵蚀', () => {
  let white = 0, green = 0, brown = 0; const regions = new Set();
  for (const mesh of meshes) {
    assert.equal(mesh.surface.length, mesh.positions.length); assert.ok(mesh.colors.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
    for (let at = 0; at < mesh.surface.length; at += 3) {
      assert.ok(mesh.surface[at] >= 0 && mesh.surface[at] <= 1); assert.ok(mesh.surface[at + 1] >= 0 && mesh.surface[at + 1] <= 1);
      assert.equal(mesh.surface[at + 2], mesh.extras.organ); assert.ok([0, 1, 2].includes(mesh.surface[at + 2]));
      const [r, g, b] = [...mesh.colors.subarray(at, at + 3)].map(sRGB);
      if (mesh.extras.organ === 0 && Math.min(r, g, b) > .65 && Math.max(r, g, b) - Math.min(r, g, b) < .18) white++;
      if (g > r * 1.04 && g > b * 1.3) green++;
      if (mesh.extras.category === 'anther' && r > g * 1.6 && g > b * 1.3 && r > .35 && r < .7) brown++;
    }
    if (mesh.extras.organ === 0) { regions.add(mesh.surface[0]); assert.equal(mesh.extras.category, 'closed-petal'); }
  }
  assert.equal(regions.size, 6); assert.ok(white > 20000, '主体保留大片白色'); assert.ok(green > 500, '花喉与花丝有淡绿'); assert.ok(brown > 1000, '棕红色花药不丢失');
});

test('花丝、雌蕊和后茎的环截面连续旋转，不因坐标参考轴切换出现扭接', () => {
  for (const mesh of meshes.filter(item => ['filament', 'pistil', 'pedicel'].includes(item.extras.category))) {
    const sides = { filament: 12, pistil: 16, pedicel: 14 }[mesh.extras.category];
    const rings = (mesh.positions.length / 3 - 2) / sides;
    assert.ok(Number.isInteger(rings) && rings > 10);
    let previous;
    for (let ring = 0; ring < rings; ring++) {
      const center = [0, 0, 0];
      for (let side = 0; side < sides; side++) for (let axis = 0; axis < 3; axis++) center[axis] += mesh.positions[(ring * sides + side) * 3 + axis] / sides;
      const radial = [0, 1, 2].map(axis => mesh.positions[ring * sides * 3 + axis] - center[axis]);
      const length = Math.hypot(...radial); const direction = radial.map(value => value / length);
      assert.ok(length > .005);
      if (previous) assert.ok(direction.reduce((sum, value, axis) => sum + value * previous[axis], 0) > .8, `${mesh.name} 相邻截面没有翻转`);
      previous = direction;
    }
  }
});

test('Three.js真实GLTFLoader重新读取后保留所有独立几何、原色、法线与器官属性', async () => {
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const loaded = await new GLTFLoader().parseAsync(data, ''); let count = 0, vertices = 0;
  loaded.scene.traverse(object => {
    if (!object.isMesh) return;
    count++; const geometry = object.geometry; vertices += geometry.getAttribute('position').count;
    assert.ok(geometry.getAttribute('normal')); assert.ok(geometry.getAttribute('color')); assert.ok(geometry.getAttribute('_surface'));
    assert.equal(object.material.vertexColors, true); assert.equal(object.material.side, 0);
    geometry.dispose(); object.material.dispose();
  });
  assert.equal(count, metadata.meshCount); assert.equal(vertices, metadata.vertices);
});
