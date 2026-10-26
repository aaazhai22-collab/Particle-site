import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MAX_PARTICLES } from './particleLimits';

export interface ParticleAsset {
  name: string;
  kind: 'sphere' | 'image' | 'model';
  positions: Float32Array;
  /** Linear RGB, ready for Three.js shader color calculations. */
  colors: Float32Array;
  seeds: Float32Array;
  /** Unit surface normals in the same coordinates as positions. Optional for older projects. */
  normals?: Float32Array;
  /** Per-particle [region, edge release weight, organ (0 petal / 1 centre / 2 stem)]. */
  surface?: Float32Array;
  count: number;
  hasOriginalColors: boolean;
  notes: string[];
  thumbnail?: string;
}

const POOL_SIZE = MAX_PARTICLES;
const RADIUS = 1.35;
const IMAGE_SAMPLE_SIDE = 2048;
const TEXTURE_SAMPLE_SIDE = 2048;
// One Float64 area entry per face: bounded to 40 MB, with no per-face objects.
const MAX_TRIANGLES = 5_000_000;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_MODEL_BYTES = 256 * 1024 * 1024;
const MAX_DECODE_PIXELS = 36_000_000;
const IMAGE_HEADER_BYTES = 1024 * 1024;
const FALLBACK_COLOR = new THREE.Color('#b6a4ff');

function runSynchronously<T>(steps: Generator<void, T>): T {
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}

async function runCooperatively<T>(steps: Generator<void, T>): Promise<T> {
  let result = steps.next();
  const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  while (!result.done) {
    // Return to the browser between bounded chunks, keeping file replacement,
    // loading feedback and camera interaction responsive during a 500k import.
    if (scheduler?.yield) await scheduler.yield();
    else await new Promise<void>((resolve) => setTimeout(resolve, 0));
    result = steps.next();
  }
  return result.value;
}

export function radicalInverse(index: number, base: number): number {
  let value = 0;
  let fraction = 1 / base;
  while (index > 0) { value += (index % base) * fraction; index = Math.floor(index / base); fraction /= base; }
  return value;
}

export function createParticleSeeds(count: number): Float32Array {
  const seeds = new Float32Array(count * 3);
  let state = 0x194a17;
  for (let i = 0; i < seeds.length; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    seeds[i] = (state >>> 0) / 4_294_967_296;
  }
  return seeds;
}

/** Normalize in place, keeping all proportions and preserving a stable sampling prefix. */
export function normalizeParticlePositions<T extends Float32Array | Float64Array>(positions: T, radius = RADIUS): T {
  return runSynchronously(normalizationSteps(positions, radius));
}

function* normalizationSteps<T extends Float32Array | Float64Array>(positions: T, radius = RADIUS): Generator<void, T> {
  if (!positions.length || positions.length % 3) throw new Error('素材没有有效的粒子位置。');
  const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    if (i > 0 && i % 65_536 === 0) yield;
    if (!Number.isFinite(positions[i])) throw new Error('素材包含无效的顶点坐标。');
    const axis = i % 3; min[axis] = Math.min(min[axis], positions[i]); max[axis] = Math.max(max[axis], positions[i]);
  }
  const center = min.map((value, axis) => (value + max[axis]) / 2);
  let extent = 0;
  for (let i = 0; i < positions.length; i += 3) {
    if (i > 0 && i % 98_304 === 0) yield;
    extent = Math.max(extent, Math.hypot(positions[i] - center[0], positions[i + 1] - center[1], positions[i + 2] - center[2]));
  }
  // A one-pixel image is still useful: it becomes a single point at the origin.
  const scale = extent > 1e-12 ? radius / extent : 1;
  for (let i = 0; i < positions.length; i++) {
    if (i > 0 && i % 65_536 === 0) yield;
    positions[i] = (positions[i] - center[i % 3]) * scale;
  }
  return positions;
}

export function selectCumulativeIndex(cumulative: Float64Array, value: number): number {
  let low = 0; let high = cumulative.length - 1;
  while (low < high) { const middle = (low + high) >>> 1; if (value < cumulative[middle]) high = middle; else low = middle + 1; }
  return low;
}

export function sampleTriangleWeights(index: number): [number, number, number] {
  const r = Math.sqrt(radicalInverse(index + 1, 3));
  const v = radicalInverse(index + 1, 5);
  return [1 - r, r * (1 - v), r * v];
}

function linearChannel(value: number): number { return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; }

