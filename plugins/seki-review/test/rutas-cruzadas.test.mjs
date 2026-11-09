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
  '+router.post("/v1/crear-orden", mw, ctl);',
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
  assert.deepEqual(r.agregadas, [{ ruta: '/v1/crear-orden', archivo: 'src/r.ts', linea: 12 }]);
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
  { repo: 'web', rama: 'main', dir: '/x' },
  { repo: 'roto', rama: 'main', dir: '/y', falla: 'no clone' },
];

test('an added route already called in another repo is high and a removed one still called is blocking', async () => {
  const llamadas = [];
  const grep = async (dir, ruta) => { llamadas.push([dir, ruta]); return [{ archivo: 'src/api.ts', linea: 7, texto: `get('${ruta}')` }]; };
  const h = await buscarRutas({
    rutas: { agregadas: [{ ruta: '/nueva/ruta', archivo: 'r.ts', linea: 3 }], quitadas: [{ ruta: '/vieja/ruta', archivo: 'r.ts', linea: 9 }] },
    otros, grep,
  });
  assert.equal(llamadas.length, 2);
  assert.ok(llamadas.every(([d]) => d === '/x'));
  const alto = h.find((x) => x.severidad === 'alto');
  const bloq = h.find((x) => x.severidad === 'bloqueante');
  assert.equal(alto.mensaje, 'web (main) already calls /nueva/ruta at src/api.ts:7; this PR must be deployed first.');
  assert.equal(bloq.mensaje, 'web (main) still calls /vieja/ruta at src/api.ts:7.');
  assert.deepEqual([alto.regla, alto.archivo, alto.linea, alto.texto, alto.repoOtro, alto.rama, alto.archivoOtro, alto.lineaOtro],
    ['rutas-en-otros-repos', 'r.ts', 3, '/nueva/ruta', 'web', 'main', 'src/api.ts', 7]);
  assert.ok(alto.titulo && alto.origen);
  assert.equal(bloq.linea, 9);
});

test('at most 3 hits per route and repo and 20 routes per PR', async () => {
  const cinco = async (d, ruta) => Array.from({ length: 5 }, (_, i) => ({ archivo: `f${i}.ts`, linea: i + 1, texto: `get('${ruta}')` }));
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
  assert.deepEqual(await grepGit(dir, '/v1/pago.x'), [{ archivo: 'api.ts', linea: 2, texto: 'fetch("/v1/pago.x")' }]);
  assert.deepEqual(await grepGit(dir, '/v1/pagoXx'), []);
  assert.deepEqual(await grepGit(dir, '-e /v1'), []);
});

test('routes declared across lines are read at the literal line', () => {
  const p = '@@ -5,3 +5,5 @@\n+router.post(\n+    "/v1/crear-orden-ref",\n+    verificarCaptcha("x"),\n';
  const q = '@@ -20,3 +20,1 @@\n-router.delete(  \n-    \'/borrarAlgoViejo\',\n-    mw,\n';
  const r = rutasDelDiff([{ filename: 'r.ts', status: 'modified', patch: `${p}${q}` }]);
  assert.deepEqual(r.agregadas, [{ ruta: '/v1/crear-orden-ref', archivo: 'r.ts', linea: 6 }]);
  assert.deepEqual(r.quitadas, [{ ruta: '/borrarAlgoViejo', archivo: 'r.ts', linea: 21 }]);
});

test('duplicate routes are searched once, before the 20-route cap', async () => {
  const dup = Array.from({ length: 30 }, (_, i) => ({ ruta: `/ruta/n${i % 2}`, archivo: `f${i}.ts`, linea: i }));
  const resto = Array.from({ length: 19 }, (_, i) => ({ ruta: `/otra/n${i}`, archivo: 'r.ts', linea: i }));
  const buscadas = [];
  await buscarRutas({ rutas: { agregadas: [...dup, ...resto], quitadas: [] }, otros, grep: async (d, r) => { buscadas.push(r); return []; } });
  assert.equal(buscadas.length, 20);
  assert.equal(new Set(buscadas).size, 20);
  const hallazgos = await buscarRutas({ rutas: { agregadas: dup.slice(0, 4), quitadas: [] }, otros, grep: async (d, r) => [{ archivo: 'w.ts', linea: 1, texto: `get('${r}')` }] });
  assert.deepEqual(hallazgos.map((x) => [x.texto, x.archivo, x.linea]), [['/ruta/n0', 'f0.ts', 0], ['/ruta/n1', 'f1.ts', 1]]);
});

