import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/publicAssetUrl.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { publicAssetUrl } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('public assets work at the domain root and under the GitHub Pages project path', () => {
  for (const path of ['/examples/uploaded-model.glb', '/examples/ding-reference.jpg', '/examples/color-flower.png']) {
    assert.equal(publicAssetUrl(path, ''), path);
    assert.equal(publicAssetUrl(path, '/Particle-site'), '/Particle-site' + path);
    assert.equal(publicAssetUrl(path, 'Particle-site/'), '/Particle-site' + path);
    assert.equal(publicAssetUrl('/Particle-site' + path, '/Particle-site'), '/Particle-site' + path);
  }
  assert.equal(publicAssetUrl('/Particle-site-extra/model.glb', '/Particle-site'), '/Particle-site/Particle-site-extra/model.glb');
});

test('public asset prefix leaves local object URLs, external URLs, anchors and relative paths intact', () => {
  for (const path of ['blob:https://example.test/image', 'data:image/png;base64,aGVsbG8=', 'https://cdn.example.test/model.glb', '//cdn.example.test/model.glb', '#timeline', 'examples/model.glb']) {
    assert.equal(publicAssetUrl(path, '/Particle-site'), path);
  }
});

test('all editor example fetches, thumbnails, previews and download links use the public asset prefix', async () => {
  const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let exampleCount = 0;
  function visit(node) {
    if (ts.isStringLiteral(node) && node.text.startsWith('/examples/')) {
      exampleCount++;
      assert.ok(ts.isCallExpression(node.parent), `Unprefixed example URL: ${node.text}`);
      assert.equal(node.parent.expression.getText(tree), 'publicAssetUrl', `Unprefixed example URL: ${node.text}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(exampleCount >= 20, 'Expected model loads, thumbnails, images and downloads to be checked.');
});
