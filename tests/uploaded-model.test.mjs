import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const bytes=await readFile(new URL('../public/examples/uploaded-model.glb',import.meta.url));
const meta=JSON.parse(await readFile(new URL('../public/examples/uploaded-model-metadata.json',import.meta.url),'utf8'));
const gltf=JSON.parse(bytes.toString('utf8',20,20+bytes.readUInt32LE(12)));
test('provided lily preset is a complete self-contained GLB retaining the source provenance',()=>{
  assert.equal(bytes.readUInt32LE(0),0x46546c67);assert.equal(bytes.readUInt32LE(4),2);assert.equal(bytes.readUInt32LE(8),bytes.length);
  assert.equal(meta.sourceFile,'9f800fcfd1bf080d6bc2ec787faba287.glb');assert.equal(meta.originalTriangles,1500000);assert.equal(meta.sourceUnchanged,true);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),meta.outputSha256);assert.equal(meta.fileBytes,bytes.length);
  assert.ok(bytes.length<20*1024*1024);assert.ok(gltf.buffers.every(b=>!b.uri));assert.ok(gltf.images.every(i=>i.bufferView!==undefined&&!i.uri));
  assert.ok(!gltf.animations?.length&&!gltf.skins?.length&&!gltf.extensionsRequired?.length);
});
test('lily preset retains the full mesh, base-color UV and both visible sides within its web budget',()=>{
  let triangles=0;for(const mesh of gltf.meshes)for(const primitive of mesh.primitives){assert.equal(primitive.mode??4,4);assert.ok(primitive.attributes.POSITION!==undefined);assert.ok(primitive.attributes.TEXCOORD_0!==undefined);triangles+=gltf.accessors[primitive.indices].count/3;}
  assert.equal(triangles,meta.exportedTriangles);assert.ok(triangles>300000&&triangles<=500000);
  assert.equal(gltf.images.length,1);assert.equal(gltf.images[0].mimeType,'image/jpeg');
  assert.ok(gltf.materials.every(m=>m.doubleSided&&m.pbrMetallicRoughness.baseColorTexture));
  assert.ok(gltf.materials.every(m=>!m.normalTexture&&!m.pbrMetallicRoughness.metallicRoughnessTexture));
});
