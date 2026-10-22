import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/shaders.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const shaders = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('production GLSL does not declare reserved/future-reserved identifiers', () => {
  // `patch` compiles as ordinary TypeScript template text, but a real WebGL
  // compiler rejects it. Guard that cross-language regression before browser QA.
  const reserved = new Set(`attribute const uniform varying buffer shared coherent volatile restrict readonly writeonly
    atomic_uint layout centroid flat smooth noperspective patch sample break continue do for while switch case default
    if else subroutine in out inout float double int void bool true false invariant precise discard return struct
    common partition active asm class union enum typedef template this resource goto inline noinline public static
    extern external interface long short half fixed unsigned superp input output filter sizeof cast namespace using
    row_major`.split(/\s+/));
  for (const [name, shader] of Object.entries(shaders)) {
    const code = shader.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const match of code.matchAll(/\b(?:float|int|bool|vec[234]|mat[234])\s+([A-Za-z_]\w*)/g)) {
      assert.ok(!reserved.has(match[1]), `${name} declares GLSL reserved identifier ${match[1]}`);
    }
  }
});