export function createSphereAsset(): ParticleAsset {
  const positions = new Float32Array(POOL_SIZE * 3); const colors = new Float32Array(POOL_SIZE * 3);
  const normals = new Float32Array(POOL_SIZE * 3); const surface = new Float32Array(POOL_SIZE * 3);
  for (let i = 0; i < POOL_SIZE; i++) {
    const y = 1 - 2 * radicalInverse(i + 1, 2); const angle = Math.PI * 2 * radicalInverse(i + 1, 3); const r = Math.sqrt(1 - y * y);
    positions.set([RADIUS * r * Math.cos(angle), RADIUS * y, RADIUS * r * Math.sin(angle)], i * 3);
    colors.set([FALLBACK_COLOR.r, FALLBACK_COLOR.g, FALLBACK_COLOR.b], i * 3);
    normals.set([r * Math.cos(angle), y, r * Math.sin(angle)], i * 3);
    surface.set([(Math.atan2(positions[i * 3 + 2], positions[i * 3]) / (Math.PI * 2) + 1) % 1, 0.4, 0], i * 3);
  }
  return { name: '粒子球体', kind: 'sphere', positions, colors, normals, surface, seeds: createParticleSeeds(POOL_SIZE), count: POOL_SIZE, hasOriginalColors: false, notes: [] };
}

/** Pure image sampling used by both the browser importer and regression tests. */
export function sampleImagePixels(width: number, height: number, pixels: Uint8ClampedArray, name: string): ParticleAsset {
  return runSynchronously(imageSamplingSteps(width, height, pixels, name));
}

export function sampleImagePixelsAsync(width: number, height: number, pixels: Uint8ClampedArray, name: string): Promise<ParticleAsset> {
  return runCooperatively(imageSamplingSteps(width, height, pixels, name));
}

function* imageSamplingSteps(width: number, height: number, pixels: Uint8ClampedArray, name: string): Generator<void, ParticleAsset> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || pixels.length !== width * height * 4) throw new Error('图片没有有效的采样区域。');
  let validCount = 0; let partialAlpha = false;
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (let pixel = 0; pixel < width * height; pixel++) {
    if (pixel > 0 && pixel % 65_536 === 0) yield;
    const alpha = pixels[pixel * 4 + 3]; if (!alpha) continue;
    validCount++; if (alpha < 255) partialAlpha = true;
    const x = pixel % width; const y = Math.floor(pixel / width);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  if (!validCount) throw new Error('图片完全透明，没有可以生成粒子的有效像素。');
  const valid = new Uint32Array(validCount);
  const centerX = (minX + maxX) / 2; const centerY = (minY + maxY) / 2;
  let radiusSquared = 0;
  for (let pixel = 0, n = 0; pixel < width * height; pixel++) {
    if (pixel > 0 && pixel % 65_536 === 0) yield;
    if (pixels[pixel * 4 + 3] > 0) {
      valid[n++] = pixel; const x = pixel % width - centerX; const y = Math.floor(pixel / width) - centerY;
      radiusSquared = Math.max(radiusSquared, x * x + y * y);
    }
  }
  const scale = radiusSquared > 0 ? RADIUS / Math.sqrt(radiusSquared) : 1;
  const count = Math.min(POOL_SIZE, validCount);
  const positions = new Float32Array(count * 3); const colors = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3); const surface = new Float32Array(count * 3);
  // Shuffle once with a fixed seed. Reversing bits of a flattened pixel index
  // aliases with widths such as 736 and selects whole columns in early prefixes.
  // This permutation keeps prefixes stable and unique without a spatial lattice.
  let sampleSeed = 0x537a2d91;
  for (let i = validCount - 1; i > 0; i--) {
    if (i % 65_536 === 0) yield;
    sampleSeed ^= sampleSeed << 13; sampleSeed ^= sampleSeed >>> 17; sampleSeed ^= sampleSeed << 5;
    const j = (sampleSeed >>> 0) % (i + 1);
    const pixel = valid[i]; valid[i] = valid[j]; valid[j] = pixel;
  }
  for (let n = 0; n < count; n++) {
    if (n > 0 && n % 16_384 === 0) yield;
    const pixel = valid[n]; const p = pixel * 4;
    positions.set([((pixel % width) - centerX) * scale, (centerY - Math.floor(pixel / width)) * scale, 0], n * 3);
    colors.set([linearChannel(pixels[p] / 255), linearChannel(pixels[p + 1] / 255), linearChannel(pixels[p + 2] / 255)], n * 3);
    normals[n * 3 + 2] = 1;
    const x = pixel % width; const y = Math.floor(pixel / width);
    const borderDistance = Math.min(x - minX, maxX - x, y - minY, maxY - y);
    let rim = borderDistance < 4 ? 1 - Math.max(0, borderDistance) / 4 : 0;
    for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) {
      const nx = x + dx; const ny = y + dy;
      if (nx >= 0 && nx < width && ny >= 0 && ny < height && pixels[(ny * width + nx) * 4 + 3] === 0) rim = 1;
    }
    surface.set([0.5 + Math.sin(x / Math.max(1, width) * 7 + y / Math.max(1, height) * 5) * 0.45, rim, 0], n * 3);
  }
  const notes = count < POOL_SIZE ? [`有效像素为 ${validCount.toLocaleString()} 个，最多生成 ${count.toLocaleString()} 个不重复粒子。`] : [];
  if (partialAlpha) notes.push('图片包含半透明像素；本版用 Alpha 过滤全透明区域，粒子透明度由统一参数控制。');
  return { name, kind: 'image', positions, colors, normals, surface, seeds: createParticleSeeds(count), count, hasOriginalColors: true, notes };
}