const agregadasDe = (lineas) => rutasDelDiff([{ filename: 'src/x.ts', status: 'modified', patch: `@@ -1,1 +1,${lineas.length} @@\n${lineas.map((l) => `+${l}`).join('\n')}\n` }]).agregadas;

test('client calls and mounted prefixes are not route declarations', () => {
  assert.deepEqual(agregadasDe(["axios.post('/v1/crear-orden', datos);", "fetch('/v1/crear-orden');", "api.get('/v1/lista-ordenes');", "app.use('/api/v1', router);", "router.use('/v1/ordenes', r);"]), []);
  assert.deepEqual(agregadasDe(['axios.post(', "  '/v1/crear-orden',"]), []);
});

test('express receivers declare routes: app, router, *Router, routes and rutas*', () => {
  const r = agregadasDe(["app.get('/v1/uno-a', c);", "ordenesRouter.post('/v1/dos-b', c);", "this.router.put('/v1/tres-c', c);", "routes.patch('/v1/cuatro', c);",
    "route.delete('/v1/cinco-e', c);", "rutasPago.all('/v1/seis-f', c);", "miRouter .get('/v1/siete', c);"]);
  assert.deepEqual(r.map((x) => x.ruta), ['/v1/uno-a', '/v1/dos-b', '/v1/tres-c', '/v1/cuatro', '/v1/cinco-e', '/v1/seis-f', '/v1/siete']);
});

test('a multi-line declaration skips blank and comment lines before the literal', () => {
  const r = agregadasDe(['router.post(', '', '  // crea la orden', '  /* nota */', '   * sigue', '  "/v1/crear-orden",', '  ctl);', 'router.get(', '  mw,', "  '/v1/no-leida',"]);
  assert.deepEqual(r, [{ ruta: '/v1/crear-orden', archivo: 'src/x.ts', linea: 6 }]);
});

test('a hit that declares the same route in the other repo is not a call; a client call is', async () => {
  const hits = [
    { archivo: 'src/rutas.ts', linea: 4, texto: "router.post('/v1/crear-orden', ctl);" },
    { archivo: 'src/api.ts', linea: 9, texto: 'axios.post(`${API}/v1/crear-orden`, datos);' },
  ];
  const h = await buscarRutas({ rutas: { agregadas: [{ ruta: '/v1/crear-orden', archivo: 'r.ts', linea: 1 }], quitadas: [] }, otros, grep: async () => hits });
  assert.deepEqual(h.map((x) => [x.archivoOtro, x.lineaOtro]), [['src/api.ts', 9]]);
});

test('a line that declares one route and opens another reads each once', () => {
  assert.deepEqual(agregadasDe(["router.get('/v1/primera', c); router.post(", "  '/v1/segunda',"]).map((x) => [x.ruta, x.linea]), [['/v1/primera', 1], ['/v1/segunda', 2]]);
});

const usosDe = async (ruta, textos, archivo = 'src/api.ts') => buscarRutas({
  rutas: { agregadas: [{ ruta, archivo: 'r.ts', linea: 1 }], quitadas: [] }, otros,
  grep: async () => textos.map((texto, i) => ({ archivo, linea: i + 1, texto })),
});

test('a route that is a prefix of another is not a use of it, unless a whole segment ends it', async () => {
  const sin = ['fetch(`${API}/v2/ordersBulk`);', 'fetch(`${API}/v2/orders/${id}`);', "fetch('/v2/orders/:id');", 'fetch(`/v2/orders/{id}`);', 'fetch("/v2/orders-old");'];
  assert.deepEqual(await usosDe('/v2/orders', sin), []);
  for (const texto of ["fetch('/v2/orders');", 'fetch(`${API}/v2/orders?x=1`);', "fetch('/v2/orders/');", "x = '/v2/orders'", 'get("/v2/orders", {})']) {
    assert.equal((await usosDe('/v2/orders', [texto])).length, 1, texto);
  }
  assert.equal((await usosDe('/v2/orders', ['a("/v2/ordersBulk"); b("/v2/orders");'])).length, 1);
});

