import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verificar } from '../mcp/lib/verificar.mjs';

const archivo = (filename, lineas) => ({
  filename,
  status: 'added',
  patch: `@@ -0,0 +1,${lineas.length} @@\n${lineas.map((l) => `+${l}`).join('\n')}`,
});

test('tipo-any flags any in parameters, generics and arrays, also in tests', () => {
  const { hallazgos } = verificar({
    repo: 'demo',
    archivos: [archivo('src/__tests__/a.spec.ts', [
      '(_req: any, res: any) =>',
      'const x = <any>y;',
      'let l: any[] = [];',
      'const z = y as any;',
    ])],
  });

  const tipos = hallazgos.filter((h) => h.regla === 'tipo-any');
  assert.deepEqual(tipos.map((h) => h.linea), [1, 2, 3]);
  assert.ok(tipos.every((h) => h.severidad === 'aviso' && h.titulo === 'Typing with `any`'));
  assert.equal(tipos.some((h) => h.linea === 4), false);
  // as-any stays excluded for tests, as before.
  assert.equal(hallazgos.some((h) => h.regla === 'as-any'), false);
});

test('tipo-any ignores files that are not TypeScript', () => {
  const { hallazgos } = verificar({
    repo: 'demo',
    archivos: [archivo('src/a.js', ['function f(a: any) {}'])],
  });
  assert.equal(hallazgos.some((h) => h.regla === 'tipo-any'), false);
});

test('tipo-any flags any as a generic argument', () => {
  const { hallazgos } = verificar({
    repo: 'demo',
    archivos: [archivo('src/a.ts', [
      'const r: Record<string, any> = {};',
      'const m = new Map<K, any>();',
      'async function f(): Promise<any> {}',
      'let a: Array<any> = [];',
    ])],
  });
  assert.deepEqual(hallazgos.filter((h) => h.regla === 'tipo-any').map((h) => h.linea), [1, 2, 3, 4]);
});

test('tipo-any does not flag a line with only as any', () => {
  const { hallazgos } = verificar({
    repo: 'demo',
    archivos: [archivo('src/a.ts', ['const z = y as any;', 'const q = (y as any[]);'])],
  });
  assert.equal(hallazgos.some((h) => h.regla === 'tipo-any'), false);
  assert.equal(hallazgos.filter((h) => h.regla === 'as-any').length, 2);
});

test('tipo-any reports a mixed line once', () => {
  const { hallazgos } = verificar({
    repo: 'demo',
    archivos: [archivo('src/a.ts', ['const w = (y as any) as Map<string, any>;'])],
  });
  const tipos = hallazgos.filter((h) => h.regla === 'tipo-any');
  assert.deepEqual(tipos.map((h) => h.linea), [1]);
});

test('tipo-any flags any in unions, intersections, aliases and constraints', () => {
  const { hallazgos } = verificar({
    repo: 'demo',
    archivos: [archivo('src/a.ts', [
      'let s: string | any;',
      'let n: any | null;',
      'type U = A & any;',
      'type X = any;',
      'function f<T extends any>() {}',
    ])],
  });
  assert.deepEqual(hallazgos.filter((h) => h.regla === 'tipo-any').map((h) => h.linea), [1, 2, 3, 4, 5]);
});

test('tipo-any leaves identifiers, logical or, and plain assignments alone', () => {
  const { hallazgos } = verificar({
    repo: 'demo',
    archivos: [archivo('src/a.ts', [
      'const a = anything;',
      'const m: many[] = [];',
      'const x = any;',
      'const q = a || any;',
      'const z = y as any;',
    ])],
  });
  assert.equal(hallazgos.some((h) => h.regla === 'tipo-any'), false);
});

test('tipo-any flags any in a generic alias', () => {
  const { hallazgos } = verificar({
    repo: 'demo',
    archivos: [archivo('src/a.ts', [
      'type X<T> = any;',
      'type Y<T extends string, U> = any;',
    ])],
  });
  assert.deepEqual(hallazgos.filter((h) => h.regla === 'tipo-any').map((h) => h.linea), [1, 2]);
});

test('tipo-any leaves logical and alone', () => {
  const { hallazgos } = verificar({
    repo: 'demo',
    archivos: [archivo('src/a.ts', [
      'const p = a && any;',
      'x = any && y;',
    ])],
  });
  assert.equal(hallazgos.some((h) => h.regla === 'tipo-any'), false);
});

test('tipo-any flags aliases whose type parameters contain nested angle brackets or defaults', () => {
  const { hallazgos } = verificar({
    repo: 'demo',
    archivos: [archivo('src/a.ts', [
      'type X<T extends Record<string, unknown>> = any;',
      'type X<T = {a:1}> = any;',
      'export type X<T> = any;',
      'export declare type Z = any',
    ])],
  });
  assert.deepEqual(hallazgos.filter((h) => h.regla === 'tipo-any').map((h) => h.linea), [1, 2, 3, 4]);
});

test('tipo-any alias form does not fire on an arrow function type returning any', () => {
  const { hallazgos } = verificar({
    repo: 'demo',
    archivos: [archivo('src/a.ts', [
      'type Fn = (x: T) => any',
      'type Fn2<T> = (x: T) => any;',
    ])],
  });
  assert.equal(hallazgos.some((h) => h.regla === 'tipo-any'), false);
});

test('tipo-any keeps aliases followed by a comment or more code on the same line', () => {
  const { hallazgos } = verificar({
    repo: 'demo',
    archivos: [archivo('src/a.ts', [
      'type X = any; // TODO',
      'type X = any /* why */',
      'namespace N { type X = any; }',
      'type X = any; const y = 1;',
    ])],
  });
  assert.deepEqual(hallazgos.filter((h) => h.regla === 'tipo-any').map((h) => h.linea), [1, 2, 3, 4]);
});

test('tipo-any stays linear on long adversarial lines', () => {
  const n = 200000;
  const t = Date.now();
  verificar({
    repo: 'demo',
    archivos: [archivo('src/a.ts', [
      `type a = any${' '.repeat(n)}x`,
      `type ${'a'.repeat(n)}`,
      `type a${'<'.repeat(n)}`,
      `: ${' '.repeat(n)}`,
      ', '.repeat(n),
      '|'.repeat(n),
    ])],
  });
  // Linear: about 10 ms here. The quadratic alias form of round 4 (`^\s*…type\s+\w{1,80}.{0,300}=\s*any\s*;?\s*$`)
  // took about 16 s at this size (measured 2026-11-09), so the threshold is orders of magnitude from both.
  const ms = Date.now() - t;
  assert.ok(ms < 1500, `took ${ms} ms`);
});

test('tipo-any skips comment lines but not a trailing comment', () => {
  const { hallazgos } = verificar({
    repo: 'demo',
    archivos: [archivo('src/a.ts', [
      '// type Viejo = any;',
      '  /* x: any */',
      '   * @param x: any',
      'type Nuevo = any; // por qué',
      'let y: any = 1;',
    ])],
  });
  assert.deepEqual(hallazgos.filter((h) => h.regla === 'tipo-any').map((h) => h.linea), [4, 5]);
});
