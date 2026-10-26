import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createQaServer } from '../scripts/qa-server.mjs';
import { createQaSink, MAX_FRAME_BYTES, MAX_REPORT_BYTES, MAX_VIDEO_BYTES } from '../scripts/qa-sink.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'particle-local-qa-'));
  for (const directory of ['src', 'tests', 'public/examples', 'artifacts']) await mkdir(join(root, directory), { recursive: true });
  const server = createQaServer({ root });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, origin: `http://127.0.0.1:${server.address().port}` };
}

async function rawHostRequest(url, host) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: { Host: host } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
}

async function declaredPost(root, pathname, type, bytes, name) {
  const request = Readable.from([]);
  request.method = 'POST';
  request.headers = {
    'content-type': type, 'content-length': String(bytes), 'x-particle-qa': '1',
    ...(name ? { 'x-particle-name': name } : {}),
  };
  const response = {
    status: 0, headersSent: false,
    writeHead(status) { this.status = status; this.headersSent = true; },
    end() {},
  };
  await createQaSink(root)(request, response, new URL(pathname, 'http://127.0.0.1:5174'));
  return response.status;
}

test('local QA bundles historical inline static and dynamic TypeScript imports with query URLs', async t => {
  const { root, origin } = await fixture(t);
  await writeFile(join(root, 'src/source.ts'), 'export const value: string = "static-marker";');
  await writeFile(join(root, 'src/dynamic.ts'), 'export const value: string = "dynamic-marker";');
  await writeFile(join(root, 'qa.html'), '<h1>Fixture</h1><script type="module">import { value } from "/src/source.ts?qa=1"; console.log(value, import.meta.env.DEV); import("/src/dynamic.ts").then(console.log);</script>');
  const response = await fetch(origin + '/qa.html?run=1');
  assert.equal(response.status, 200);
  const html = await response.text();
  const modulePath = /src="([^"]+)"/.exec(html)[1];
  const module = await fetch(origin + modulePath + '?run=2');
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /javascript/);
  const code = await module.text();
  assert.match(code, /static-marker/);
  assert.match(code, /dynamic-marker/);
  assert.doesNotMatch(code, /import\.meta\.env/);
  const direct = await fetch(origin + '/src/source.ts?direct=1');
  assert.equal(direct.status, 200);
  assert.match(await direct.text(), /static-marker/);
});

