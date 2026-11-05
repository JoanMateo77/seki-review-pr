import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createContext, runInContext, Script } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escribirJson, rutaDiff, rutaExplicacion, rutaInstantanea, rutaUltra } from '../mcp/lib/cache.mjs';
import { proyecto as cargarProyecto } from '../mcp/lib/config.mjs';
import { detenerServidores, iniciarServidor } from '../mcp/lib/servidor-web.mjs';
import { construirHtml } from '../mcp/lib/tablero.mjs';
import { falsoClaude } from './util/claude.mjs';

after(detenerServidores);
const temporales = [];
after(() => { for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true }); });

const SHA = 'a'.repeat(40);
const pr = (numero, extra = {}) => ({ id: `r#${numero}`, repo: 'r', numero, titulo: `Change ${numero}`, url: 'https://example.test', base: 'main', rama: `f${numero}`, portal: 'P', ambiente: 'prod', estadoPr: 'OPEN', headSha: SHA, mergeada: null, creada: new Date().toISOString(), body: '', ...extra });

let n = 0;
// The Ultra job never reaches git, gh or claude: the server takes this fake instead.
async function entorno({ ia, prs = [pr(1), pr(2)], ejecutarUltra = async () => ({ ok: true, costo: 0, modelo: null, resultado: null }) } = {}) {
  const clave = `ua${++n}`;
  const dir = mkdtempSync(join(tmpdir(), 'seki-ultra-api-'));
  temporales.push(dir);
  const salida = join(dir, 'salida');
  mkdirSync(join(salida, 'datos'), { recursive: true });
  const ruta = join(dir, 'proyectos.json');
  writeFileSync(ruta, JSON.stringify({ [clave]: { owner: 'o', salida, repos: { r: { lineas: [{ portal: 'P', prod: 'main', pruebas: 'develop' }] } }, ...(ia ? { ia } : {}) } }));
  process.env.SEKI_REVIEW_CONFIG = ruta;
  const p = cargarProyecto(clave);
  escribirJson(rutaInstantanea(salida), { proyecto: clave, generado: new Date().toISOString(), owner: 'o', prs, recientes: [] });
  const { url } = await iniciarServidor({ proyecto: clave, puerto: 0, abrir: false, ejecutarUltra });
  const u = new URL(url);
  const token = u.searchParams.get('t');
  const llamar = (r, cuerpo) => fetch(`${u.origin}${r}`, { method: cuerpo === undefined ? 'GET' : 'POST', headers: { 'x-seki-token': token, 'content-type': 'application/json' }, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  return { p, llamar, token, origen: u.origin, cerrar: () => llamar('/api/ceder', {}) };
}

test('GET /api/estado exposes the budget and the project mode', async (t) => {
  const e = await entorno({ ia: { modo: 'ahorro', presupuestoDiarioUsd: 10 } });
  t.after(e.cerrar);
  const d = await (await e.llamar('/api/estado')).json();
  assert.equal(d.modo, 'ahorro');
  assert.equal(d.presupuesto.limite, 10);
});

test('GET /api/ultra returns the estimate, the suggestion and the stored result', async (t) => {
  const e = await entorno({ ia: { rutasSensibles: ['auth/'] } });
  t.after(e.cerrar);
  escribirJson(rutaDiff(e.p.salida, 'r', 1), { headSha: SHA, archivos: [{ filename: 'src/auth/login.ts', status: 'modified', additions: 1, deletions: 0 }] });
  escribirJson(rutaUltra(e.p.salida, 'r', 1), { headSha: 'b'.repeat(40), hallazgos: [] });
  const d = await (await e.llamar('/api/ultra?repo=r&numero=1')).json();
  assert.equal(d.estimacion.base, 'topes');
  assert.equal(d.estimacion.usd, 5.5);
  assert.equal(d.sugerida, true);
  assert.equal(d.resultado.desactualizada, true);
  const otra = await (await e.llamar('/api/ultra?repo=r&numero=2')).json();
  assert.equal(otra.sugerida, false);
  assert.equal(otra.resultado, null);
  assert.equal((await e.llamar('/api/ultra?repo=r&numero=99')).status, 404);
});

test('POST /api/ultra enqueues one Ultra job and refuses ahorro, unknown PRs and repeated requests', async (t) => {
  const e = await entorno({ ia: { presupuestoDiarioUsd: 1 } });
  t.after(e.cerrar);
  assert.equal((await e.llamar('/api/ultra', { repo: 'r', numero: 99, confirmar: true })).status, 409);
  assert.equal((await e.llamar('/api/ultra', { repo: 'r', numero: 1, modo: 'ahorro', confirmar: true })).status, 409);
  // The estimate ($5.50) does not fit in the $1 budget: the job waits as blocked.
  assert.equal((await e.llamar('/api/ultra', { repo: 'r', numero: 1, confirmar: true })).status, 202);
  assert.equal((await e.llamar('/api/ultra', { repo: 'r', numero: 1, confirmar: true })).status, 409);
  const t1 = (await (await e.llamar('/api/estado')).json()).trabajos.find((x) => x.tipo === 'revisar_ultra');
  assert.equal(t1.estado, 'bloqueado_presupuesto');
  assert.match(t1.mensaje, /Blocked by the daily budget/);
});

test('a project in ahorro refuses Ultra unless the request picks another mode', async (t) => {
  const e = await entorno({ ia: { modo: 'ahorro' } });
  t.after(e.cerrar);
  assert.equal((await e.llamar('/api/ultra', { repo: 'r', numero: 1, confirmar: true })).status, 409);
  assert.equal((await e.llamar('/api/ultra', { repo: 'r', numero: 1, modo: 'ultra', confirmar: true })).status, 202);
});

test('POST /api/trabajos/forzar runs a blocked job once and answers 404 for anything else', async (t) => {
  const e = await entorno({ ia: { presupuestoDiarioUsd: 1 } });
  t.after(e.cerrar);
  await e.llamar('/api/ultra', { repo: 'r', numero: 1, confirmar: true });
  assert.equal((await e.llamar('/api/trabajos/forzar', { id: 'r#2:ultra' })).status, 404);
  assert.equal((await e.llamar('/api/trabajos/forzar', {})).status, 404);
  assert.equal((await e.llamar('/api/trabajos/forzar', { id: 'r#1:ultra' })).status, 200);
  const t1 = (await (await e.llamar('/api/estado')).json()).trabajos.find((x) => x.id === 'r#1:ultra');
  assert.notEqual(t1.estado, 'bloqueado_presupuesto');
});

test('saving mode does not enqueue an explanation that already covers the current commit, unless completing', async (t) => {
  const e = await entorno({ ia: { presupuestoDiarioUsd: 0.01 } });
  t.after(e.cerrar);
  escribirJson(rutaExplicacion(e.p.salida, 'r', 1), { headSha: SHA, resumen: 'x' });
  const pedido = { prs: [{ repo: 'r', numero: 1 }, { repo: 'r', numero: 2 }] };
  const a = await (await e.llamar('/api/analizar', { ...pedido, modo: 'ahorro' })).json();
  assert.deepEqual([a.encolados, a.reutilizados], [1, 1]);
  const b = await (await e.llamar('/api/analizar', { ...pedido, modo: 'ahorro', completar: true })).json();
  assert.equal(b.reutilizados, 0);
  const c = await (await e.llamar('/api/analizar', { prs: [{ repo: 'r', numero: 1 }], modo: 'normal' })).json();
  assert.equal(c.reutilizados, 0);
});

test('POST /api/filtrar answers 429 with the retry flag when the budget does not fit', async (t) => {
  const e = await entorno({ ia: { presupuestoDiarioUsd: 0.01 } });
  t.after(e.cerrar);
  const r = await e.llamar('/api/filtrar', { consulta: 'security', modo: 'ahorro' });
  assert.equal(r.status, 429);
  const d = await r.json();
  assert.equal(d.forzar, true);
  assert.match(d.error, /daily budget/);
});

const crudo = (e, ruta, { cabeceras = {}, cuerpo = '{}', host } = {}) => new Promise((ok, falla) => {
  const u = new URL(e.origen);
  const r = request({ host: u.hostname, port: u.port, path: ruta, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(cuerpo), ...(host ? { host } : {}), ...cabeceras } }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode)); });
  r.on('error', falla);
  r.end(cuerpo);
});

