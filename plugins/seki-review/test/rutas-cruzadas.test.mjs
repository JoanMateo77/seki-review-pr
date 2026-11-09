import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lineasQuitadas } from '../mcp/lib/verificar.mjs';
import { rutasDelDiff, buscarRutas, grepGit } from '../mcp/lib/rutas-cruzadas.mjs';
import { sh } from './util/repo.mjs';

const patch = [
  '@@ -10,4 +10,4 @@ x',
  ' ctx',
  "-router.get('/viejaRuta', ctl);",
  ' ctx2',
  '+router.post("/CrearTransaccionMicrositio", mw, ctl);',
  '@@ -40,2 +40,2 @@',
  '-const a = 1;',
  '+const a = 2;',
].join('\n');

test('added and removed express routes are read from the diff', () => {
  assert.deepEqual(lineasQuitadas(patch), [
    { linea: 11, texto: "router.get('/viejaRuta', ctl);" },
    { linea: 40, texto: 'const a = 1;' },
  ]);
  const r = rutasDelDiff([{ filename: 'src/r.ts', status: 'modified', patch }]);
  assert.deepEqual(r.agregadas, [{ ruta: '/CrearTransaccionMicrositio', archivo: 'src/r.ts', linea: 12 }]);
  assert.deepEqual(r.quitadas, [{ ruta: '/viejaRuta', archivo: 'src/r.ts', linea: 11 }]);
});

test('a route moved within the PR, a param-only route and a test file are ignored', () => {
  const mov = (n) => `@@ -1,1 +1,1 @@\n-router.get('/mueve/aqui', c);\n+router.get('/mueve/aqui', c);\n`.replace(/aqui/g, n);
  const r = rutasDelDiff([
    { filename: 'a.ts', status: 'modified', patch: mov('aqui') + "+router.get('/:id', c);\n+router.get('/a/:id', c);\n+router.get('/a/*', c);\n" },
    { filename: 'x.spec.ts', status: 'modified', patch: "@@ -0,0 +1,1 @@\n+router.get('/solo/en/prueba', c);\n" },
  ]);
  assert.deepEqual(r, { agregadas: [], quitadas: [] });
});

const otros = [
  { repo: 'core-checkout', rama: 'main', dir: '/x' },
  { repo: 'roto', rama: 'main', dir: '/y', falla: 'no clone' },
];

test('an added route already called in another repo is high and a removed one still called is blocking', async () => {
  const llamadas = [];
  const grep = async (dir, ruta) => { llamadas.push([dir, ruta]); return [{ archivo: 'src/api.ts', linea: 7 }]; };
  const h = await buscarRutas({
    rutas: { agregadas: [{ ruta: '/nueva/ruta', archivo: 'r.ts', linea: 3 }], quitadas: [{ ruta: '/vieja/ruta', archivo: 'r.ts', linea: 9 }] },
    otros, grep,
  });
  assert.equal(llamadas.length, 2);
  assert.ok(llamadas.every(([d]) => d === '/x'));
  const alto = h.find((x) => x.severidad === 'alto');
  const bloq = h.find((x) => x.severidad === 'bloqueante');
  assert.equal(alto.mensaje, 'core-checkout (main) already calls /nueva/ruta at src/api.ts:7; this PR must be deployed first.');
  assert.equal(bloq.mensaje, 'core-checkout (main) still calls /vieja/ruta at src/api.ts:7.');
  assert.deepEqual([alto.regla, alto.archivo, alto.linea, alto.texto, alto.repoOtro, alto.rama, alto.archivoOtro, alto.lineaOtro],
    ['rutas-en-otros-repos', 'r.ts', 3, '/nueva/ruta', 'core-checkout', 'main', 'src/api.ts', 7]);
  assert.ok(alto.titulo && alto.origen);
  assert.equal(bloq.linea, 9);
});

test('at most 3 hits per route and repo and 20 routes per PR', async () => {
  const cinco = async () => Array.from({ length: 5 }, (_, i) => ({ archivo: `f${i}.ts`, linea: i + 1 }));
  const una = await buscarRutas({ rutas: { agregadas: [{ ruta: '/una/ruta', archivo: 'r.ts', linea: 1 }], quitadas: [] }, otros, grep: cinco });
  assert.equal(una.length, 3);
  const muchas = Array.from({ length: 25 }, (_, i) => ({ ruta: `/ruta/n${i}`, archivo: 'r.ts', linea: i + 1 }));
  const buscadas = new Set();
  await buscarRutas({ rutas: { agregadas: muchas, quitadas: [] }, otros, grep: async (d, r) => { buscadas.add(r); return []; } });
  assert.equal(buscadas.size, 20);
});

test('grepGit finds literal hits, and no match is an empty list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seki-grep-'));
  sh(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'api.ts'), 'a\nfetch("/v1/pago.x")\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-qm', 'c');
  assert.deepEqual(await grepGit(dir, '/v1/pago.x'), [{ archivo: 'api.ts', linea: 2 }]);
  assert.deepEqual(await grepGit(dir, '/v1/pagoXx'), []);
  assert.deepEqual(await grepGit(dir, '-e /v1'), []);
});

test('routes declared across lines are read at the literal line', () => {
  const p = '@@ -5,3 +5,5 @@\n+router.post(\n+    "/CrearTransaccionReferenciaMicrositio",\n+    verificarCaptcha("x"),\n';
  const q = '@@ -20,3 +20,1 @@\n-router.delete(  \n-    \'/borrarAlgoViejo\',\n-    mw,\n';
  const r = rutasDelDiff([{ filename: 'r.ts', status: 'modified', patch: `${p}${q}` }]);
  assert.deepEqual(r.agregadas, [{ ruta: '/CrearTransaccionReferenciaMicrositio', archivo: 'r.ts', linea: 6 }]);
  assert.deepEqual(r.quitadas, [{ ruta: '/borrarAlgoViejo', archivo: 'r.ts', linea: 21 }]);
});

test('duplicate routes are searched once, before the 20-route cap', async () => {
  const dup = Array.from({ length: 30 }, (_, i) => ({ ruta: `/ruta/n${i % 2}`, archivo: `f${i}.ts`, linea: i }));
  const resto = Array.from({ length: 19 }, (_, i) => ({ ruta: `/otra/n${i}`, archivo: 'r.ts', linea: i }));
  const buscadas = [];
  await buscarRutas({ rutas: { agregadas: [...dup, ...resto], quitadas: [] }, otros, grep: async (d, r) => { buscadas.push(r); return []; } });
  assert.equal(buscadas.length, 20);
  assert.equal(new Set(buscadas).size, 20);
});