/** Read dimensions before decoding; handles PNG IHDR and baseline/progressive JPEG SOF. */
export function readImageDimensions(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) {
    if (view.getUint32(12) !== 0x49484452) throw new Error('PNG 图片头损坏，无法读取尺寸。');
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const startOfFrame = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf];
    let position = 2;
    while (position + 1 < bytes.length) {
      if (bytes[position++] !== 0xff) break;
      while (position < bytes.length && bytes[position] === 0xff) position++;
      const marker = bytes[position++]; if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (position + 2 > bytes.length) break;
      const length = view.getUint16(position); if (length < 2 || position + length > bytes.length) break;
      if (startOfFrame.includes(marker) && length >= 8) return { width: view.getUint16(position + 5), height: view.getUint16(position + 3) };
      position += length;
    }
  }
  throw new Error('图片尺寸无法安全读取，请重新导出 PNG / JPG / JPEG；图片头部需位于前 1 MiB。');
}

function checkDecodeDimensions(width: number, height: number): void {
  if (!width || !height || !Number.isFinite(width * height)) throw new Error('图片没有有效的尺寸。');
  if (width * height > MAX_DECODE_PIXELS) throw new Error('图片超过 3,600 万像素，解码可能占用过多内存。请先缩小图片后重新导入。');
}

async function loadImage(file: File): Promise<ParticleAsset> {
  const dimensions = readImageDimensions(new Uint8Array(await file.slice(0, IMAGE_HEADER_BYTES).arrayBuffer()));
  checkDecodeDimensions(dimensions.width, dimensions.height);
  let bitmap: ImageBitmap | null = null; let image: HTMLImageElement | null = null; let url: string | null = null;
  const canvases: HTMLCanvasElement[] = [];
  try {
    let source: CanvasImageSource; let width: number; let height: number;
    if (typeof createImageBitmap === 'function') {
      try { bitmap = await createImageBitmap(file); } catch { throw new Error('图片读取失败或文件损坏，请重新选择 PNG / JPG / JPEG 图片。'); }
      source = bitmap; width = bitmap.width; height = bitmap.height;
    } else {
      const decodedImage = new Image(); image = decodedImage; url = URL.createObjectURL(file);
      await new Promise<void>((resolve, reject) => { decodedImage.onload = () => resolve(); decodedImage.onerror = () => reject(new Error('图片读取失败或文件损坏，请重新选择 PNG / JPG / JPEG 图片。')); decodedImage.src = url!; });
      source = decodedImage; width = decodedImage.naturalWidth; height = decodedImage.naturalHeight;
    }
    checkDecodeDimensions(width, height);
    const ratio = Math.min(1, IMAGE_SAMPLE_SIDE / Math.max(width, height));
    const canvas = document.createElement('canvas'); canvases.push(canvas); canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('浏览器无法读取图片像素，请刷新页面后重试。');
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const result = await sampleImagePixelsAsync(canvas.width, canvas.height, context.getImageData(0, 0, canvas.width, canvas.height).data, file.name);
    if (ratio < 1) result.notes.push(`为控制内存，图片按原比例缩小至 ${canvas.width} × ${canvas.height} 后采样；原文件未修改。`);
    const thumbnail = document.createElement('canvas'); canvases.push(thumbnail); const thumbRatio = Math.min(1, 240 / Math.max(canvas.width, canvas.height));
    thumbnail.width = Math.max(1, Math.round(canvas.width * thumbRatio)); thumbnail.height = Math.max(1, Math.round(canvas.height * thumbRatio));
    thumbnail.getContext('2d')?.drawImage(canvas, 0, 0, thumbnail.width, thumbnail.height); result.thumbnail = thumbnail.toDataURL('image/png');
    return result;
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error('图片读取失败，请重新选择素材。');
  } finally {
    bitmap?.close(); canvases.forEach(canvas => { canvas.width = canvas.height = 1; });
    if (image) { image.onload = image.onerror = null; image.src = ''; }
    if (url) URL.revokeObjectURL(url);
  }
}

