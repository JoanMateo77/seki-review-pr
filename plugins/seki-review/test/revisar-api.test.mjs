import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createContext, runInContext, Script } from 'node:vm';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escribirJson, leerJson, rutaInstantanea, rutaRevisar } from '../mcp/lib/cache.mjs';
import { proyecto as cargarProyecto } from '../mcp/lib/config.mjs';
import { detenerServidores, iniciarServidor } from '../mcp/lib/servidor-web.mjs';
import { construirHtml } from '../mcp/lib/tablero.mjs';
import { falsoGhRutas, limpiarGhRutas } from './util/gh-rutas.mjs';

after(detenerServidores);
after(limpiarGhRutas);
const temporales = [];
after(() => { for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true }); });
const previo = { config: process.env.SEKI_REVIEW_CONFIG, gh: process.env.SEKI_GH };
after(() => { for (const [k, v] of [['SEKI_REVIEW_CONFIG', previo.config], ['SEKI_GH', previo.gh]]) v === undefined ? delete process.env[k] : (process.env[k] = v); });

const ghPr = (n, autor = 'otro', extra = {}) => ({
  number: n, title: `pr ${n}`, url: `u/${n}`, baseRefName: 'viejo', headRefName: `rama-${n}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  additions: 1, deletions: 1, changedFiles: 1, isDraft: false, headRefOid: `sha${n}`, author: { login: autor }, reviewDecision: '', body: 'b', state: 'OPEN', ...extra,
});
const rutasBase = (...mas) => [
  { patron: '^api user$', json: { login: 'yo' } },
  ...mas,
  { patron: '^pr list ', json: [] },
  { patron: '^api repos/o/r/pulls\\?base=', json: [] },
  { patron: '^api --paginate --slurp repos/o/r/pulls/\\d+/(files|commits)', json: [[]] },
];
const vista = (n, state = 'OPEN') => ({ patron: `^pr view ${n} -R o/r --json state$`, json: { state, number: n } });
const vistaCompleta = (n) => ({ patron: `^pr view ${n} -R o/r --json number,title,.*,state$`, json: ghPr(n) });

let n = 0;
async function entorno(rutas) {
  const clave = `ri${++n}`;
  const dir = mkdtempSync(join(tmpdir(), 'seki-revisar-api-'));
  temporales.push(dir);
  const salida = join(dir, 'salida');
  mkdirSync(join(salida, 'datos'), { recursive: true });
  const ruta = join(dir, 'proyectos.json');
  writeFileSync(ruta, JSON.stringify({ [clave]: { owner: 'o', autor: 'yo', salida, repos: { r: { lineas: [{ portal: 'P', prod: 'main', pruebas: 'develop' }] } } } }));
  process.env.SEKI_REVIEW_CONFIG = ruta;
  const gh = falsoGhRutas(rutas);
  process.env.SEKI_GH = gh.ruta;
  const p = cargarProyecto(clave);
  escribirJson(rutaInstantanea(salida), { proyecto: clave, generado: new Date().toISOString(), owner: 'o', prs: [], recientes: [] });
  const { url } = await iniciarServidor({ proyecto: clave, puerto: 0, abrir: false });
  const u = new URL(url);
  const token = u.searchParams.get('t');
  const llamar = (r, cuerpo, cabeceras = {}) => fetch(`${u.origin}${r}`, { method: cuerpo === undefined ? 'GET' : 'POST', headers: { 'x-seki-token': token, 'content-type': 'application/json', ...cabeceras }, body: cuerpo === undefined ? undefined : (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)) });
  const esperar = async () => { for (let i = 0; i < 200; i++) { const d = await (await llamar('/api/estado')).json(); if (!d.refrescando) return d; await new Promise((r) => setTimeout(r, 25)); } throw new Error('refresh did not finish'); };
  // One search per repo and refresh: it counts the refreshes of the single configured repo.
  const refrescos = () => gh.llamadas().filter((c) => c.includes('review-requested:@me')).length;
  return { p, gh, llamar, esperar, refrescos, u, token, cerrar: () => llamar('/api/ceder', {}) };
}

test('POST /api/revisar parses, checks the PR is open, lists it and refreshes the repo once', async (t) => {
  const e = await entorno(rutasBase(vista(12), vistaCompleta(12)));
  t.after(e.cerrar);
  const r = await e.llamar('/api/revisar', { enlace: 'https://github.com/o/r/pull/12/files' });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { id: 'r#12', estado: 'agregada' });
  await e.esperar();
  assert.equal(e.refrescos(), 1);
  const foto = await (await e.llamar('/api/foto')).json();
  const item = foto.prs.find((x) => x.id === 'r#12');
  assert.equal(item.paraRevisar, 'enlace');
  assert.equal(item.autor, 'otro');
  assert.deepEqual(leerJson(rutaRevisar(e.p.salida)).prs.map((x) => [x.repo, x.numero, x.origen]), [['r', 12, 'enlace']]);
  // Once it is in the snapshot, adding it again changes nothing and does not refresh.
  const otra = await e.llamar('/api/revisar', { enlace: 'r#12' });
  assert.deepEqual(await otra.json(), { id: 'r#12', estado: 'ya_estaba' });
  await e.esperar();
  assert.equal(e.refrescos(), 1);
});

test('POST /api/revisar answers 400 with a clear message and never calls gh with raw input', async (t) => {
  const e = await entorno(rutasBase());
  t.after(e.cerrar);
  const casos = [
    [{ enlace: 'https://github.com/o/otro/pull/3' }, /The repository o\/otro is not configured in project ri\d+/],
    [{ enlace: 'https://github.com/x/r/pull/3' }, /The repository x\/r is not configured/],
    [{ enlace: 'hola' }, /Expected a PR link/],
    [{ enlace: 'x'.repeat(10240) }, /longer than 500/],
    [{ enlace: 'r#3; rm -rf /' }, /Expected a PR link/],
    [{}, /required/],
    [{ enlace: 42 }, /required/],
  ];
  for (const [cuerpo, mensaje] of casos) {
    const r = await e.llamar('/api/revisar', cuerpo);
    assert.equal(r.status, 400, JSON.stringify(cuerpo).slice(0, 40));
    const d = await r.json();
    assert.match(d.error, mensaje);
    assert.doesNotMatch(d.error, /seki-review/);
  }
  assert.ok(!e.gh.llamadas().some((c) => c[0] === 'pr' && c[1] === 'view'));
  assert.equal(e.refrescos(), 0);
  assert.equal(leerJson(rutaRevisar(e.p.salida), null), null);
});

test('POST /api/revisar answers 409 for a closed or merged PR and 404 when gh cannot read it', async (t) => {
  const e = await entorno(rutasBase(vista(5, 'MERGED'), vista(6, 'CLOSED'), { patron: '^pr view 7 ', salida: 1, stderr: 'secret detail' }));
  t.after(e.cerrar);
  for (const num of [5, 6]) {
    const r = await e.llamar('/api/revisar', { enlace: `r#${num}` });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, `PR r#${num} is closed or merged`);
  }
  const r = await e.llamar('/api/revisar', { enlace: 'r#7' });
  assert.equal(r.status, 404);
  assert.doesNotMatch((await r.json()).error, /secret/);
  assert.equal(leerJson(rutaRevisar(e.p.salida), null), null);
  assert.equal(e.refrescos(), 0);
});

