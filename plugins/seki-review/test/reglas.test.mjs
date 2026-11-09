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