type ColorMaterial = THREE.Material & { color?: THREE.Color; map?: THREE.Texture | null };
interface ModelMesh {
  geometry: THREE.BufferGeometry;
  material: ColorMaterial | ColorMaterial[];
  matrix: THREE.Matrix4;
  normalMatrix: THREE.Matrix3;
  region: number;
  start: number;
  firstTriangle: number;
  triangleCount: number;
}
interface Raster { width: number; height: number; pixels: Uint8ClampedArray }

function textureRaster(texture: THREE.Texture): Raster | null {
  const source = texture.image as CanvasImageSource & { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number };
  const width = source?.naturalWidth || source?.width || 0; const height = source?.naturalHeight || source?.height || 0;
  if (!width || !height || typeof document === 'undefined') return null;
  const ratio = Math.min(1, TEXTURE_SAMPLE_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true }); if (!context) return null;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
  } catch { return null; } finally { canvas.width = canvas.height = 1; }
}

/** Sample a fully loaded static scene; does not take ownership of the caller's scene. */
export function sampleModelScene(scene: THREE.Object3D, name: string, initialNotes: string[] = []): ParticleAsset {
  return runSynchronously(modelSamplingSteps(scene, name, initialNotes));
}

export function sampleModelSceneAsync(scene: THREE.Object3D, name: string, initialNotes: string[] = []): Promise<ParticleAsset> {
  return runCooperatively(modelSamplingSteps(scene, name, initialNotes));
}