test('POST /api/ultra requires the explicit confirmation', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  assert.equal((await e.llamar('/api/ultra', { repo: 'r', numero: 1 })).status, 400);
  assert.equal((await e.llamar('/api/ultra', { repo: 'r', numero: 1, confirmar: 'true' })).status, 400);
  assert.equal((await e.llamar('/api/estado').then((r) => r.json())).trabajos.length, 0);
});

test('a stored result for the current commit is returned without a job unless repetir is set', async (t) => {
  let llamadas = 0;
  const e = await entorno({ ejecutarUltra: async () => { llamadas++; return { ok: true, costo: 0, modelo: null, resultado: null }; } });
  t.after(e.cerrar);
  escribirJson(rutaUltra(e.p.salida, 'r', 1), { headSha: SHA, hallazgos: [{ titulo: 'x' }] });
  const r = await e.llamar('/api/ultra', { repo: 'r', numero: 1, confirmar: true });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.desdeCache, true);
  assert.equal(d.resultado.hallazgos.length, 1);
  assert.equal(llamadas, 0);
  assert.equal((await (await e.llamar('/api/estado')).json()).trabajos.length, 0);
  assert.equal((await e.llamar('/api/ultra', { repo: 'r', numero: 1, confirmar: true, repetir: true })).status, 202);
});

