import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/importQueue.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { LatestImport } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const deferred = () => { let resolve, reject; const promise = new Promise((r,j) => {resolve=r; reject=j;}); return {promise, resolve, reject}; };

test('latest file wins even when an older file finishes later', async () => {
  const queue = new LatestImport(); const a=deferred(), b=deferred(); let current='old';
  const handlers = {success:asset => {current=asset;}, failure:() => assert.fail('unexpected failure')};
  const first=queue.run(()=>a.promise,handlers); const second=queue.run(()=>b.promise,handlers);
  b.resolve('newest'); await second; a.resolve('outdated'); await first;
  assert.equal(current,'newest');
});
test('latest failure preserves current asset and suppresses stale success/error', async () => {
  const queue=new LatestImport(); const a=deferred(), b=deferred(); let current='usable'; let error='';
  const handlers={success:asset=>{current=asset;},failure:e=>{error=e.message;}};
  const first=queue.run(()=>a.promise,handlers); const second=queue.run(()=>b.promise,handlers);
  b.reject(new Error('broken')); await second; a.resolve('stale'); await first;
  assert.equal(current,'usable'); assert.equal(error,'broken');
});
test('disposal prevents updating an unmounted scene', async () => {
  const queue=new LatestImport(); const pending=deferred(); let updates=0;
  const run=queue.run(()=>pending.promise,{success:()=>updates++,failure:()=>updates++});
  queue.dispose(); pending.resolve('asset'); await run; assert.equal(updates,0);
});
