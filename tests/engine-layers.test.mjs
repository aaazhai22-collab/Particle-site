import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const { outputText } = ts.transpileModule(await readFile(new URL('../src/particleLayers.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { layerBudgets, ambientPhase, motionTime } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('new layers have bounded budgets independent from the unchanged main count', () => {
  assert.deepEqual(layerBudgets(30000, true, 0.02, 0.5), { ambient: 600, filaments: 900 });
  assert.deepEqual(layerBudgets(500000, true, 0.08, 1), { ambient: 16000, filaments: 1000 });
  assert.deepEqual(layerBudgets(30000, false, 0.02, 0.5), { ambient: 0, filaments: 0 });
  assert.deepEqual(layerBudgets(30000, true, 0, 0), { ambient: 0, filaments: 0 });
});

test('ambient phase advances during a held shape but closes exactly at a 36-second seam', () => {
  assert.equal(ambientPhase(0, 0.5, 36, true), ambientPhase(36, 0.5, 36, true));
  assert.notEqual(ambientPhase(1, 0.5, 36, true), ambientPhase(2, 0.5, 36, true));
  assert.equal(ambientPhase(17, 0, 36, true), 0);
  assert.equal(ambientPhase(12, 0.5, 36, true), ambientPhase(12, 0.5, 36, true));
  assert.ok(ambientPhase(100, 0.5, 36, false) > ambientPhase(99, 0.5, 36, false));
});

test('motion time is directly addressable and independent from render history', () => {
  assert.equal(motionTime(12, 0.5), 6);
  assert.equal(motionTime(-1, 2), 0);
  assert.equal(motionTime(Infinity, 2), 0);
  assert.equal(motionTime(12, NaN), 0);
});
