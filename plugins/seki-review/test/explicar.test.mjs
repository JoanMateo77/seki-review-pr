import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptExplicar, recortarDiff } from '../mcp/lib/explicar.mjs';

const pr = { id: 'api#7', repo: 'api', numero: 7, titulo: 'fix: algo', base: 'main', rama: 'fix/algo', adiciones: 10, eliminaciones: 2 };
const largo = { filename: 'a.ts', status: 'modified', additions: 3000, deletions: 0, patch: '@@ -1,1 +1,3000 @@\n' + Array.from({ length: 3000 }, (_, i) => `+l${i}`).join('\n') };

test('promptExplicar trae descripción, verificaciones y diff recortado a 1500 líneas', () => {
  const t = promptExplicar({ pr, proyecto: 'demo', detalle: { body: 'Arregla el caso 12.', commits: [{ messageHeadline: 'fix uno' }] }, archivos: [largo, { filename: 'b.ts', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+b' }], verificaciones: { resumen: { alto: 1 }, hallazgos: [{ severidad: 'alto', titulo: 'SQL', archivo: 'a.ts', linea: 3, mensaje: 'Parametrizar' }] }, checkout: '/x/api' });
  assert.match(t, /Arregla el caso 12\./);
  assert.match(t, /fix uno/);
  assert.match(t, /alto · SQL · a\.ts:3 · Parametrizar/);
  assert.ok(t.split('\n').filter((l) => /^\+l\d+$/.test(l)).length <= 1500);
  assert.match(t, /b\.ts: sin diff en el mensaje/);
  assert.match(t, /\/x\/api/);
  assert.match(t, /pr_guardar_explicacion/);
});

test('recortarDiff informa la cobertura: archivos sin diff y recortados', () => {
  const chico = { filename: 'b.ts', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+b' };
  assert.deepEqual(recortarDiff([chico]).cobertura, { completa: true, archivos: 1, sinDiff: [], recortados: [] });
  const { cobertura } = recortarDiff([largo, chico, { filename: 'img.png', status: 'added', additions: 0, deletions: 0 }]);
  assert.deepEqual(cobertura, { completa: false, archivos: 3, sinDiff: ['b.ts', 'img.png'], recortados: ['a.ts'] });
});

test('promptExplicar pide decir en riesgos lo que no se revisó cuando la cobertura es parcial', () => {
  const t = promptExplicar({ pr, proyecto: 'demo', detalle: null, archivos: [largo], verificaciones: null, checkout: '/x' });
  assert.match(t, /## Cobertura parcial/);
  assert.match(t, /decirlo en riesgos/);
  const completo = promptExplicar({ pr, proyecto: 'demo', detalle: null, archivos: [{ filename: 'b.ts', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+b' }], verificaciones: null, checkout: '/x' });
  assert.doesNotMatch(completo, /Cobertura parcial/);
});
