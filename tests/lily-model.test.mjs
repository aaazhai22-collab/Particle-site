import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { test } from 'node:test';
import ts from 'typescript';

const limitsSource = await readFile(new URL('../src/particleLimits.ts', import.meta.url), 'utf8');
const limitsURL = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(limitsSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64')}`;
const { MAX_PARTICLES } = await import(limitsURL);
// 检查真实 GLB 文件与真实采样函数。Node 中用 PNG 解码后的实际像素
// 提供最小 bitmap / canvas 读取表面；这里不声称 WebGL 或浏览器录像通过。
const bytes = await readFile(new URL('../public/examples/lily-model.glb', import.meta.url));
const metadata = JSON.parse(await readFile(new URL('../public/examples/lily-model-metadata.json', import.meta.url), 'utf8'));
assert.equal(bytes.readUInt32LE(0), 0x46546c67);
const jsonLength = bytes.readUInt32LE(12);
const gltf = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
const bin = bytes.subarray(28 + jsonLength);
const source = await readFile(new URL('../src/assets.ts', import.meta.url), 'utf8');
let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
outputText = outputText.replace(/from (['"])(three(?:\/[^'"]*)?)\1/g, (_, quote, name) => `from ${JSON.stringify(import.meta.resolve(name))}`);
outputText = outputText.replace(/from (['"])\.\/particleLimits\1/g, () => `from ${JSON.stringify(limitsURL)}`);
const assets = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

function accessor(index) {
  const entry = gltf.accessors[index], view = gltf.bufferViews[entry.bufferView];
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[entry.type];
  const size = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 }[entry.componentType];
  assert.ok(components && size, '样本使用支持的 accessor 类型');
  const stride = view.byteStride || components * size;
  const offset = (view.byteOffset || 0) + (entry.byteOffset || 0);
  const values = [];
  for (let vertex = 0; vertex < entry.count; vertex++) for (let axis = 0; axis < components; axis++) {
    const at = offset + vertex * stride + axis * size;
    values.push(entry.componentType === 5126 ? bin.readFloatLE(at) : entry.componentType === 5125 ? bin.readUInt32LE(at) : entry.componentType === 5123 ? bin.readUInt16LE(at) : bin[at]);
  }
  return values;
}

function pngPixels(data) {
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20), depth = data[24], type = data[25];
  assert.equal(depth, 8, '当前 atlas 是 8 位 PNG');
  assert.ok(type === 2 || type === 6, '当前 atlas 是 RGB / RGBA PNG');
  assert.equal(data[28], 0, '当前 atlas 没有交错扫描');
  const parts = [];
  for (let offset = 8; offset < data.length;) {
    const length = data.readUInt32BE(offset), name = data.toString('ascii', offset + 4, offset + 8);
    assert.ok(offset + length + 12 <= data.length, 'PNG chunk 完整');
    if (name === 'IDAT') parts.push(data.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const channels = type === 6 ? 4 : 3, rowBytes = width * channels;
  const filtered = inflateSync(Buffer.concat(parts));
  assert.equal(filtered.length, height * (rowBytes + 1));
  const unfiltered = new Uint8Array(height * rowBytes);
  const paeth = (left, above, upperLeft) => {
    const prediction = left + above - upperLeft;
    const a = Math.abs(prediction - left), b = Math.abs(prediction - above), c = Math.abs(prediction - upperLeft);
    return a <= b && a <= c ? left : b <= c ? above : upperLeft;
  };
  for (let row = 0; row < height; row++) {
    const filter = filtered[row * (rowBytes + 1)];
    assert.ok(filter <= 4);
    for (let column = 0; column < rowBytes; column++) {
      const at = row * rowBytes + column;
      const left = column >= channels ? unfiltered[at - channels] : 0;
      const above = row ? unfiltered[at - rowBytes] : 0;
      const upperLeft = row && column >= channels ? unfiltered[at - rowBytes - channels] : 0;
      const prediction = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, upperLeft);
      unfiltered[at] = (filtered[row * (rowBytes + 1) + column + 1] + prediction) & 255;
    }
  }
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) pixels.set([unfiltered[pixel * channels], unfiltered[pixel * channels + 1], unfiltered[pixel * channels + 2], channels === 4 ? unfiltered[pixel * channels + 3] : 255], pixel * 4);
  return { width, height, pixels };
}

function imageBytes(index = 0) {
  const view = gltf.bufferViews[gltf.images[index].bufferView];
  return bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
}

async function loadWithDecodedPixels() {
  const saved = [], bitmaps = [];
  const replace = (name, value) => {
    saved.push([name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  replace('self', globalThis);
  replace('createImageBitmap', async blob => {
    const bitmap = { ...pngPixels(Buffer.from(await blob.arrayBuffer())), closed: false, close() { this.closed = true; } };
    bitmaps.push(bitmap);
    return bitmap;
  });
  replace('document', {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      let bitmap = null;
      const canvas = { width: 1, height: 1, getContext: () => ({
        drawImage(source, x, y, width, height) { assert.equal(width, source.width); assert.equal(height, source.height); bitmap = source; },
        getImageData() { return { data: bitmap.pixels }; },
      }) };
      return canvas;
    },
  });
  try {
    const asset = await assets.loadParticleAsset(new File([bytes], 'lily-model.glb'));
    assert.ok(bitmaps.length > 0, '真正解码了内嵌 PNG，没有跳过贴图');
    assert.ok(bitmaps.every(bitmap => bitmap.closed), '采样结束释放 bitmap');
    return asset;
  } finally {
    for (const [name, descriptor] of saved.reverse()) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

let sampled;
const actualAsset = async () => sampled ??= await loadWithDecodedPixels();
const srgb = value => value <= .0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - .055;

test('GLB 是完整静态 2.0 多网格，图像与几何完全内嵌', () => {
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  assert.equal(bytes.readUInt32LE(24 + jsonLength), 0x004e4942);
  assert.equal(gltf.asset.version, '2.0');
  assert.equal(gltf.meshes.length, metadata.meshCount);
  assert.equal(gltf.meshes.length, 44);
  assert.ok(!gltf.skins?.length && !gltf.animations?.length);
  assert.ok(!gltf.extensionsRequired?.length);
  assert.ok(gltf.buffers.every(buffer => !buffer.uri));
  assert.ok(gltf.images.every(image => image.mimeType === 'image/png' && image.bufferView !== undefined && !image.uri));
});

test('两朵花各六个独立花瓣，器官与叶片都有有效三角网格', () => {
  assert.equal(gltf.nodes.filter(node => /lily-front-petal-/.test(node.name)).length, 6);
  assert.equal(gltf.nodes.filter(node => /lily-rear-petal-/.test(node.name)).length, 6);
  let triangles = 0, vertices = 0;
  for (const mesh of gltf.meshes) for (const primitive of mesh.primitives) {
    assert.equal(primitive.mode ?? 4, 4);
    const position = accessor(primitive.attributes.POSITION), indices = accessor(primitive.indices);
    assert.ok(position.every(Number.isFinite));
    assert.ok(position.length > 0 && position.length % 3 === 0 && indices.length % 3 === 0);
    assert.ok(indices.every(index => Number.isInteger(index) && index >= 0 && index < position.length / 3));
    assert.equal(accessor(primitive.attributes.NORMAL).length, position.length);
    if (mesh.name.includes('petal')) {
      assert.equal(accessor(primitive.attributes.TEXCOORD_0).length, position.length / 3 * 2);
      // 闭合薄壳的有符号体积必须为正，防止镜像坐标变换后仍用旧绕序。
      let signedVolume = 0;
      for (let triangle = 0; triangle < indices.length; triangle += 3) {
        const a = indices[triangle] * 3, b = indices[triangle + 1] * 3, c = indices[triangle + 2] * 3;
        signedVolume += (position[a] * (position[b + 1] * position[c + 2] - position[b + 2] * position[c + 1]) +
          position[a + 1] * (position[b + 2] * position[c] - position[b] * position[c + 2]) +
          position[a + 2] * (position[b] * position[c + 1] - position[b + 1] * position[c])) / 6;
      }
      assert.ok(signedVolume > 1e-6, `${mesh.name} 花瓣薄壳应向外绕序，实际体积 ${signedVolume}`);
    }
    triangles += indices.length / 3; vertices += position.length / 3;
  }
  assert.equal(triangles, metadata.triangles);
  assert.equal(vertices, metadata.vertices);
});

test('照片来源保持原字节，真实 atlas PNG 解码为 1024 × 1536 彩色像素', async () => {
  const photograph = await readFile(new URL('../public/examples/lily-reference.jpg', import.meta.url));
  assert.equal(createHash('sha256').update(photograph).digest('hex'), metadata.source.sha256);
  const image = pngPixels(imageBytes());
  assert.deepEqual([image.width, image.height], metadata.textures.atlasSize);
  assert.deepEqual([image.width, image.height], [1024, 1536]);
  let colored = 0;
  for (let i = 0; i < image.pixels.length; i += 4) if (Math.max(image.pixels[i], image.pixels[i + 1], image.pixels[i + 2]) - Math.min(image.pixels[i], image.pixels[i + 1], image.pixels[i + 2]) > 30) colored++;
  assert.ok(colored > image.width * image.height * .1, 'atlas 包含彩色花瓣，不能是空白贴图');
});

test('真实 loadParticleAsset 生成 500k 原色样本，居中并保持非平面 Z 厚度', async () => {
  const asset = await actualAsset();
  assert.equal(asset.kind, 'model'); assert.equal(asset.count, MAX_PARTICLES); assert.equal(asset.hasOriginalColors, true);
  assert.equal(asset.positions.length, MAX_PARTICLES * 3); assert.equal(asset.colors.length, MAX_PARTICLES * 3); assert.equal(asset.seeds.length, MAX_PARTICLES * 3);
  assert.ok(asset.notes.every(note => !/贴图.*失败|贴图无法读取/.test(note)), asset.notes.join('；'));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]; let radius = 0;
  for (let i = 0; i < asset.count; i++) {
    for (let axis = 0; axis < 3; axis++) { const value = asset.positions[i * 3 + axis]; assert.ok(Number.isFinite(value)); min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value); }
    radius = Math.max(radius, Math.hypot(...asset.positions.subarray(i * 3, i * 3 + 3)));
  }
  for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(min[axis] + max[axis]) < 1e-6, '各轴 AABB 中心为零');
  assert.ok(radius <= 1.350001 && radius > 1.34999);
  assert.ok((max[2] - min[2]) / (max[0] - min[0]) > .3, '源模型的立体厚度不能变成平面');
});

test('真实 UV 与顶点颜色采样保留蓝紫、暖橙、绿叶和褐色枝茎', async () => {
  const asset = await actualAsset();
  const counts = { bluePurple: 0, warmOrange: 0, green: 0, brown: 0 };
  for (let index = 0; index < asset.count; index++) {
    const color = [...asset.colors.subarray(index * 3, index * 3 + 3)];
    assert.ok(color.every(value => Number.isFinite(value) && value >= 0 && value <= 1.000001));
    const [r, g, b] = color.map(srgb);
    if (b > .28 && b > g * 1.25) counts.bluePurple++;
    else if (g > .12 && g > r * 1.15 && g > b * 1.15) counts.green++;
    else if (r > .55 && r > g * 1.15 && g > b * 1.35) counts.warmOrange++;
    else if (r > .04 && r <= .55 && r > g * 1.1 && g > b * 1.1) counts.brown++;
  }
  assert.ok(counts.bluePurple > 5000, JSON.stringify(counts));
  assert.ok(counts.warmOrange > 50, JSON.stringify(counts));
  assert.ok(counts.green > 50, JSON.stringify(counts));
  assert.ok(counts.brown > 10, JSON.stringify(counts));
});

test('从相同 GLB 字节重新导入保留完全相同位置、原色和随机种子', async () => {
  const first = await actualAsset(), second = await loadWithDecodedPixels();
  assert.deepEqual(second.positions, first.positions);
  assert.deepEqual(second.colors, first.colors);
  assert.deepEqual(second.seeds, first.seeds);
});
