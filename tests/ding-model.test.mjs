import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import ts from 'typescript';

const bytes = await readFile(new URL('../public/examples/ding-model.glb', import.meta.url));
const metadata = JSON.parse(await readFile(new URL('../public/examples/ding-model-metadata.json', import.meta.url), 'utf8'));
const jsonLength = bytes.readUInt32LE(12);
const gltf = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
const bin = bytes.subarray(28 + jsonLength);

async function importSource(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  outputText = outputText.replace(/from (['"])(three(?:\/[^'"]*)?)\1/g, (_, quote, name) => `from ${JSON.stringify(import.meta.resolve(name))}`);
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}

const assets = await importSource('../src/assets.ts');
const animation = await importSource('../src/animation.ts');

function accessor(index) {
  const entry = gltf.accessors[index];
  assert.ok(entry, `accessor ${index} 存在`);
  assert.equal(entry.sparse, undefined, '本示例不使用稀疏 accessor');
  const view = gltf.bufferViews[entry.bufferView];
  assert.ok(view, `accessor ${index} 的 bufferView 存在`);
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[entry.type];
  const sizes = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
  const size = sizes[entry.componentType];
  assert.ok(components && size, `accessor ${index} 使用受支持类型`);
  const stride = view.byteStride || components * size;
  const start = (view.byteOffset || 0) + (entry.byteOffset || 0);
  assert.ok(stride >= components * size);
  assert.ok((entry.byteOffset || 0) + (entry.count - 1) * stride + components * size <= view.byteLength, 'accessor 未越过 bufferView');
  const result = new Float64Array(entry.count * components);
  for (let vertex = 0; vertex < entry.count; vertex++) for (let axis = 0; axis < components; axis++) {
    const at = start + vertex * stride + axis * size;
    result[vertex * components + axis] = entry.componentType === 5126 ? bin.readFloatLE(at) : entry.componentType === 5125 ? bin.readUInt32LE(at) : entry.componentType === 5123 ? bin.readUInt16LE(at) : bin[at];
  }
  return result;
}

// Node 没有原生 JPEG / canvas 解码。本回归检查实际内嵌 JPEG 头和 UV，
// 再用 GLTFLoader 读取同一 BIN 中的实际几何；只在该几何测试副本上移除贴图引用。
// 不以伪造的 bitmap 像素声称“原色读取成功”。实际 JPEG 颜色需浏览器验收。
async function loadGeometryScene() {
  const geometryDocument = structuredClone(gltf);
  for (const material of geometryDocument.materials) delete material.pbrMetallicRoughness.baseColorTexture;
  const json = Buffer.from(JSON.stringify(geometryDocument));
  const paddedJson = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20); json.copy(paddedJson);
  const packed = Buffer.alloc(28 + paddedJson.length + bin.length);
  packed.writeUInt32LE(0x46546c67, 0); packed.writeUInt32LE(2, 4); packed.writeUInt32LE(packed.length, 8);
  packed.writeUInt32LE(paddedJson.length, 12); packed.writeUInt32LE(0x4e4f534a, 16); paddedJson.copy(packed, 20);
  packed.writeUInt32LE(bin.length, 20 + paddedJson.length); packed.writeUInt32LE(0x004e4942, 24 + paddedJson.length); bin.copy(packed, 28 + paddedJson.length);
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => { throw new Error(`几何读取不应请求外部资源：${url}`); });
  const loaded = await new GLTFLoader(manager).parseAsync(packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength), '');
  return loaded;
}

let sampled;
async function actualGeometryAsset() {
  if (sampled) return sampled;
  const loaded = await loadGeometryScene();
  try { sampled = assets.sampleModelScene(loaded.scene, '青铜方鼎.glb'); return sampled; }
  finally { assets.disposeAssetScenes(loaded.scenes); }
}