function* modelSamplingSteps(scene: THREE.Object3D, name: string, initialNotes: string[]): Generator<void, ParticleAsset> {
  scene.updateMatrixWorld(true);
  const notes = [...initialNotes]; const meshes: ModelMesh[] = []; const a = new THREE.Vector3(); const b = new THREE.Vector3(); const c = new THREE.Vector3(); const edge = new THREE.Vector3(); const cross = new THREE.Vector3();
  let skippedMeshes = 0; let invalidTriangles = 0; let triangleCount = 0;
  let meshIndex = 0;
  const objects: THREE.Object3D[] = []; scene.traverse(object => objects.push(object));
  for (const object of objects) {
    if (!(object instanceof THREE.Mesh)) { if (object instanceof THREE.Points || object instanceof THREE.Line) skippedMeshes++; continue; }
    const mesh = object as THREE.Mesh;
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || mesh.geometry.morphAttributes.position?.length) { skippedMeshes++; continue; }
    const geometry = mesh.geometry; const position = geometry.getAttribute('position'); const index = geometry.index;
    if (!position || position.itemSize < 3) { skippedMeshes++; continue; }
    const length = index ? index.count : position.count;
    if (length % 3) { skippedMeshes++; continue; }
    const start = Math.max(0, Math.ceil(geometry.drawRange.start / 3) * 3); const end = Math.min(length, Number.isFinite(geometry.drawRange.count) ? geometry.drawRange.start + geometry.drawRange.count : length);
    const count = Math.max(0, Math.floor((end - start) / 3));
    if (!count) continue;
    if (!Number.isSafeInteger(count) || triangleCount + count > MAX_TRIANGLES) throw new Error('模型超过 5,000,000 个三角面。请先简化网格，避免浏览器采样内存过高；不会截断模型。');
    const matrix = mesh.matrixWorld.clone();
    meshes.push({ geometry, material: mesh.material as ColorMaterial | ColorMaterial[], matrix, normalMatrix: new THREE.Matrix3().getNormalMatrix(matrix), region: radicalInverse(++meshIndex, 2), start, firstTriangle: triangleCount, triangleCount: count });
    triangleCount += count;
  }
  // Retain every face in a compact area prefix. Invalid faces have zero weight,
  // so binary search naturally skips them without a second index/object array.
  const cumulative = new Float64Array(triangleCount); let total = 0;
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute('position'); const index = mesh.geometry.index;
    for (let face = 0; face < mesh.triangleCount; face++) {
      if (face > 0 && face % 8_192 === 0) yield;
      const offset = mesh.start + face * 3;
      const ia = index ? index.getX(offset) : offset; const ib = index ? index.getX(offset + 1) : offset + 1; const ic = index ? index.getX(offset + 2) : offset + 2;
      if (Number.isInteger(ia) && ia >= 0 && ia < position.count && Number.isInteger(ib) && ib >= 0 && ib < position.count && Number.isInteger(ic) && ic >= 0 && ic < position.count) {
        a.fromBufferAttribute(position, ia).applyMatrix4(mesh.matrix); b.fromBufferAttribute(position, ib).applyMatrix4(mesh.matrix); c.fromBufferAttribute(position, ic).applyMatrix4(mesh.matrix);
        const area = cross.subVectors(b, a).cross(edge.subVectors(c, a)).length() / 2;
        if (Number.isFinite(area) && area > 1e-12) total += area;
        else invalidTriangles++;
      } else invalidTriangles++;
      cumulative[mesh.firstTriangle + face] = total;
    }
  }
  if (!(total > 0) || !Number.isFinite(total)) throw new Error('模型没有有效的静态三角网格。当前版本不支持骨骼、形变、实例化、点或线模型。');
  if (skippedMeshes) notes.push(`已跳过 ${skippedMeshes} 个不支持的骨骼 / 形变 / 实例化 / 非三角对象，仅采样有效静态网格。`);
  if (invalidTriangles) notes.push(`已跳过 ${invalidTriangles.toLocaleString()} 个退化或无效三角面。`);
  // Keep full precision until centered, so far-away node translations do not collapse small geometry.
  const positions = new Float64Array(POOL_SIZE * 3); const colors = new Float32Array(POOL_SIZE * 3); const rasters = new Map<THREE.Texture, Raster | null>(); const warned = new Set<string>(); const uv = new THREE.Vector2();
  const normals = new Float32Array(POOL_SIZE * 3); const surface = new Float32Array(POOL_SIZE * 3);
  const sampleNormal = new THREE.Vector3(); const localNormal = new THREE.Vector3();
  const vertexIds = [0, 0, 0];
  let hasOriginalColors = false;
  const warn = (key: string, text: string) => { if (!warned.has(key)) { warned.add(key); notes.push(text); } };
  for (let i = 0; i < POOL_SIZE; i++) {
    if (i > 0 && i % 2_048 === 0) yield;
    const face = selectCumulativeIndex(cumulative, radicalInverse(i + 1, 2) * total);
    let low = 0; let high = meshes.length - 1;
    while (low < high) { const middle = (low + high + 1) >>> 1; if (meshes[middle].firstTriangle <= face) low = middle; else high = middle - 1; }
    const triangle = meshes[low];
    const offset = triangle.start + (face - triangle.firstTriangle) * 3; const index = triangle.geometry.index;
    vertexIds[0] = index ? index.getX(offset) : offset; vertexIds[1] = index ? index.getX(offset + 1) : offset + 1; vertexIds[2] = index ? index.getX(offset + 2) : offset + 2;
    const weights = sampleTriangleWeights(i); const attribute = triangle.geometry.getAttribute('position');
    a.fromBufferAttribute(attribute, vertexIds[0]).applyMatrix4(triangle.matrix); b.fromBufferAttribute(attribute, vertexIds[1]).applyMatrix4(triangle.matrix); c.fromBufferAttribute(attribute, vertexIds[2]).applyMatrix4(triangle.matrix);
    positions.set([a.x * weights[0] + b.x * weights[1] + c.x * weights[2], a.y * weights[0] + b.y * weights[1] + c.y * weights[2], a.z * weights[0] + b.z * weights[1] + c.z * weights[2]], i * 3);
    const normalAttribute = triangle.geometry.getAttribute('normal');
    sampleNormal.set(0, 0, 0);
    if (normalAttribute && normalAttribute.itemSize >= 3 && vertexIds.every(id => id < normalAttribute.count)) {
      for (let n = 0; n < 3; n++) sampleNormal.addScaledVector(localNormal.fromBufferAttribute(normalAttribute, vertexIds[n]), weights[n]);
      sampleNormal.applyMatrix3(triangle.normalMatrix);
    }
    if (!Number.isFinite(sampleNormal.lengthSq()) || sampleNormal.lengthSq() < 1e-12) sampleNormal.subVectors(b, a).cross(edge.subVectors(c, a));
    sampleNormal.normalize(); normals.set([sampleNormal.x, sampleNormal.y, sampleNormal.z], i * 3);
    // GLTFLoader preserves application-defined attributes under lowercase names.
    const semantic = triangle.geometry.getAttribute('_surface') || triangle.geometry.getAttribute('surface');
    const validSemantic = semantic && semantic.itemSize >= 3 && vertexIds.every(id => id < semantic.count && [semantic.getX(id), semantic.getY(id), semantic.getZ(id)].every(Number.isFinite));
    if (validSemantic) {
      const values = [0, 0, 0];
      for (let n = 0; n < 3; n++) { values[0] += semantic.getX(vertexIds[n]) * weights[n]; values[1] += semantic.getY(vertexIds[n]) * weights[n]; values[2] += semantic.getZ(vertexIds[n]) * weights[n]; }
      surface.set([Math.min(1, Math.max(0, values[0])), Math.min(1, Math.max(0, values[1])), Math.min(2, Math.max(0, values[2]))], i * 3);
    } else {
      surface.set([triangle.region, Math.pow(Math.max(0, 1 - Math.abs(sampleNormal.z)), 2), 0], i * 3);
      if (semantic) warn('surface', '部分局部流动分区无效，已按静态网格区域推定。');
    }
    let material: ColorMaterial | undefined;
    if (Array.isArray(triangle.material)) { const group = triangle.geometry.groups.find(group => offset >= group.start && offset < group.start + group.count); material = group ? triangle.material[group.materialIndex ?? 0] : undefined; }
    else material = triangle.material;
    const colorAttribute = triangle.geometry.getAttribute('color');
    const colorCandidate = material?.color;
    const base = colorCandidate && [colorCandidate.r, colorCandidate.g, colorCandidate.b].every(Number.isFinite) ? colorCandidate : undefined;
    const validVertexColor = colorAttribute && colorAttribute.itemSize >= 3 && vertexIds.every(id => id < colorAttribute.count && [colorAttribute.getX(id), colorAttribute.getY(id), colorAttribute.getZ(id)].every(Number.isFinite));
    const vertexColor = validVertexColor ? colorAttribute : undefined;
    if (colorAttribute && !validVertexColor) warn('vertex', '部分顶点颜色无效，已回退到材质基色或统一色。');
    if (material && (material.transparent || material.opacity < 1 || material.alphaTest > 0)) warn('alpha', '模型使用透明材质；本版还原基础 RGB，逐点 Alpha 由后续版本补充，可调整统一透明度。');
    let r = base?.r ?? (vertexColor ? 1 : FALLBACK_COLOR.r); let g = base?.g ?? (vertexColor ? 1 : FALLBACK_COLOR.g); let blue = base?.b ?? (vertexColor ? 1 : FALLBACK_COLOR.b);
    if (base || vertexColor) hasOriginalColors = true;
    else warn('base', '部分网格无法获取基础颜色，已使用淡紫色回退；也可切换统一色。');
    if (vertexColor && vertexColor.itemSize >= 3) {
      // glTF vertex COLOR_0 values are already linear; multiply by baseColorFactor.
      r *= vertexIds.reduce((sum, id, n) => sum + vertexColor.getX(id) * weights[n], 0);
      g *= vertexIds.reduce((sum, id, n) => sum + vertexColor.getY(id) * weights[n], 0);
      blue *= vertexIds.reduce((sum, id, n) => sum + vertexColor.getZ(id) * weights[n], 0);
    }
    const map = material?.map;
    if (map) {
      if (!rasters.has(map)) { if (map.matrixAutoUpdate) map.updateMatrix(); rasters.set(map, textureRaster(map)); }
      const raster = rasters.get(map); const uvName = map.channel ? `uv${map.channel}` : 'uv'; const uvAttribute = triangle.geometry.getAttribute(uvName);
      const validUV = uvAttribute && uvAttribute.itemSize >= 2 && vertexIds.every(id => id < uvAttribute.count && Number.isFinite(uvAttribute.getX(id)) && Number.isFinite(uvAttribute.getY(id)));
      if (raster && validUV) {
        uv.set(vertexIds.reduce((sum, id, n) => sum + uvAttribute.getX(id) * weights[n], 0), vertexIds.reduce((sum, id, n) => sum + uvAttribute.getY(id) * weights[n], 0)); map.transformUv(uv);
        if (Number.isFinite(uv.x) && Number.isFinite(uv.y)) {
          const x = Math.min(raster.width - 1, Math.max(0, Math.floor(uv.x * raster.width))); const y = Math.min(raster.height - 1, Math.max(0, Math.floor(uv.y * raster.height))); const offset = (y * raster.width + x) * 4;
          const convert = map.colorSpace === THREE.SRGBColorSpace ? linearChannel : (v: number) => v;
          r *= convert(raster.pixels[offset] / 255); g *= convert(raster.pixels[offset + 1] / 255); blue *= convert(raster.pixels[offset + 2] / 255); hasOriginalColors = true;
        } else warn('texture', '部分基础色贴图 UV 变换无效，已回退到材质基色 / 顶点颜色。');
      } else warn('texture', '部分基础色贴图无法读取或缺少对应 UV，已回退到材质基色 / 顶点颜色；可切换统一色。');
    }
    colors.set([Number.isFinite(r) ? Math.max(0, r) : FALLBACK_COLOR.r, Number.isFinite(g) ? Math.max(0, g) : FALLBACK_COLOR.g, Number.isFinite(blue) ? Math.max(0, blue) : FALLBACK_COLOR.b], i * 3);
  }
  yield* normalizationSteps(positions);
  return { name, kind: 'model', positions: new Float32Array(positions), colors, normals, surface, seeds: createParticleSeeds(POOL_SIZE), count: POOL_SIZE, hasOriginalColors, notes };
}