test('hits in tests and docs are flagged and real hits come first within the cap of 3', async () => {
  const hits = [
    { archivo: 'docs/api.md', linea: 1, texto: 'GET /v2/orders' },
    { archivo: 'openapi.test.ts', linea: 2, texto: "get('/v2/orders')" },
    { archivo: 'src/__mocks__/a.ts', linea: 3, texto: "'/v2/orders'" },
    { archivo: 'src/real.ts', linea: 4, texto: "fetch('/v2/orders')" },
    { archivo: 'e2e/x.ts', linea: 5, texto: "'/v2/orders'" },
    { archivo: 'src/real2.ts', linea: 6, texto: "fetch('/v2/orders')" },
  ];
  const h = await buscarRutas({ rutas: { agregadas: [], quitadas: [{ ruta: '/v2/orders', archivo: 'r.ts', linea: 9 }] }, otros, grep: async () => hits });
  assert.deepEqual(h.map((x) => [x.archivoOtro, Boolean(x.soloPruebas)]), [['src/real.ts', false], ['src/real2.ts', false], ['docs/api.md', true]]);
  assert.ok(!('soloPruebas' in h[0]));
  assert.equal(h[2].severidad, 'bloqueante');
  assert.equal(h[2].mensaje, 'web (main) still calls /v2/orders at docs/api.md:1, a test or documentation file.');
  const solo = await usosDe('/v2/orders', ["x('/v2/orders')"], 'spec/api.spec.ts');
  assert.equal(solo[0].soloPruebas, true);
  assert.equal(solo[0].mensaje, 'web (main) references /v2/orders at spec/api.spec.ts:1, a test or documentation file.');
  for (const archivo of ['a/test/x.js', 'a/tests/x.js', 'a/mock/x.js', 'a/doc/x.js', 'x.test.mjs', 'x.spec.tsx', 'README.md', 'a.mdx', 'n.txt']) {
    assert.equal((await usosDe('/v2/orders', ["x('/v2/orders')"], archivo))[0].soloPruebas, true, archivo);
  }
  assert.ok(!(await usosDe('/v2/orders', ["x('/v2/orders')"], 'src/contest/x.ts'))[0].soloPruebas);
});

test('router.route(...) declares the route whatever verb is chained, also across lines', () => {
  assert.deepEqual(agregadasDe(["router.route('/v2/orders').post(h);"]), [{ ruta: '/v2/orders', archivo: 'src/x.ts', linea: 1 }]);
  assert.deepEqual(agregadasDe(["app.route('/v2/cuentas')", '  .get(a)', '  .delete(b);']).map((x) => x.ruta), ['/v2/cuentas']);
  assert.deepEqual(agregadasDe(['this.api.route(', "  '/v2/multi-linea',", ').put(h);']).map((x) => [x.ruta, x.linea]), [['/v2/multi-linea', 2]]);
  assert.deepEqual(agregadasDe(["router.route('/v2/a-uno').get(h).route('/v2/b-dos').post(h);"]).map((x) => x.ruta), ['/v2/a-uno', '/v2/b-dos']);
});

test('a hit that declares the route with .route() is not a call', async () => {
  assert.deepEqual(await usosDe('/v2/orders', ["router.route('/v2/orders').post(h);"]), []);
});

test('a hit without text is not a finding', async () => {
  const h = await buscarRutas({ rutas: { agregadas: [{ ruta: '/v2/orders', archivo: 'r.ts', linea: 1 }], quitadas: [] }, otros, grep: async () => [{ archivo: 'src/api.ts', linea: 7 }] });
  assert.deepEqual(h, []);
});

test('a route ending in a slash does not match a longer segment, and a regex metacharacter is literal', async () => {
  assert.deepEqual(await usosDe('/v2/orders/', ['get(`/v2/orders/${id}`)', "get('/v2/orders/abc')", "get('/v2/orders/:id')"]), []);
  assert.equal((await usosDe('/v2/orders/', ["get('/v2/orders/')"])).length, 1);
  assert.equal((await usosDe('/v2/items.json', ['get("/v2/items.json")'])).length, 1);
  assert.deepEqual(await usosDe('/v2/items.json', ["get('/v2/itemsXjson')"]), []);
});
