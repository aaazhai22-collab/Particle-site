import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const bytes = await readFile(new URL('../public/examples/petal-model.glb', import.meta.url));
const metadata = JSON.parse(await readFile(new URL('../public/examples/petal-model-metadata.json', import.meta.url), 'utf8'));
const jsonLength = bytes.readUInt32LE(12);
const gltf = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
const bin = bytes.subarray(jsonLength + 28);
const srgb = value => value <= .0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - .055;

function accessor(index) {
  const entry = gltf.accessors[index], view = gltf.bufferViews[entry.bufferView];
  const components = entry.type === 'VEC3' ? 3 : entry.type === 'SCALAR' ? 1 : 0;
  const size = { 5123: 2, 5125: 4, 5126: 4 }[entry.componentType];
  assert.ok(components && size);
  const stride = view.byteStride || components * size;
  const start = (view.byteOffset || 0) + (entry.byteOffset || 0);
  assert.ok(start + (entry.count - 1) * stride + components * size <= bin.length, 'accessor 在真实 BIN 边界内');
  const values = new Float64Array(entry.count * components);
  for (let vertex = 0; vertex < entry.count; vertex++) for (let axis = 0; axis < components; axis++) {
    const at = start + vertex * stride + axis * size;
    values[vertex * components + axis] = entry.componentType === 5126 ? bin.readFloatLE(at) : entry.componentType === 5125 ? bin.readUInt32LE(at) : bin.readUInt16LE(at);
  }
  return values;
}

const meshes = gltf.meshes.map(mesh => {
  assert.equal(mesh.primitives.length, 1);
  const primitive = mesh.primitives[0];
  return { name: mesh.name, primitive, extras: mesh.extras, positions: accessor(primitive.attributes.POSITION),
    normals: accessor(primitive.attributes.NORMAL), colors: accessor(primitive.attributes.COLOR_0),
    surface: accessor(primitive.attributes._SURFACE), indices: accessor(primitive.indices) };
});

