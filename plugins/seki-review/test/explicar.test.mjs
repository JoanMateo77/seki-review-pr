import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archivosLeidos, coberturaReal, escribirParches, prioridad, promptExplicar, recortarDiff } from '../mcp/lib/explicar.mjs';

const pr = { id: 'api#7', repo: 'api', numero: 7, titulo: 'fix: algo', base: 'main', rama: 'fix/algo', adiciones: 10, eliminaciones: 2 };
const largo = { filename: 'src/a.ts', status: 'modified', additions: 3000, deletions: 0, patch: '@@ -1,1 +1,3000 @@\n' + Array.from({ length: 3000 }, (_, i) => `+l${i}`).join('\n') };
const chico = (filename) => ({ filename, status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+x' });

test('prioridad: esquema y código primero, pantallas, pruebas y documentación al final, lo generado fuera', () => {
  assert.deepEqual(['db/migrations/1.sql', 'src/services/goals.ts', 'src/screens/Today.tsx', 'src/lib/x.test.ts', 'README.md', 'package-lock.json'].map(prioridad), [0, 1, 2, 3, 4, 9]);
});

test('recortarDiff reparte el cupo: un archivo enorme no deja fuera a los demás y lo generado no entra', () => {
  const r = recortarDiff([chico('src/x.test.ts'), chico('package-lock.json'), largo, chico('src/screens/A.tsx'), chico('src/lib/b.ts')]);
  assert.deepEqual(r.cobertura, { completa: false, archivos: 5, sinDiff: [], recortados: ['src/a.ts'], generados: ['package-lock.json'] });
  assert.deepEqual(r.diffs.map((d) => d.split(' ')[1]), ['src/a.ts', 'src/lib/b.ts', 'src/screens/A.tsx', 'src/x.test.ts']);
  assert.ok(r.diffs.join('\n').split('\n').filter((l) => /^\+l\d+$/.test(l)).length <= 1500);
});

test('recortarDiff deja sin diff en el mensaje lo de menor prioridad cuando el cupo no alcanza', () => {
  const muchos = Array.from({ length: 8 }, (_, i) => ({ ...largo, filename: `src/m${i}.ts` }));
  const r = recortarDiff([chico('src/z.test.ts'), ...muchos]);
  assert.deepEqual(r.cobertura.sinDiff, ['src/m5.ts', 'src/m6.ts', 'src/m7.ts', 'src/z.test.ts']);
  assert.deepEqual(r.cobertura.recortados, ['src/m0.ts', 'src/m1.ts', 'src/m2.ts', 'src/m3.ts', 'src/m4.ts']);
});

test('promptExplicar lista los parches en disco de lo que no vino completo', () => {
  const t = promptExplicar({ pr, proyecto: 'demo', detalle: { body: 'Arregla el caso 12.', commits: [{ messageHeadline: 'fix uno' }] }, archivos: [largo, chico('src/b.ts')], verificaciones: { hallazgos: [{ severidad: 'alto', titulo: 'SQL', archivo: 'src/a.ts', linea: 3, mensaje: 'Parametrizar' }] }, parches: { 'src/a.ts': '/p/src/a.ts.patch' }, copia: '/c' });
  assert.match(t, /Arregla el caso 12\./);
  assert.match(t, /alto · SQL · src\/a\.ts:3 · Parametrizar/);
  assert.match(t, /## Parches que no vinieron completos en el mensaje/);
  assert.match(t, /- src\/a\.ts \(recortado en el mensaje\): \/p\/src\/a\.ts\.patch/);
  assert.match(t, /copia de solo lectura de la PR/);
  assert.doesNotMatch(promptExplicar({ pr, proyecto: 'demo', archivos: [chico('src/b.ts')] }), /Parches que no vinieron/);
});

test('promptExplicar en modo completar trae la explicación actual y solo los archivos que faltaban', () => {
  const t = promptExplicar({ pr, proyecto: 'demo', archivos: [chico('src/a.ts'), chico('src/b.ts')], previa: { resumen: 'Hace X' }, foco: ['src/b.ts'] });
  assert.match(t, /Explicación actual \(completarla, no rehacerla\)/);
  assert.match(t, /### src\/b\.ts/);
  assert.doesNotMatch(t, /### src\/a\.ts/);
  assert.match(t, /conservar lo que sigue siendo cierto/);
});

test('escribirParches deja un parche por archivo con su ruta', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'seki-par-')), 'p');
  const rutas = escribirParches(dir, [chico('src/a.ts'), { filename: 'img.png', status: 'added' }]);
  assert.deepEqual(Object.keys(rutas), ['src/a.ts']);
  assert.equal(readFileSync(rutas['src/a.ts'], 'utf8'), '@@ -0,0 +1 @@\n+x');
});

test('la cobertura real cuenta lo que la IA leyó aparte, por parche o en la copia, y suma lo de una pasada anterior', () => {
  const base = { completa: false, archivos: 3, sinDiff: ['src/screens/A.tsx', 'src/x.test.ts'], recortados: ['src/a.ts'], generados: [] };
  const leidos = archivosLeidos([
    { nombre: 'Read', entrada: { file_path: '/p/src/screens/A.tsx.patch' } },
    { nombre: 'Read', entrada: { file_path: '/c/src/a.ts', offset: 1, limit: 50 } },
    { nombre: 'Grep', entrada: { pattern: 'x', path: '/c/src/x.test.ts' } },
  ], { parches: { 'src/screens/A.tsx': '/p/src/screens/A.tsx.patch' }, copia: '/c' });
  const c = coberturaReal(base, leidos);
  assert.deepEqual({ ...c, leidosAparte: c.leidosAparte.sort() }, { completa: false, archivos: 3, sinDiff: ['src/x.test.ts'], recortados: [], generados: [], leidosAparte: ['src/a.ts', 'src/screens/A.tsx'] });
  const segunda = coberturaReal({ ...recortarDiff([chico('src/x.test.ts')]).cobertura, archivos: 3 }, new Set(), c);
  assert.equal(segunda.completa, true);
  assert.deepEqual(segunda.leidosAparte.sort(), ['src/a.ts', 'src/screens/A.tsx']);
});

test('promptExplicar pide guardar con el commit analizado, no con el que tenga la PR al terminar', () => {
  const sha = 'a'.repeat(40);
  assert.match(promptExplicar({ pr: { ...pr, headSha: sha }, proyecto: 'demo', archivos: [chico('src/a.ts')] }), new RegExp(`headSha "${sha}"`));
  assert.match(promptExplicar({ pr: { ...pr, headSha: sha }, proyecto: 'demo', archivos: [chico('src/a.ts')], previa: { resumen: 'X' }, foco: ['src/a.ts'] }), new RegExp(`headSha "${sha}"`));
});
