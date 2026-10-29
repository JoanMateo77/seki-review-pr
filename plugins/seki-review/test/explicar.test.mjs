import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archivosLeidos, coberturaReal, escribirParches, prioridad, promptExplicar, recortarDiff } from '../mcp/lib/explicar.mjs';

const pr = { id: 'api#7', repo: 'api', numero: 7, titulo: 'fix: algo', base: 'main', rama: 'fix/algo', adiciones: 10, eliminaciones: 2 };
const largo = { filename: 'src/a.ts', status: 'modified', additions: 3000, deletions: 0, patch: '@@ -1,1 +1,3000 @@\n' + Array.from({ length: 3000 }, (_, i) => `+l${i}`).join('\n') };
const chico = (filename) => ({ filename, status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+x' });

test('prioridad: schema and code first, screens, tests and documentation last, generated files out', () => {
  assert.deepEqual(['db/migrations/1.sql', 'src/services/goals.ts', 'src/screens/Today.tsx', 'src/lib/x.test.ts', 'README.md', 'package-lock.json'].map(prioridad), [0, 1, 2, 3, 4, 9]);
});

test('recortarDiff splits the budget: a huge file does not crowd out the rest and generated files stay out', () => {
  const r = recortarDiff([chico('src/x.test.ts'), chico('package-lock.json'), largo, chico('src/screens/A.tsx'), chico('src/lib/b.ts')]);
  assert.deepEqual(r.cobertura, { completa: false, archivos: 5, sinDiff: [], recortados: ['src/a.ts'], generados: ['package-lock.json'] });
  assert.deepEqual(r.diffs.map((d) => d.split(' ')[1]), ['src/a.ts', 'src/lib/b.ts', 'src/screens/A.tsx', 'src/x.test.ts']);
  assert.ok(r.diffs.join('\n').split('\n').filter((l) => /^\+l\d+$/.test(l)).length <= 1500);
});

test('recortarDiff leaves the lowest priority files without diff in the message when the budget runs out', () => {
  const muchos = Array.from({ length: 8 }, (_, i) => ({ ...largo, filename: `src/m${i}.ts` }));
  const r = recortarDiff([chico('src/z.test.ts'), ...muchos]);
  assert.deepEqual(r.cobertura.sinDiff, ['src/m5.ts', 'src/m6.ts', 'src/m7.ts', 'src/z.test.ts']);
  assert.deepEqual(r.cobertura.recortados, ['src/m0.ts', 'src/m1.ts', 'src/m2.ts', 'src/m3.ts', 'src/m4.ts']);
});

test('promptExplicar lists the on-disk patches of what did not come in full', () => {
  const t = promptExplicar({ pr, proyecto: 'demo', detalle: { body: 'Arregla el caso 12.', commits: [{ messageHeadline: 'fix uno' }] }, archivos: [largo, chico('src/b.ts')], verificaciones: { hallazgos: [{ severidad: 'alto', titulo: 'SQL', archivo: 'src/a.ts', linea: 3, mensaje: 'Parametrizar' }] }, parches: { 'src/a.ts': '/p/src/a.ts.patch' }, copia: '/c' });
  assert.match(t, /Arregla el caso 12\./);
  assert.match(t, /alto · SQL · src\/a\.ts:3 · Parametrizar/);
  assert.match(t, /## Patches that did not come in full in the message/);
  assert.match(t, /- src\/a\.ts \(truncated in the message\): \/p\/src\/a\.ts\.patch/);
  assert.match(t, /read-only copy of the PR/);
  assert.doesNotMatch(promptExplicar({ pr, proyecto: 'demo', archivos: [chico('src/b.ts')] }), /Patches that did not come/);
});

test('promptExplicar in completar mode brings the current explanation and only the missing files', () => {
  const t = promptExplicar({ pr, proyecto: 'demo', archivos: [chico('src/a.ts'), chico('src/b.ts')], previa: { resumen: 'Hace X' }, foco: ['src/b.ts'] });
  assert.match(t, /Current explanation \(complete it, do not redo it\)/);
  assert.match(t, /### src\/b\.ts/);
  assert.doesNotMatch(t, /### src\/a\.ts/);
  assert.match(t, /keep what is still true/);
});

test('escribirParches writes one patch per file at its path', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'seki-par-')), 'p');
  const rutas = escribirParches(dir, [chico('src/a.ts'), { filename: 'img.png', status: 'added' }]);
  assert.deepEqual(Object.keys(rutas), ['src/a.ts']);
  assert.equal(readFileSync(rutas['src/a.ts'], 'utf8'), '@@ -0,0 +1 @@\n+x');
});

test('real coverage counts what the AI read separately, by patch or in the copy, and adds what a previous pass read', () => {
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

test('promptExplicar asks to save with the analyzed commit, not the one the PR has when it finishes', () => {
  const sha = 'a'.repeat(40);
  assert.match(promptExplicar({ pr: { ...pr, headSha: sha }, proyecto: 'demo', archivos: [chico('src/a.ts')] }), new RegExp(`headSha "${sha}"`));
  assert.match(promptExplicar({ pr: { ...pr, headSha: sha }, proyecto: 'demo', archivos: [chico('src/a.ts')], previa: { resumen: 'X' }, foco: ['src/a.ts'] }), new RegExp(`headSha "${sha}"`));
});