test('an outdated stored result does not stop a new review', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  escribirJson(rutaUltra(e.p.salida, 'r', 1), { headSha: 'b'.repeat(40), hallazgos: [] });
  assert.equal((await e.llamar('/api/ultra', { repo: 'r', numero: 1, confirmar: true })).status, 202);
});

test('the Ultra and force endpoints reject a missing token, a wrong token, a foreign Host and an oversized body', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  for (const ruta of ['/api/ultra', '/api/trabajos/forzar']) {
    assert.equal(await crudo(e, ruta), 401, ruta);
    assert.equal(await crudo(e, ruta, { cabeceras: { 'x-seki-token': 'otro' } }), 403, ruta);
    assert.equal(await crudo(e, ruta, { cabeceras: { 'x-seki-token': e.token }, host: 'evil.test:80' }), 421, ruta);
    assert.equal(await crudo(e, ruta, { cabeceras: { 'x-seki-token': e.token }, cuerpo: JSON.stringify({ repo: 'r', numero: 1, relleno: 'x'.repeat(17 * 1024) }) }), 413, ruta);
  }
});

test('an invalid mode falls back to the project mode and is not echoed', async (t) => {
  const e = await entorno({ ia: { modo: 'ahorro' } });
  t.after(e.cerrar);
  const r = await e.llamar('/api/ultra', { repo: 'r', numero: 1, modo: '<script>x</script>', confirmar: true });
  assert.equal(r.status, 409);
  assert.doesNotMatch(await r.text(), /script/);
  assert.equal((await (await e.llamar('/api/estado')).json()).modo, 'ahorro');
});

test('forcing one blocked job leaves the next one blocked', async (t) => {
  const e = await entorno({ ia: { presupuestoDiarioUsd: 1 } });
  t.after(e.cerrar);
  await e.llamar('/api/ultra', { repo: 'r', numero: 1, confirmar: true });
  await e.llamar('/api/ultra', { repo: 'r', numero: 2, confirmar: true });
  assert.equal((await e.llamar('/api/trabajos/forzar', { id: 'r#1:ultra' })).status, 200);
  const trabajos = (await (await e.llamar('/api/estado')).json()).trabajos;
  assert.equal(trabajos.find((x) => x.id === 'r#2:ultra').estado, 'bloqueado_presupuesto');
  assert.notEqual(trabajos.find((x) => x.id === 'r#1:ultra').estado, 'bloqueado_presupuesto');
});

test('the filter answers 429 with the retry flag and succeeds when retried with forzar', async (t) => {
  process.env.SEKI_CLAUDE = falsoClaude({ type: 'result', is_error: false, subtype: 'success', structured_output: { coincidencias: [{ id: 'r#1', relacion: 'directa', motivo: 'm' }] }, total_cost_usd: 0.01, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 1, outputTokens: 1 } } });
  const e = await entorno({ ia: { presupuestoDiarioUsd: 0.01 } });
  t.after(e.cerrar);
  const bloqueado = await e.llamar('/api/filtrar', { consulta: 'security' });
  assert.equal(bloqueado.status, 429);
  assert.equal((await bloqueado.json()).forzar, true);
  const ok = await e.llamar('/api/filtrar', { consulta: 'security', forzar: true });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).coincidencias[0].id, 'r#1');
});