test('local QA bundles relative external GPU modules and exposes only QA files', async t => {
  const { root, origin } = await fixture(t);
  await writeFile(join(root, 'tests/fixture-gpu.html'), '<script type="module" src="./fixture-gpu.js?run=1"></script>');
  await writeFile(join(root, 'tests/fixture-gpu.js'), 'console.log("gpu-fixture");');
  await writeFile(join(root, 'package.json'), '{"private":true}');
  const html = await (await fetch(origin + '/tests/fixture-gpu.html')).text();
  assert.match(await (await fetch(origin + /src="([^"]+)"/.exec(html)[1])).text(), /gpu-fixture/);
  assert.equal((await fetch(origin + '/package.json')).status, 404);
  assert.equal((await fetch(origin + '/src/../../package.json')).status, 404);
  assert.equal(await rawHostRequest(origin + '/qa.html', 'example.com'), 403);
});

test('QA reports require the explicit header and same origin and preserve GET/HEAD behavior', async t => {
  const { root, origin } = await fixture(t);
  const path = origin + '/__qa/report';
  assert.equal((await fetch(path, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(path, { method: 'POST', headers: { 'X-Particle-QA': '1', Origin: 'https://example.com' }, body: '{}' })).status, 403);
  assert.equal((await fetch(path, { method: 'POST', headers: { 'X-Particle-QA': '1', Origin: origin }, body: '{invalid' })).status, 400);
  assert.equal((await fetch(path, { method: 'POST', headers: { 'X-Particle-QA': '1', Origin: origin }, body: '{"passed":true}' })).status, 200);
  assert.deepEqual(await (await fetch(path + '?run=1')).json(), { passed: true });
  assert.deepEqual(JSON.parse(await readFile(join(root, 'artifacts/browser-test.json'), 'utf8')), { passed: true });
  const head = await fetch(path, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(path, { method: 'DELETE' })).status, 405);
});

test('QA video and artifact reads preserve exact byte ranges for browser seek', async t => {
  const { root, origin } = await fixture(t);
  const body = Buffer.from('local-video-fixture');
  const upload = await fetch(origin + '/__qa/video', { method: 'POST', headers: { 'X-Particle-QA': '1', 'Content-Type': 'video/mp4' }, body });
  assert.equal(upload.status, 200);
  assert.equal((await upload.json()).bytes, body.length);
  assert.deepEqual(await readFile(join(root, 'artifacts/browser-test.mp4')), body);
  for (const path of ['/__qa/video?run=1', '/artifacts/browser-test.mp4']) {
    const part = await fetch(origin + path, { headers: { Range: 'bytes=2-6' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 2-6/${body.length}`);
    assert.equal(await part.text(), body.subarray(2, 7).toString());
    const suffix = await fetch(origin + path, { headers: { Range: 'bytes=-4' } });
    assert.equal(await suffix.text(), body.subarray(-4).toString());
    assert.equal((await fetch(origin + path, { headers: { Range: 'bytes=999999-' } })).status, 416);
  }
  const head = await fetch(origin + '/__qa/video', { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), String(body.length));
  assert.equal(await head.text(), '');
});

test('QA frame uploads keep PNG and filename validation and never return video', async t => {
  const { origin } = await fixture(t);
  const headers = { 'X-Particle-QA': '1', 'X-Particle-Name': 'petal-fixture', 'Content-Type': 'image/png' };
  assert.equal((await fetch(origin + '/__qa/frame', { method: 'POST', headers, body: 'invalid' })).status, 415);
  assert.equal((await fetch(origin + '/__qa/frame', { method: 'POST', headers: { ...headers, 'X-Particle-Name': '../outside' }, body: 'invalid' })).status, 400);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  assert.equal((await fetch(origin + '/__qa/frame', { method: 'POST', headers, body: png })).status, 200);
  const frame = await fetch(origin + '/__qa/frame?name=petal-fixture');
  assert.equal(frame.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await frame.arrayBuffer()), png);
  assert.equal((await fetch(origin + '/__qa/frame?name=../outside')).status, 400);
  assert.equal((await fetch(origin + '/__qa/frame')).status, 404);
});

test('QA retains the video/report/frame upload size ceilings before consuming declared bodies', async t => {
  const { root } = await fixture(t);
  assert.equal(await declaredPost(root, '/__qa/video', 'video/mp4', MAX_VIDEO_BYTES + 1), 413);
  assert.equal(await declaredPost(root, '/__qa/report', 'application/json', MAX_REPORT_BYTES + 1), 413);
  assert.equal(await declaredPost(root, '/__qa/frame', 'image/png', MAX_FRAME_BYTES + 1, 'petal-fixture'), 413);
});

test('QA examples retain MIME, HEAD and range support outside the production bundle', async t => {
  const { root, origin } = await fixture(t);
  await writeFile(join(root, 'public/examples/fixture.glb'), 'glb-fixture');
  const asset = await fetch(origin + '/examples/fixture.glb?run=1');
  assert.equal(asset.headers.get('content-type'), 'model/gltf-binary');
  assert.equal(await asset.text(), 'glb-fixture');
  const head = await fetch(origin + '/examples/fixture.glb', { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), '11');
  assert.equal(await head.text(), '');
});

test('QA server bundles the actual historical Three.js page without relying on Vite', async t => {
  const server = createQaServer({ root: resolve('.') });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(origin + '/lily-qa.html')).text();
  const module = await fetch(origin + /src="([^"]+)"/.exec(html)[1]);
  assert.equal(module.status, 200, await module.clone().text());
  const code = await module.text();
  assert.match(code, /class ParticleEngine|ParticleEngine = class/);
  assert.match(code, /GLTFLoader/);
  assert.doesNotMatch(code, /from ['"]three['"]/);
});