test('鼎 GLB 为完整自包含静态 glTF 2.0，文件与三角数在浏览器导入限制内', () => {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67);
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  assert.equal(bytes.readUInt32LE(24 + jsonLength), 0x004e4942);
  assert.equal(bytes.readUInt32LE(20 + jsonLength), bin.length);
  assert.equal(gltf.asset.version, '2.0');
  assert.equal(metadata.fileBytes, bytes.length);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.outputSha256);
  assert.ok(bytes.length < 100 * 1024 * 1024, '低于素材导入的 100 MiB 限制');
  assert.ok(!gltf.skins?.length && !gltf.animations?.length && !gltf.extensionsRequired?.length);
  assert.equal(gltf.buffers.length, 1);
  assert.ok(gltf.buffers.every(buffer => !buffer.uri));
  assert.ok(gltf.buffers[0].byteLength <= bin.length && bin.length - gltf.buffers[0].byteLength <= 3);
  for (const view of gltf.bufferViews) {
    assert.equal(view.buffer, 0);
    assert.ok(view.byteLength > 0 && (view.byteOffset || 0) + view.byteLength <= gltf.buffers[0].byteLength, '所有 bufferView 位于内嵌 BIN 中');
  }
});

test('四足、双耳、敞口器身和四面浮雕保留实际有效三角面及对应 UV', () => {
  assert.equal(gltf.meshes.length, metadata.originalMeshCount, '简化后没有丢弃小型装饰网格');
  const names = gltf.nodes.map(node => node.name || '');
  for (const name of ['Bird_Front_Left_Core', 'Bird_Front_Right_Core', 'Bird_Rear_Left_Core', 'Bird_Rear_Right_Core']) assert.ok(names.includes(name), name);
  for (const name of ['Left handle', 'Right handle', 'Hollow vessel']) assert.ok(names.some(candidate => candidate.endsWith(name)), name);
  for (const side of ['Front', 'Back', 'Left', 'Right']) assert.ok(names.some(name => name.startsWith(`Relief_${side}_`)), `${side} 浮雕`);
  let triangles = 0;
  for (const mesh of gltf.meshes) for (const primitive of mesh.primitives) {
    assert.equal(primitive.mode ?? 4, 4);
    assert.ok(!primitive.targets?.length, '无形变目标');
    const position = accessor(primitive.attributes.POSITION), indices = accessor(primitive.indices);
    const uv = accessor(primitive.attributes.TEXCOORD_0), normal = accessor(primitive.attributes.NORMAL);
    assert.ok(position.length > 0 && position.length % 3 === 0 && indices.length % 3 === 0);
    assert.equal(normal.length, position.length);
    assert.equal(uv.length, position.length / 3 * 2);
    assert.ok(position.every(Number.isFinite) && normal.every(Number.isFinite) && uv.every(Number.isFinite), `${mesh.name} 的属性有效`);
    assert.ok(indices.every(index => Number.isInteger(index) && index >= 0 && index < position.length / 3), `${mesh.name} 的索引有效`);
    assert.ok(gltf.materials[primitive.material]?.pbrMetallicRoughness.baseColorTexture, `${mesh.name} 的原色材质存在`);
    triangles += indices.length / 3;
  }
  assert.equal(triangles, metadata.exportedTriangles);
  assert.equal(triangles, metadata.finalTriangles);
  assert.ok(triangles >= 180000 && triangles < 1000000, `有效三角面 ${triangles} 未超导入上限`);
});

test('四套基础色贴图完整内嵌且尺寸可被真实导入器安全读取', () => {
  assert.equal(gltf.materials.length, 4); assert.equal(gltf.materials.length, metadata.materials);
  assert.equal(gltf.images.length, 4); assert.equal(metadata.textures.length, 4);
  const usedImages = new Set();
  for (const material of gltf.materials) {
    const texture = gltf.textures[material.pbrMetallicRoughness.baseColorTexture.index];
    assert.ok(texture); usedImages.add(texture.source);
  }
  assert.equal(usedImages.size, 4, '四类材质均引用独立的原始基础色贴图');
  for (const [index, image] of gltf.images.entries()) {
    assert.ok(!image.uri && Number.isInteger(image.bufferView), '图片不依赖外部路径');
    assert.ok(['image/jpeg', 'image/png'].includes(image.mimeType));
    const view = gltf.bufferViews[image.bufferView];
    const encoded = bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
    const { width, height } = assets.readImageDimensions(encoded);
    assert.deepEqual([width, height], [2048, 2048]);
    assert.ok(width * height <= 36000000, `贴图 ${index} 低于解码安全限制`);
    assert.ok(encoded.length > 10000, '贴图包含实际编码数据');
    if (image.mimeType === 'image/jpeg') {
      assert.equal(encoded.readUInt16BE(0), 0xffd8);
      assert.equal(encoded.readUInt16BE(encoded.length - 2), 0xffd9, 'JPEG 有完整终止标记');
    }
  }
});

