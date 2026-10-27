import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/exampleFiles.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { loadExampleBlob } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
};
function stubFetch(t, implementation) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => { globalThis.fetch = original; });
}

test('concurrent example consumers share the complete download and Blob read, then allow a new download', async t => {
  const response = deferred(), body = deferred();
  let downloads = 0, reads = 0;
  stubFetch(t, () => { downloads++; return response.promise; });
  const first = loadExampleBlob('/examples/shared.glb', '读取失败');
  const second = loadExampleBlob('/examples/shared.glb', '读取失败');
  assert.equal(downloads, 1);
  response.resolve({ ok: true, blob() { reads++; return body.promise; } });
  await Promise.resolve();
  const third = loadExampleBlob('/examples/shared.glb', '读取失败');
  assert.equal(downloads, 1, 'deduplication must last until the response body finishes');
  const blob = new Blob(['model']); body.resolve(blob);
  for (const result of await Promise.all([first, second, third])) assert.equal(result, blob);
  assert.equal(reads, 1);
  assert.equal(await loadExampleBlob('/examples/shared.glb', '读取失败'), blob);
  assert.equal(downloads, 2, 'completed requests must not retain a permanent Blob cache');
});

test('shared network failures preserve each consumer message and a later attempt can succeed', async t => {
  const response = deferred(); let downloads = 0;
  stubFetch(t, () => { downloads++; return response.promise; });
  const first = loadExampleBlob('/examples/retry.glb', '百合读取失败');
  const second = loadExampleBlob('/examples/retry.glb', '模型读取失败');
  const settled = Promise.allSettled([first, second]);
  response.reject(new TypeError('Failed to fetch'));
  const results = await settled;
  assert.equal(downloads, 1);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[0].reason.message, '百合读取失败');
  assert.equal(results[1].reason.message, '模型读取失败');
  const blob = new Blob(['retry succeeded']);
  globalThis.fetch = async () => { downloads++; return { ok: true, blob: async () => blob }; };
  assert.equal(await loadExampleBlob('/examples/retry.glb', '百合读取失败'), blob);
  assert.equal(downloads, 2);
});

test('HTTP and body-read failures both release a shared request for retry', async t => {
  let downloads = 0, reads = 0;
  stubFetch(t, async () => {
    downloads++;
    return downloads === 1
      ? { ok: false, status: 503, blob() { assert.fail('do not decode an unsuccessful HTTP response'); } }
      : { ok: true, blob() { reads++; return reads === 1 ? Promise.reject(new Error('body read failed')) : Promise.resolve(new Blob(['ok'])); } };
  });
  await assert.rejects(loadExampleBlob('/examples/transient.glb', '请重试'), { message: '请重试' });
  await assert.rejects(loadExampleBlob('/examples/transient.glb', '请重试'), { message: '请重试' });
  assert.equal(await (await loadExampleBlob('/examples/transient.glb', '请重试')).text(), 'ok');
  assert.equal(downloads, 3);
});

test('different example URLs download independently while matching URLs share their own body', async t => {
  const responses = new Map([['/examples/a.glb', deferred()], ['/examples/b.glb', deferred()]]);
  const requested = [];
  stubFetch(t, url => { requested.push(url); return responses.get(url).promise; });
  const a = loadExampleBlob('/examples/a.glb', 'A读取失败');
  const b = loadExampleBlob('/examples/b.glb', 'B读取失败');
  const anotherA = loadExampleBlob('/examples/a.glb', 'A读取失败');
  assert.deepEqual(requested, ['/examples/a.glb', '/examples/b.glb']);
  responses.get('/examples/b.glb').resolve({ ok: true, blob: async () => new Blob(['B']) });
  responses.get('/examples/a.glb').resolve({ ok: true, blob: async () => new Blob(['A']) });
  const [firstA, firstB, secondA] = await Promise.all([a, b, anotherA]);
  assert.equal(firstA, secondA);
  assert.equal(await firstA.text(), 'A');
  assert.equal(await firstB.text(), 'B');
});