export function disposeAssetScenes(scenes: THREE.Object3D[]): void {
  const geometries = new Set<THREE.BufferGeometry>(); const materials = new Set<THREE.Material>(); const textures = new Set<THREE.Texture>(); const images = new Set<unknown>();
  scenes.forEach(scene => scene.traverse(object => {
    const mesh = object as THREE.Mesh; if (mesh.geometry) geometries.add(mesh.geometry);
    if (mesh.material) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(material => materials.add(material));
  }));
  materials.forEach(material => Object.values(material).forEach(value => { if (value instanceof THREE.Texture) textures.add(value); }));
  geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose());
  textures.forEach(texture => { images.add(texture.image); texture.dispose(); });
  images.forEach(image => { if (image && typeof (image as ImageBitmap).close === 'function') (image as ImageBitmap).close(); });
}

interface ModelDocument {
  extensionsRequired?: string[];
  animations?: unknown[];
  images?: { uri?: string; bufferView?: number; mimeType?: string }[];
  buffers?: { uri?: string }[];
  bufferViews?: { buffer?: number; byteOffset?: number; byteLength: number }[];
  textures?: { source?: number }[];
  materials?: {
    normalTexture?: unknown; occlusionTexture?: unknown; emissiveTexture?: unknown;
    pbrMetallicRoughness?: { baseColorTexture?: { index: number }; metallicRoughnessTexture?: unknown };
    extensions?: Record<string, Record<string, unknown>>;
  }[];
}