function geometryReport(mesh) {
  const { positions: p, indices: f, normals: n } = mesh;
  const edges = new Map(); let volume = 0, minArea = Infinity, minNormal = Infinity;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let at = 0; at < p.length; at++) { const axis = at % 3; min[axis] = Math.min(min[axis], p[at]); max[axis] = Math.max(max[axis], p[at]); }
  for (let at = 0; at < f.length; at += 3) {
    const a = f[at] * 3, b = f[at + 1] * 3, c = f[at + 2] * 3;
    const ab = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const ac = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const area2 = Math.hypot(...cross);
    minArea = Math.min(minArea, area2 / 2);
    const normal = [0, 1, 2].map(axis => (n[a + axis] + n[b + axis] + n[c + axis]) / 3);
    minNormal = Math.min(minNormal, cross.reduce((sum, value, axis) => sum + value * normal[axis], 0) / area2);
    volume += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) +
      p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
    for (const [i, j] of [[f[at], f[at + 1]], [f[at + 1], f[at + 2]], [f[at + 2], f[at]]]) {
      const key = i < j ? `${i},${j}` : `${j},${i}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  return { volume, minArea, minNormal, min, max, closed: [...edges.values()].every(count => count === 2) };
}

test('粉色完整花头 GLB 为自包含静态多网格，完全没有照片平面或外部资源', () => {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67);
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  assert.equal(bytes.readUInt32LE(jsonLength + 24), 0x004e4942);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256);
  assert.equal(bytes.length, metadata.bytes);
  assert.ok(bytes.length < 8 * 1024 * 1024);
  assert.equal(gltf.asset.version, '2.0');
  assert.ok(!gltf.images?.length && !gltf.textures?.length && !gltf.skins?.length && !gltf.animations?.length);
  assert.ok(!gltf.extensionsRequired?.length);
  assert.ok(gltf.buffers.every(buffer => !buffer.uri));
  assert.equal(gltf.nodes.length, meshes.length);
  assert.equal(new Set(meshes.map(mesh => mesh.name)).size, meshes.length);
  assert.ok(gltf.materials.every(material => !material.doubleSided && material.pbrMetallicRoughness.baseColorFactor.every(value => value === 1)));
});

test('真实三角面、法线和闭合拓扑全部有效，所有独立器官朝外且有非零体积', () => {
  let triangles = 0, vertices = 0;
  for (const mesh of meshes) {
    assert.equal(mesh.primitive.mode, 4);
    assert.ok(mesh.positions.every(Number.isFinite));
    assert.equal(mesh.positions.length, mesh.normals.length);
    assert.equal(mesh.positions.length, mesh.colors.length);
    assert.ok(mesh.indices.every(index => Number.isInteger(index) && index >= 0 && index < mesh.positions.length / 3));
    for (let at = 0; at < mesh.normals.length; at += 3) assert.ok(Math.abs(Math.hypot(...mesh.normals.subarray(at, at + 3)) - 1) < 1e-6);
    const report = geometryReport(mesh);
    assert.equal(report.closed, true, `${mesh.name} 每条边必须恰好有两个相邻面`);
    assert.ok(report.minArea > 1e-12, `${mesh.name} 没有零面积三角面`);
    assert.ok(report.volume > 0, `${mesh.name} 闭合表面向外绕序`);
    assert.ok(report.minNormal > -.025, `${mesh.name} 法线与绕序一致`);
    triangles += mesh.indices.length / 3; vertices += mesh.positions.length / 3;
  }
  assert.equal(triangles, metadata.triangles);
  assert.equal(vertices, metadata.vertices);
  assert.equal(meshes.length, metadata.meshCount);
  assert.ok(triangles > 70000 && triangles < 200000);
});

test('六片独立宽瓣具有明显曲面、卷边、双面厚度和完整立体深度', () => {
  const petals = meshes.filter(mesh => mesh.extras.category === 'closed-petal');
  assert.equal(petals.length, 6);
  assert.equal(metadata.petalCount, petals.length);
  for (const mesh of petals) {
    const report = geometryReport(mesh);
    assert.ok(report.max[2] - report.min[2] > .38, `${mesh.name} 不是平面花瓣`);
    assert.ok(report.volume > .03, `${mesh.name} 有真实薄壳厚度`);
    const points = mesh.positions, count = points.length / 3;
    let sx = 0, sy = 0, xx = 0, yy = 0, xy = 0;
    for (let at = 0; at < points.length; at += 3) { const x = points[at], y = points[at + 1]; sx += x; sy += y; xx += x * x; yy += y * y; xy += x * y; }
    const a = xx / count - (sx / count) ** 2, b = yy / count - (sy / count) ** 2, c = xy / count - sx * sy / count ** 2;
    const spread = Math.sqrt((a - b) ** 2 + 4 * c * c);
    assert.ok((a + b - spread) / (a + b + spread) > .45, `${mesh.name} 是宽阔卵圆瓣，不能是狭窄叶片风车`);
  }
  assert.ok(metadata.bounds.depthToWidth > .34);
  assert.ok(metadata.bounds.size[0] / metadata.bounds.size[1] > .9 && metadata.bounds.size[0] / metadata.bounds.size[1] < 1.2);
});

test('_SURFACE 与每个顶点一一对应，独立花瓣 region 不同，卷边权重升高，organ 分类明确', () => {
  const regions = new Set();
  for (const mesh of meshes) {
    const surface = mesh.surface;
    assert.equal(surface.length, mesh.positions.length);
    let minimum = 1, maximum = 0;
    for (let at = 0; at < surface.length; at += 3) {
      assert.ok(surface[at] >= 0 && surface[at] <= 1 && Number.isFinite(surface[at]));
      assert.ok(surface[at + 1] >= 0 && surface[at + 1] <= 1 && Number.isFinite(surface[at + 1]));
      assert.ok([0, 1, 2].includes(surface[at + 2]));
      assert.equal(surface[at + 2], mesh.extras.organ);
      if (mesh.extras.category === 'closed-petal') assert.equal(surface[at], surface[0]);
      minimum = Math.min(minimum, surface[at + 1]); maximum = Math.max(maximum, surface[at + 1]);
    }
    if (mesh.extras.category === 'closed-petal') {
      regions.add(surface[0]);
      assert.equal(minimum, 0);
      assert.equal(maximum, 1);
      assert.equal(mesh.extras.organ, 0);
    }
    assert.equal(gltf.accessors[mesh.primitive.attributes._SURFACE].type, 'VEC3');
    assert.equal(gltf.accessors[mesh.primitive.attributes._SURFACE].componentType, 5126);
  }
  assert.equal(regions.size, 6);
});

test('顶点原色保留粉奶渐变和黄橙密集花蕊，不使用黑色矩形填补轮廓', () => {
  for (const mesh of meshes) assert.ok(mesh.colors.every(value => value >= 0 && value <= 1 && Number.isFinite(value)));
  const petals = meshes.filter(mesh => mesh.extras.organ === 0);
  let pale = 0, pink = 0;
  for (const mesh of petals) for (let at = 0; at < mesh.colors.length; at += 3) {
    const [r, g, b] = [...mesh.colors.subarray(at, at + 3)].map(srgb);
    assert.ok(r > .7 && b > .35 && r > b && b > g, '每个花瓣顶点都来自真实粉色或奶白色曲面');
    if (g > .74 && r > .95) pale++;
    if (g < .58 && b > .45) pink++;
  }
  assert.ok(pale > 1000 && pink > 1000, '同时保留奶白高光区域与较浓粉色区域');
  const filaments = meshes.filter(mesh => mesh.extras.category === 'filament');
  const anthers = meshes.filter(mesh => mesh.extras.category === 'anther');
  assert.equal(filaments.length, 108);
  assert.equal(anthers.length, 108);
  const quadrants = [0, 0, 0, 0]; let low = Infinity, high = -Infinity;
  for (const mesh of anthers) {
    const report = geometryReport(mesh);
    const x = (report.min[0] + report.max[0]) / 2, y = (report.min[1] + report.max[1]) / 2;
    quadrants[(x > 0 ? 1 : 0) + (y > 0 ? 2 : 0)]++;
    low = Math.min(low, report.min[2]); high = Math.max(high, report.max[2]);
    const color = [...mesh.colors.subarray(0, 3)].map(srgb);
    assert.ok(color[0] > .8 && color[1] > .4 && color[1] < .8 && color[2] < .3, '花药有真实暖橙黄原色');
  }
  assert.ok(quadrants.every(count => count > 20));
  assert.ok(high - low > .2 && high > .7, '花蕊高低不一并明显伸出花托');
});

test('第二版配色为奶白浅粉根部和饱和深粉外沿，卷边与朝向层次各不相同', () => {
  assert.ok(metadata.version >= 2);
  const petals = meshes.filter(mesh => mesh.extras.category === 'closed-petal');
  const lifts = [];
  for (const mesh of petals) {
    let insideG = 0, outsideG = 0, insideChroma = 0, outsideChroma = 0, insideCount = 0, outsideCount = 0;
    for (let at = 0; at < mesh.positions.length; at += 3) {
      const radius = Math.hypot(mesh.positions[at], mesh.positions[at + 1]);
      const [r, g] = [...mesh.colors.subarray(at, at + 2)].map(srgb);
      if (radius < .75) { insideG += g; insideChroma += r - g; insideCount++; }
      if (radius > 1.65) { outsideG += g; outsideChroma += r - g; outsideCount++; }
    }
    assert.ok(insideCount > 50 && outsideCount > 50);
    assert.ok(insideG / insideCount > outsideG / outsideCount + .22, `${mesh.name} 应从内奶白向外深粉渐变`);
    assert.ok(outsideChroma / outsideCount > insideChroma / insideCount + .15, `${mesh.name} 外沿粉色更饱和`);
    const report = geometryReport(mesh);
    lifts.push(report.max[2]);
  }
  assert.ok(Math.max(...lifts) - Math.min(...lifts) > .35, '每瓣抬升不同，避免整齐平展的单层花盘');
});

test('真实 GLTFLoader 保留线性原色、所有 _SURFACE 数据与清楚的静态网格名称', async () => {
  const loaded = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const actual = [];
  loaded.scene.traverse(object => { if (object.isMesh) actual.push(object); });
  assert.equal(actual.length, meshes.length);
  for (const object of actual) {
    const source = meshes.find(mesh => mesh.name === object.name);
    assert.ok(source);
    assert.equal(object.geometry.getAttribute('position').count, source.positions.length / 3);
    assert.equal(object.geometry.getAttribute('_surface').count, source.surface.length / 3);
    assert.equal(object.material.vertexColors, true);
    assert.equal(object.material.side, THREE.FrontSide);
    assert.deepEqual([...object.geometry.getAttribute('_surface').array], [...source.surface]);
    assert.deepEqual([...object.geometry.getAttribute('color').array], [...source.colors]);
    object.geometry.dispose(); object.material.dispose();
  }
});

test('正面、侧面、背面和四分之三视角都生成独立的真实 PNG 预览', async () => {
  const hashes = new Set();
  for (const view of ['front', 'side', 'back', 'three-quarter']) {
    const png = await readFile(new URL(`../public/examples/petal-preview-${view}.png`, import.meta.url));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), 1024); assert.equal(png.readUInt32BE(20), 1024);
    assert.ok(png.length > 50000, `${view} 预览包含实际彩色花朵画面`);
    hashes.add(createHash('sha256').update(png).digest('hex'));
  }
  assert.equal(hashes.size, 4);
});
