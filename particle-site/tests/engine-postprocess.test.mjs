import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const bundler = require.resolve('esbuild');
const { build } = await import(pathToFileURL(bundler).href);
const bundled = await build({ entryPoints: ['src/ParticlePostProcessing.ts'], bundle: true, write: false,
  platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent' });
const { ParticlePostProcessing } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('surface bloom extracts highlights and suppresses the wide silhouette mips', () => {
  const pass = Object.create(ParticlePostProcessing.prototype);
  pass.bloom = { compositeMaterial: { uniforms: { bloomFactors: { value: null } } } };
  pass.renderer = {};
  pass.contrastUniform = { value: 1 };
  pass.configure(0.5, 1.25, 1.1, true);
  assert.equal(pass.bloom.threshold, 0.55);
  assert.equal(pass.bloom.radius, 0);
  assert.equal(pass.bloom.strength, 0.16);
  assert.deepEqual(pass.bloom.compositeMaterial.uniforms.bloomFactors.value, [1, 0.22, 0.025, 0, 0]);
  assert.equal(pass.renderer.toneMappingExposure, 1.25);
  assert.equal(pass.contrastUniform.value, 1.1);
  pass.configure(0.5, 1.3, 1);
  assert.equal(pass.bloom.threshold, 0.08);
  assert.equal(pass.bloom.strength, 0.45);
  assert.deepEqual(pass.bloom.compositeMaterial.uniforms.bloomFactors.value, [1, 0.8, 0.6, 0.4, 0.2]);
  pass.configure(0, 1.3, 1, true);
  assert.equal(pass.bloom.enabled, false);
});