/** Particle colors use only baseColor, COLOR_0 and its UV transform. */
function omitUnusedMaterialTextures(documentData: ModelDocument): number {
  let removed = 0;
  for (const material of documentData.materials || []) {
    for (const key of ['normalTexture', 'occlusionTexture', 'emissiveTexture'] as const) if (material[key] !== undefined) { delete material[key]; removed++; }
    if (material.pbrMetallicRoughness?.metallicRoughnessTexture !== undefined) { delete material.pbrMetallicRoughness.metallicRoughnessTexture; removed++; }
    for (const extension of Object.values(material.extensions || {})) for (const key of Object.keys(extension)) {
      if (/Texture$/.test(key)) { delete extension[key]; removed++; }
    }
  }
  return removed;
}

function checkModelBaseColorImages(documentData: ModelDocument, bytes: ArrayBuffer, jsonLength: number): void {
  const imageIndices = new Set<number>();
  for (const material of documentData.materials || []) {
    const textureIndex = material.pbrMetallicRoughness?.baseColorTexture?.index;
    const source = textureIndex === undefined ? undefined : documentData.textures?.[textureIndex]?.source;
    if (source !== undefined) imageIndices.add(source);
  }
  const binHeader = 20 + jsonLength; const view = new DataView(bytes);
  for (const imageIndex of imageIndices) {
    const image = documentData.images?.[imageIndex]; const bufferView = image?.bufferView === undefined ? undefined : documentData.bufferViews?.[image.bufferView];
    if (!image || !bufferView || (bufferView.buffer || 0) !== 0 || !['image/png', 'image/jpeg'].includes(image.mimeType || '')) continue;
    const start = binHeader + 8 + (bufferView.byteOffset || 0);
    if (binHeader + 8 > bytes.byteLength || view.getUint32(binHeader + 4, true) !== 0x004e4942 || start < binHeader + 8 || start + bufferView.byteLength > bytes.byteLength) throw new Error('模型基础色贴图数据损坏，无法读取。');
    const dimensions = readImageDimensions(new Uint8Array(bytes, start, Math.min(bufferView.byteLength, IMAGE_HEADER_BYTES)));
    if (dimensions.width * dimensions.height > MAX_DECODE_PIXELS) throw new Error('模型基础色贴图超过 3,600 万像素，解码可能占用过多内存。请将贴图缩小到 2048 像素后重新导入。');
    checkDecodeDimensions(dimensions.width, dimensions.height);
  }
}