test('the sensitive-path suggestion reads each cached diff once per commit', async (t) => {
  const prs = [1, 2, 3].map((n) => pr(n));
  const e = await entorno({ ia: { rutasSensibles: ['auth/'] }, prs });
  t.after(e.cerrar);
  for (const n of [1, 2, 3]) escribirJson(rutaDiff(e.p.salida, 'r', n), { headSha: SHA, archivos: [{ filename: 'src/auth/x.ts' }] });
  const foto = async () => (await (await e.llamar('/api/foto')).json()).prs;
  assert.deepEqual((await foto()).map((x) => x.ultraSugerida), [true, true, true]);
  for (const n of [1, 2, 3]) rmSync(rutaDiff(e.p.salida, 'r', n));
  // Served from memory: the files are gone and the answer does not change.
  assert.deepEqual((await foto()).map((x) => x.ultraSugerida), [true, true, true]);
});

// The board script parts, evaluated with minimal stubs.
const PARTES = new URL('../mcp/tablero/partes/', import.meta.url);
function tablero({ almacenado } = {}) {
  const escape = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ctx = createContext({
    API: { token: 't' }, FOTO: { prs: [] }, estado: { trabajos: new Map(), modoProyecto: 'normal' },
    esc: escape, plural: (n, a, b) => `${n} ${n === 1 ? a : b}`, icono: () => '', usd: (x) => `USD ${x}`, $: () => null,
    transcurrido: () => '', avisar() {}, sondear() {}, pintarBarra() {}, pintarDetalle() {}, pintarCola() {}, seleccionar() {}, repintarDetalle() {}, api: async () => ({}),
    document: { addEventListener() {}, activeElement: null }, window: { addEventListener() {} }, location: { hash: '' }, history: {},
    setTimeout: () => 0, sessionStorage: { getItem: () => almacenado ?? null, setItem() {} },
  });
  runInContext(readFileSync(new URL('07b-modos.js', PARTES), 'utf8'), ctx);
  return ctx;
}

test('the Ultra result is escaped, whatever the model or the repository wrote', () => {
  const mal = '<img src=x onerror=x>"\'';
  const ctx = tablero();
  const html = ctx.resultadoUltra({ url: 'https://example.test/r/1' }, {
    headSha: mal, fecha: '2026-11-05T10:00:00Z', otrosRepos: 'no_disponibles',
    lentes: [{ nombre: mal, ok: false, motivo: mal }],
    hallazgos: [{ severidad: 'alta', veredicto: 'CONFIRMED', titulo: mal, archivo: mal, linea: 3, repo: mal, detalle: mal, razon: mal }],
    descartadas: [], comprobacion: { error: mal },
  });
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /"\s*onerror/);
  assert.match(html, /&lt;img src=x onerror=x&gt;&quot;/);
  assert.match(html, /Other repositories were not available/);
});

test('a result without a date shows no Invalid Date and the unbaselined checks are labelled', () => {
  const html = tablero().resultadoUltra({ url: 'u' }, { headSha: 'abc1234', hallazgos: [], comprobacion: { reglas: { hallazgos: [] }, sinBaseline: true } });
  assert.doesNotMatch(html, /Invalid Date/);
  assert.match(html, /Not compared with the base branch/);
});

test('only the AI routes get the mode, and the stored mode is validated', () => {
  const ctx = tablero({ almacenado: 'ahorro' });
  for (const ruta of ['/api/analizar', '/api/enviar-revision', '/api/investigar', '/api/filtrar', '/api/propuesta/ajustar', '/api/propuesta/regenerar']) {
    assert.equal(ctx.conModo(ruta, { a: 1 }).modo, 'ahorro', ruta);
  }
  for (const ruta of ['/api/comentarios', '/api/propuesta/aprobar', '/api/propuesta/descartar', '/api/ultra', '/api/trabajos/forzar', '/api/refrescar']) {
    assert.equal(ctx.conModo(ruta, { a: 1 }).modo, undefined, ruta);
  }
  assert.equal(tablero({ almacenado: '<x>' }).modoActual(), 'normal');
});

test('the built page carries the AI mode controls', () => {
  const html = construirHtml({ salida: '/nonexistent', ia: {} }, { prs: [] }, { token: 't' });
  for (const marca of ['id="selModo"', 'data-ultra-abrir', 'data-forzar', 'Blocked by the daily budget', 'Not compared with the base branch', 'Other repositories were not available', '?ultra=1']) {
    assert.ok(html.includes(marca), `the built page lacks ${marca}`);
  }
  for (const codigo of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Script(codigo[1]));
});