test('GLTFLoader 读取实际几何保持源模型比例及 Y 向上的立体深度', async () => {
  const loaded = await loadGeometryScene();
  try {
    const bounds = new THREE.Box3().setFromObject(loaded.scene);
    for (const axis of ['x', 'y', 'z']) {
      const index = ['x', 'y', 'z'].indexOf(axis);
      assert.ok(Math.abs(bounds.min[axis] - metadata.exportedBoundsYUp.min[index]) < 1e-5);
      assert.ok(Math.abs(bounds.max[axis] - metadata.exportedBoundsYUp.max[index]) < 1e-5);
    }
    const size = bounds.getSize(new THREE.Vector3());
    assert.ok(Math.abs(size.x / size.y - .8) < .001, '宽高比保持 0.4 : 0.5');
    assert.ok(Math.abs(size.z / size.y - .6) < .001, '真实深度保持 0.3 : 0.5');
  } finally { assets.disposeAssetScenes(loaded.scenes); }
});

test('真实鼎表面采样产生 100k 有限粒子，居中、完整覆盖前后与四足', async () => {
  const asset = await actualGeometryAsset();
  assert.equal(asset.kind, 'model'); assert.equal(asset.count, 100000);
  assert.equal(asset.positions.length, 300000); assert.equal(asset.colors.length, 300000); assert.equal(asset.seeds.length, 300000);
  assert.deepEqual(asset.notes, [], '无退化面、无效坐标或不支持对象的回退警告');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]; let radius = 0;
  for (let index = 0; index < asset.count; index++) {
    const point = asset.positions.subarray(index * 3, index * 3 + 3);
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(Number.isFinite(point[axis]));
      min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]);
    }
    radius = Math.max(radius, Math.hypot(...point));
  }
  for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(min[axis] + max[axis]) < 1e-6, '各轴 AABB 中心在原点');
  assert.ok(radius > 1.34999 && radius <= 1.350001);
  assert.ok((max[2] - min[2]) / (max[0] - min[0]) > .7, '采样结果保留鼎的前后深度');
  const feet = new Uint32Array(4), surfaces = new Uint32Array(2);
  for (let index = 0; index < asset.count; index++) {
    const [x, y, z] = asset.positions.subarray(index * 3, index * 3 + 3);
    if (y < min[1] + (max[1] - min[1]) * .2) feet[(x > 0 ? 1 : 0) + (z > 0 ? 2 : 0)]++;
    if (Math.abs(z) > (max[2] - min[2]) * .3) surfaces[z > 0 ? 1 : 0]++;
  }
  assert.ok(feet.every(count => count > 100), `四足采样均存在：${[...feet]}`);
  assert.ok(surfaces.every(count => count > 5000), `正背表面均存在：${[...surfaces]}`);
});

test('16 秒展示先稳定原形、转向、消散再还原，首尾可无跳变循环', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let expression;
  for (const statement of tree.statements) if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
    if (declaration.name.getText(tree) === 'DING_CLIP') expression = declaration.initializer?.getText(tree);
  }
  assert.ok(expression, '内置鼎展示片段存在');
  const compiled = ts.transpileModule(`export const clip = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const { clip } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
  assert.equal(clip.duration, 16);
  assert.deepEqual(animation.normalizeClip(clip), clip, '所有关键帧无需被限制修复');
  for (const time of [0, 1.5, 3]) assert.deepEqual(animation.sampleClip(clip, time), { progress: 0, scale: 1, rotation: [0, 0, 0] });
  assert.deepEqual(animation.sampleClip(clip, 6), { progress: 0, scale: 1, rotation: [0, 32, 0] });
  for (const time of [10.8, 11.2, 11.6]) assert.equal(animation.sampleClip(clip, time).progress, 1);
  for (const time of [14, 15, 16]) assert.deepEqual(animation.sampleClip(clip, time), animation.sampleClip(clip, 0));
  assert.deepEqual(animation.clipLoopSeam(clip), { continuous: true, mismatches: [] }, '首尾形态相同');
});