async function loadModel(file: File): Promise<ParticleAsset> {
  const bytes = await file.arrayBuffer(); const data = new DataView(bytes);
  if (bytes.byteLength < 20 || data.getUint32(0, true) !== 0x46546c67 || data.getUint32(4, true) !== 2 || data.getUint32(8, true) !== bytes.byteLength) throw new Error('GLB 文件损坏或不是 glTF 2.0 二进制模型，请重新导出。');
  let documentData: ModelDocument; let jsonLength: number;
  try {
    jsonLength = data.getUint32(12, true);
    if (data.getUint32(16, true) !== 0x4e4f534a || jsonLength > bytes.byteLength - 20) throw new Error();
    documentData = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLength)));
  } catch { throw new Error('GLB 文件的模型数据损坏，无法读取。'); }
  if (documentData.extensionsRequired?.some(extension => ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'].includes(extension))) throw new Error('当前版本暂不支持 Draco / Meshopt 压缩模型或 KTX2 贴图，请导出未压缩、内嵌普通贴图的 GLB。');
  const external = [...(documentData.images || []), ...(documentData.buffers || [])].some(item => item.uri && !item.uri.startsWith('data:'));
  if (external) throw new Error('该 GLB 引用了外部文件。请将几何和贴图内嵌到一个 GLB 后重新导入。');
  checkModelBaseColorImages(documentData, bytes, jsonLength);
  const notes: string[] = []; const urls = new Set<string>();
  if (documentData.animations?.length) notes.push('模型包含动画；本次仅采样静态初始姿态，不播放动画。');
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => { if (url.startsWith('blob:')) { urls.add(url); return url; } if (url.startsWith('data:')) return url; throw new Error('不支持读取模型的外部资源。'); });
  manager.onError = () => { if (!notes.includes('部分基础色贴图加载失败，已回退到材质基色。')) notes.push('部分基础色贴图加载失败，已回退到材质基色。'); };
  let scenes: THREE.Group[] = [];
  try {
    const loader = new GLTFLoader(manager);
    loader.register(parser => {
      // This parser owns its JSON; never change the user's GLB or global loaders.
      const removed = omitUnusedMaterialTextures(parser.json as ModelDocument);
      if (removed) notes.push('粒子保留基础色贴图与顶点原色，已跳过未参与粒子着色的法线 / 粗糙度 / 高光等贴图，减少解码内存。');
      return { name: 'PARTICLE_base_color_only' };
    });
    const gltf = await loader.parseAsync(bytes, ''); scenes = gltf.scenes;
    return await sampleModelSceneAsync(gltf.scene, file.name, notes);
  } catch (error) {
    if (error instanceof Error && /静态|超过|外部|基础|坐标/.test(error.message)) throw error;
    const detail = error instanceof Error && /Draco|Meshopt|KTX|decoder|extension/i.test(error.message) ? '当前版本不支持此模型使用的压缩或扩展，请导出普通静态 GLB。' : '模型读取失败或文件损坏，请重新选择包含静态三角网格的 GLB。';
    throw new Error(detail);
  } finally { disposeAssetScenes(scenes); urls.forEach(url => URL.revokeObjectURL(url)); }
}

export async function loadParticleAsset(file: File): Promise<ParticleAsset> {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (!['png', 'jpg', 'jpeg', 'glb'].includes(extension || '')) throw new Error('不支持的文件格式。请选择 PNG、JPG、JPEG 图片或静态 GLB 模型。');
  if (file.size > (extension === 'glb' ? MAX_MODEL_BYTES : MAX_IMAGE_BYTES)) throw new Error(extension === 'glb' ? '模型超过 256 MiB。为避免浏览器内存过高，请简化模型或缩小内嵌贴图后重试。' : '图片超过 50 MiB。为避免浏览器解码占用过多内存，请先缩小图片后重试。');
  try { return extension === 'glb' ? await loadModel(file) : await loadImage(file); }
  catch (error) { if (error instanceof Error && /[\u3400-\u9fff]/.test(error.message)) throw error; throw new Error('素材读取失败，请检查文件是否损坏并重新选择。'); }
}

export async function loadExampleAsset(url: string, name: string): Promise<ParticleAsset> {
  try {
    const response = await fetch(url); if (!response.ok) throw new Error();
    const blob = await response.blob(); return await loadParticleAsset(new File([blob], name, { type: blob.type }));
  } catch (error) { if (error instanceof Error && /图片|模型|文件|格式|透明|静态|采样/.test(error.message)) throw error; throw new Error('示例素材读取失败，请重新尝试或选择本地文件。'); }
}