test('revisar endpoints: token, Host, content type and size cap', async (t) => {
  const e = await entorno(rutasBase());
  t.after(e.cerrar);
  for (const ruta of ['/api/revisar', '/api/revisar/quitar']) {
    assert.equal((await fetch(`${e.u.origin}${ruta}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, ruta);
    assert.equal((await e.llamar(ruta, {}, { 'x-seki-token': 'otro' })).status, 403, ruta);
    assert.equal((await e.llamar(ruta, 'enlace=r%231', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415, ruta);
    assert.equal((await e.llamar(ruta, '[]')).status, 400, ruta);
    assert.equal((await e.llamar(ruta, JSON.stringify({ enlace: 'x'.repeat(17 * 1024) }))).status, 413, ruta);
  }
  const estado = await new Promise((ok, falla) => {
    const q = request({ host: '127.0.0.1', port: e.u.port, path: '/api/revisar', method: 'POST', headers: { host: 'evil.test', 'x-seki-token': e.token, 'content-type': 'application/json' } }, (res) => { res.resume(); ok(res.statusCode); });
    q.on('error', falla);
    q.end('{}');
  });
  assert.equal(estado, 421);
});

test('POST /api/revisar/quitar removes a listed PR and refreshes; unknown ids are 404', async (t) => {
  const e = await entorno(rutasBase(vista(12), vistaCompleta(12)));
  t.after(e.cerrar);
  await e.llamar('/api/revisar', { enlace: 'r#12' });
  await e.esperar();
  assert.equal((await e.llamar('/api/revisar/quitar', { id: 'r#99' })).status, 404);
  assert.equal((await e.llamar('/api/revisar/quitar', { id: 'no es un id' })).status, 400);
  assert.equal((await e.llamar('/api/revisar/quitar', {})).status, 400);
  const r = await e.llamar('/api/revisar/quitar', { id: 'r#12' });
  assert.equal(r.status, 202);
  await e.esperar();
  assert.equal(e.refrescos(), 2);
  assert.deepEqual(leerJson(rutaRevisar(e.p.salida)).prs, []);
  assert.deepEqual((await (await e.llamar('/api/foto')).json()).prs, []);
});

test('several additions in a row refresh one after another through the single-flight path', async (t) => {
  const e = await entorno(rutasBase(vista(1), vista(2), vistaCompleta(1), vistaCompleta(2)));
  t.after(e.cerrar);
  const rs = await Promise.all([e.llamar('/api/revisar', { enlace: 'r#1' }), e.llamar('/api/revisar', { enlace: 'r#2' })]);
  assert.deepEqual(rs.map((r) => r.status), [202, 202]);
  for (let i = 0; i < 100 && (await (await e.llamar('/api/foto')).json()).prs.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  await e.esperar();
  assert.deepEqual((await (await e.llamar('/api/foto')).json()).prs.map((x) => x.id).sort(), ['r#1', 'r#2']);
  assert.ok(e.refrescos() <= 2);
});

// The board part, evaluated with minimal stubs like the Ultra renderer.
const PARTES = new URL('../mcp/tablero/partes/', import.meta.url);
function tablero(extra = {}) {
  const escape = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ctx = createContext({
    API: { token: 't' }, FOTO: { owner: 'o', prs: [] }, estado: { cerrados: new Set(), seleccion: null, trabajos: new Map() },
    esc: escape, plural: (a, b, c) => `${a} ${a === 1 ? b : c}`, icono: () => '', $: () => null, senales: () => '', revision: () => null, tono: () => '', comentarios: () => [], copiar() {},
    DECISIONES: { aprobada: ['Approved', 'verde'], probada: ['Verified in testing', 'verde'], duda: ['Has questions', 'ambar'], cambios: ['Requests changes', 'rojo'] },
    avisar() {}, sondear() {}, pintarBarra() {}, pintarTodo() {}, seleccionar() {}, api: async () => ({}),
    document: { addEventListener() {} }, ...extra,
  });
  runInContext(readFileSync(new URL('07c-revisar.js', PARTES), 'utf8'), ctx);
  return ctx;
}

test('revisionMarkdown builds plain Markdown: decision, comments with file and range, notes', () => {
  const md = tablero().revisionMarkdown(
    { id: 'r#1', titulo: 'T' },
    { decision: 'cambios', nota: 'Please add tests.\nAnd docs.' },
    [
      { tipo: 'pregunta', archivo: 'src/a.js', desde: 10, hasta: 12, texto: 'Why a loop?' },
      { tipo: 'cambio', archivo: 'src/b.js', desde: 5, hasta: 5, texto: 'Rename it.' },
      { tipo: 'nota', archivo: 'src/c.js', desde: 7, texto: 'Fine.' },
      { tipo: 'pregunta', archivo: 'src/d.js', desde: 1, hasta: 2, texto: 'Dropped.', estado: 'descartado' },
      { tipo: 'pregunta', ambito: 'pr', texto: 'About the explanation.' },
    ],
  );
  assert.equal(md, [
    'Decision: Requests changes',
    '',
    '**src/a.js:L10–12**',
    'Question: Why a loop?',
    '',
    '**src/b.js:L5**',
    'Rename it.',
    '',
    '**src/c.js:L7**',
    'Fine.',
    '',
    'Notes',
    'Please add tests.\nAnd docs.',
  ].join('\n'));
});

test('revisionMarkdown does not escape and is empty when there is nothing to say', () => {
  const ctx = tablero();
  const md = ctx.revisionMarkdown({ id: 'r#1' }, { decision: 'aprobada' }, [{ tipo: 'nota', archivo: 'a<b>.js', desde: 1, hasta: 1, texto: '<script>x & "y"</script>' }]);
  assert.match(md, /^Decision: Approved\n/);
  assert.match(md, /\*\*a<b>\.js:L1\*\*\n<script>x & "y"<\/script>/);
  assert.equal(ctx.revisionMarkdown({ id: 'r#1' }, null, []), '');
  assert.equal(ctx.revisionMarkdown({ id: 'r#1' }, {}, [{ tipo: 'nota', estado: 'descartado', archivo: 'a', desde: 1, texto: 'x' }]), '');
});

test('the To review grouping follows the owner decision', () => {
  const ctx = tablero();
  const g = (d) => ctx.grupoParaRevisar(d);
  assert.deepEqual([undefined, null, 'duda', 'cambios', 'aprobada', 'probada'].map(g), ['necesita', 'necesita', 'necesita', 'espera_autor', 'aprobada', 'aprobada']);
  const decisiones = { 'r#1': { decision: 'cambios' }, 'r#2': { decision: 'aprobada' }, 'r#3': null };
  const grupos = tablero({ revision: (pr) => decisiones[pr.id] }).agruparParaRevisar([{ id: 'r#1' }, { id: 'r#2' }, { id: 'r#3' }]);
  assert.deepEqual(Object.entries(grupos).map(([k, v]) => [k, Array.from(v, (x) => x.id)]), [['necesita', ['r#3']], ['espera_autor', ['r#1']], ['aprobada', ['r#2']]]);
});

test('an empty list renders no section; filled ones show badge, author and the remove action, escaped', () => {
  const ctx = tablero();
  assert.equal(ctx.seccionParaRevisar([]), '');
  const mal = '<img src=x onerror=x>';
  const html = ctx.seccionParaRevisar([
    { id: 'r#1', repo: 'r', repoEtiqueta: 'r', numero: 1, titulo: mal, autor: mal, paraRevisar: 'solicitada', soloRevision: true },
    { id: 'r#2', repo: 'r', repoEtiqueta: 'r', numero: 2, titulo: 'Two', autor: 'ana', paraRevisar: 'enlace', soloRevision: true },
  ]);
  assert.match(html, /To review/);
  for (const t of ['Needs my review', 'Requested', 'Added by link', 'Remove from To review', 'data-quitar-revisar="r#2"', '@ana']) assert.ok(html.includes(t), t);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /Waiting on the author|Approved by me/);
});

test('an unknown PR route is explained instead of ignored', () => {
  const ctx = tablero();
  assert.match(ctx.mensajeRutaDesconocida('api#12'), /This PR is not in the dashboard\. Paste its link in Review a PR\./);
  for (const v of [undefined, '', 'basura', 'a b#1', '<x>#1', 'r#1x']) assert.equal(ctx.mensajeRutaDesconocida(v), null, String(v));
});

test('the built page carries the Review a PR field, the copy action and compiles', () => {
  const html = construirHtml({ salida: '/nonexistent', ia: {} }, { prs: [] }, { token: 't' });
  for (const marca of ['id="enlaceRevisar"', 'Paste a PR link or repo#number', 'data-copiar-revision', 'Copy review', 'Remove from To review']) assert.ok(html.includes(marca), `the built page lacks ${marca}`);
  for (const codigo of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Script(codigo[1]));
});

test('the bulk analysis never includes PRs listed only to be reviewed', () => {
  const fuente = readFileSync(new URL('04-script-1.js', PARTES), 'utf8');
  const linea = fuente.split('\n').find((l) => l.startsWith('const pendientesDeAnalisis'));
  const ctx = createContext({ FOTO: { prs: [
    { id: 'r#1', ambiente: 'prod' },
    { id: 'r#2', ambiente: 'prod', soloRevision: true },
    { id: 'r#3', ambiente: 'prod', paraRevisar: 'enlace' },
  ] }, trabajoActivo: () => false });
  runInContext(`${linea}\nglobalThis.pendientes = pendientesDeAnalisis;`, ctx);
  assert.deepEqual(Array.from(ctx.pendientes(), (x) => x.id), ['r#1', 'r#3']);
});

test('a card without author omits the author and the static board drops the paste instruction', () => {
  const html = tablero().seccionParaRevisar([{ id: 'r#1', repo: 'r', repoEtiqueta: 'r', numero: 1, titulo: 'T', autor: null, paraRevisar: 'enlace', soloRevision: true }]);
  assert.doesNotMatch(html, /autor-revisar|@null|@undefined/);
  assert.equal(tablero({ API: null }).mensajeRutaDesconocida('api#1'), 'This PR is not in the dashboard.');
});
