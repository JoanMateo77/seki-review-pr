import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escribirJson, rutaDiff, rutaInstantanea, rutaPlantillas } from '../mcp/lib/cache.mjs';
import { proyecto as cargarProyecto } from '../mcp/lib/config.mjs';
import { topeRevisarPlantillas } from '../mcp/lib/perfiles.mjs';
import { detenerServidores, iniciarServidor } from '../mcp/lib/servidor-web.mjs';
import herramienta from '../mcp/tools/pr_plantillas.mjs';

after(detenerServidores);
const temporales = [];
after(() => { for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true }); });

const SHA = 'a'.repeat(40);
const pr = (numero, extra = {}) => ({ id: `r#${numero}`, repo: 'r', numero, titulo: `Change ${numero}`, url: 'https://example.test', base: 'main', rama: `f${numero}`, portal: 'P', ambiente: 'prod', estadoPr: 'OPEN', headSha: SHA, mergeada: null, creada: new Date().toISOString(), body: '', ...extra });
// A project template that replaces the base `ligera` with deterministic items only: no AI call, cap 0.
const SOLO_REGLAS = { id: 'ligera', version: 2, titulo: 'Rules only', idioma: 'en', siempre: true, aplicaA: ['**'], excluir: [], items: [{ id: 'L7-tipos', pregunta: 'No any?', evidencia: 'e', reglas: ['as-any', 'tipo-any'], siFalla: { etiqueta: 'issue', bloqueante: false } }] };

let n = 0;
// The template job never reaches git, gh or claude: the server takes this fake instead.
async function entorno({ ia, prs = [pr(1), pr(2, { estadoPr: 'CLOSED' })], plantillas, diffPlantillas, shaRama, ejecutarPlantillas = async () => ({ ok: true, costo: 0, modelo: null, resultado: null }) } = {}) {
  const clave = `pa${++n}`;
  const dir = mkdtempSync(join(tmpdir(), 'seki-plantillas-api-'));
  temporales.push(dir);
  const salida = join(dir, 'salida');
  mkdirSync(join(salida, 'datos'), { recursive: true });
  let dirPlantillas;
  if (plantillas) {
    dirPlantillas = join(dir, 'plantillas');
    mkdirSync(dirPlantillas);
    for (const t of plantillas) writeFileSync(join(dirPlantillas, `${t.id}.json`), JSON.stringify(t));
  }
  const ruta = join(dir, 'proyectos.json');
  writeFileSync(ruta, JSON.stringify({ [clave]: { owner: 'o', salida, repos: { r: { lineas: [{ portal: 'P', prod: 'main', pruebas: 'develop' }] } }, ...(ia ? { ia } : {}), ...(dirPlantillas ? { plantillas: dirPlantillas } : {}) } }));
  process.env.SEKI_REVIEW_CONFIG = ruta;
  const p = cargarProyecto(clave);
  escribirJson(rutaInstantanea(salida), { proyecto: clave, generado: new Date().toISOString(), owner: 'o', prs, recientes: [] });
  // The diff is cached for the head commit: the selection never reaches GitHub.
  for (const x of prs) escribirJson(rutaDiff(salida, x.repo, x.numero), { headSha: x.headSha, archivos: [{ filename: 'README.md', status: 'modified', additions: 1, deletions: 0 }] });
  const { url } = await iniciarServidor({ proyecto: clave, puerto: 0, abrir: false, ejecutarPlantillas, ...(diffPlantillas ? { diffPlantillas } : {}), ...(shaRama ? { shaRama } : {}) });
  const u = new URL(url);
  const token = u.searchParams.get('t');
  const llamar = (r, cuerpo) => fetch(`${u.origin}${r}`, { method: cuerpo === undefined ? 'GET' : 'POST', headers: { 'x-seki-token': token, 'content-type': 'application/json' }, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  const trabajos = async () => (await (await llamar('/api/estado')).json()).trabajos;
  return { clave, p, llamar, trabajos, token, origen: u.origin, cerrar: () => llamar('/api/ceder', {}) };
}

test('GET /api/plantillas returns the selection without spending', async (t) => {
  let llamadas = 0;
  const e = await entorno({ ejecutarPlantillas: async () => { llamadas++; return { ok: true, costo: 0 }; } });
  t.after(e.cerrar);
  escribirJson(rutaDiff(e.p.salida, 'r', 1), { headSha: SHA, archivos: [{ filename: 'src/routes/pagos.ts', status: 'modified', additions: 1, deletions: 0 }] });
  escribirJson(rutaPlantillas(e.p.salida, 'r', 1), { headSha: 'b'.repeat(40), plantillas: [], markdown: 'x' });
  const d = await (await e.llamar('/api/plantillas?repo=r&numero=1')).json();
  const activas = d.seleccion.activas.map((a) => a.id);
  assert.ok(activas.includes('ligera'));
  assert.ok(activas.includes('owasp-web'));
  assert.deepEqual(d.invalidas, []);
  assert.equal(d.estimacion.base, 'topes');
  assert.equal(d.topeUsd, topeRevisarPlantillas(activas.length));
  assert.equal(d.resultado.desactualizada, true);
  assert.equal((await e.llamar('/api/plantillas?repo=r&numero=99')).status, 404);
  assert.equal(llamadas, 0);
  assert.equal((await e.trabajos()).length, 0);
});

test('GET /api/plantillas reports the branches whose sha moved and the POST still queues with the cap', async (t) => {
  const e = await entorno({ ia: { presupuestoDiarioUsd: 0.01 }, shaRama: async (_p, repo) => (repo === 'web' ? 'f'.repeat(40) : 'c'.repeat(40)) });
  t.after(e.cerrar);
  escribirJson(rutaPlantillas(e.p.salida, 'r', 1), { headSha: SHA, plantillas: [], markdown: 'x', ramas: [{ repo: 'web', rama: 'develop', sha: 'a'.repeat(40) }, { repo: 'jobs', rama: 'develop', sha: 'c'.repeat(40) }] });
  const d = await (await e.llamar('/api/plantillas?repo=r&numero=1')).json();
  assert.deepEqual(d.resultado.ramasMovidas, [{ repo: 'web', rama: 'develop' }]);
  const r = await e.llamar('/api/plantillas', { repo: 'r', numero: 1, confirmar: true, repetir: true });
  assert.equal(r.status, 202);
  const [job] = await e.trabajos();
  assert.equal(job.topeUsd, d.topeUsd);
});

test('POST /api/plantillas without confirmar is 400', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  assert.equal((await e.llamar('/api/plantillas', { repo: 'r', numero: 1 })).status, 400);
  assert.equal((await e.llamar('/api/plantillas', { repo: 'r', numero: 1, confirmar: 'true' })).status, 400);
  assert.equal((await e.trabajos()).length, 0);
});

test('POST /api/plantillas for a closed PR or one outside the snapshot is 409', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  assert.equal((await e.llamar('/api/plantillas', { repo: 'r', numero: 2, confirmar: true })).status, 409);
  assert.equal((await e.llamar('/api/plantillas', { repo: 'r', numero: 99, confirmar: true })).status, 409);
  assert.equal((await e.trabajos()).length, 0);
});

test('POST /api/plantillas queues one job and a second POST is 409', async (t) => {
  const e = await entorno({ ia: { presupuestoDiarioUsd: 0.01 } });
  t.after(e.cerrar);
  const r = await e.llamar('/api/plantillas', { repo: 'r', numero: 1, confirmar: true });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { encolado: 'r#1:plantillas' });
  assert.equal((await e.llamar('/api/plantillas', { repo: 'r', numero: 1, confirmar: true })).status, 409);
  const [job] = await e.trabajos();
  assert.equal(job.id, 'r#1:plantillas');
  assert.equal(job.tipo, 'revisar_plantillas');
  assert.equal(job.prId, 'r#1');
  // Only the base template `ligera` is active: one template with AI items.
  assert.equal(job.topeUsd, topeRevisarPlantillas(1));
  assert.equal(job.estado, 'bloqueado_presupuesto');
});

test('POST /api/plantillas is allowed in saving mode', async (t) => {
  const e = await entorno({ ia: { modo: 'ahorro' } });
  t.after(e.cerrar);
  assert.equal((await e.llamar('/api/plantillas', { repo: 'r', numero: 1, modo: 'ahorro', confirmar: true })).status, 202);
});

test('a selection without AI items queues a job capped at 0 that runs the deterministic part', async (t) => {
  const pedidos = [];
  const e = await entorno({ plantillas: [SOLO_REGLAS], ia: { presupuestoDiarioUsd: 0.01 }, ejecutarPlantillas: async (_, x, o) => { pedidos.push([x.id, o]); return { ok: true, costo: 0 }; } });
  t.after(e.cerrar);
  const d = await (await e.llamar('/api/plantillas?repo=r&numero=1')).json();
  assert.equal(d.topeUsd, 0);
  assert.equal(d.estimacion.usd, 0);
  assert.equal((await e.llamar('/api/plantillas', { repo: 'r', numero: 1, confirmar: true })).status, 202);
  for (let i = 0; i < 50 && !pedidos.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(pedidos, [['r#1', { repetir: false }]]);
  const [job] = await e.trabajos();
  assert.equal(job.topeUsd, 0);
});

test('POST /api/plantillas with a current stored result answers 200 from cache', async (t) => {
  let llamadas = 0;
  const e = await entorno({ ejecutarPlantillas: async () => { llamadas++; return { ok: true, costo: 0 }; } });
  t.after(e.cerrar);
  escribirJson(rutaPlantillas(e.p.salida, 'r', 1), { headSha: SHA, plantillas: [], markdown: 'stored' });
  const r = await e.llamar('/api/plantillas', { repo: 'r', numero: 1, confirmar: true });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.desdeCache, true);
  assert.equal(d.resultado.markdown, 'stored');
  assert.equal(llamadas, 0);
  assert.equal((await e.trabajos()).length, 0);
  assert.equal((await e.llamar('/api/plantillas', { repo: 'r', numero: 1, confirmar: true, repetir: true })).status, 202);
});

test('an outdated stored template result does not stop a new review', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  escribirJson(rutaPlantillas(e.p.salida, 'r', 1), { headSha: 'b'.repeat(40), plantillas: [], markdown: '' });
  assert.equal((await e.llamar('/api/plantillas', { repo: 'r', numero: 1, confirmar: true })).status, 202);
});

test('POST /api/plantillas refuses with 503 when the diff cannot be loaded; GET falls back to the cached names', async (t) => {
  const e = await entorno({ diffPlantillas: async () => { throw new Error('gh is down'); } });
  t.after(e.cerrar);
  escribirJson(rutaDiff(e.p.salida, 'r', 1), { headSha: SHA, archivos: [{ filename: 'src/routes/x.ts', status: 'modified' }] });
  const d = await (await e.llamar('/api/plantillas?repo=r&numero=1')).json();
  assert.ok(d.seleccion.activas.some((a) => a.id === 'owasp-web'));
  const r = await e.llamar('/api/plantillas', { repo: 'r', numero: 1, confirmar: true });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /The PR diff could not be loaded/);
  assert.equal((await e.trabajos()).length, 0);
});

const crudo = (e, ruta, { metodo = 'POST', cabeceras = {}, cuerpo = '{}', host } = {}) => new Promise((ok, falla) => {
  const u = new URL(e.origen);
  const r = request({ host: u.hostname, port: u.port, path: ruta, method: metodo, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(cuerpo), ...(host ? { host } : {}), ...cabeceras } }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode)); });
  r.on('error', falla);
  r.end(cuerpo);
});

test('template requests without the token are refused', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  for (const [metodo, ruta, cuerpo] of [['GET', '/api/plantillas?repo=r&numero=1', ''], ['POST', '/api/plantillas', '{}']]) {
    assert.equal(await crudo(e, ruta, { metodo, cuerpo }), 401, ruta);
    assert.equal(await crudo(e, ruta, { metodo, cuerpo, cabeceras: { 'x-seki-token': 'otro' } }), 403, ruta);
    assert.equal(await crudo(e, ruta, { metodo, cuerpo, cabeceras: { 'x-seki-token': e.token }, host: 'evil.test:80' }), 421, ruta);
  }
  assert.equal(await crudo(e, '/api/plantillas', { cabeceras: { 'x-seki-token': e.token }, cuerpo: JSON.stringify({ repo: 'r', numero: 1, confirmar: true, relleno: 'x'.repeat(17 * 1024) }) }), 413);
  assert.equal((await e.trabajos()).length, 0);
});

test('pr_plantillas returns the selection and the link and never queues', async (t) => {
  let llamadas = 0;
  const e = await entorno({ ejecutarPlantillas: async () => { llamadas++; return { ok: true, costo: 0 }; } });
  t.after(e.cerrar);
  assert.equal(herramienta.name, 'pr_plantillas');
  assert.deepEqual(herramienta.inputSchema.required, ['repo', 'numero']);
  escribirJson(rutaPlantillas(e.p.salida, 'r', 1), { headSha: SHA, plantillas: [], markdown: 'stored' });
  const r = await herramienta.handler({ proyecto: e.clave, repo: 'r', numero: 1 });
  assert.deepEqual(r.seleccion.activas.map((a) => a.id), ['ligera']);
  assert.deepEqual(r.invalidas, []);
  assert.equal(r.topeUsd, topeRevisarPlantillas(1));
  assert.equal(r.estimacion.base, 'topes');
  assert.equal(r.resultado.markdown, 'stored');
  assert.equal(r.enlace, '#/pr/r/1?plantillas=1');
  assert.equal(r.disponible, true);
  assert.equal((await herramienta.handler({ proyecto: e.clave, repo: 'r', numero: 2 })).disponible, false);
  await assert.rejects(() => herramienta.handler({ proyecto: e.clave, repo: 'r', numero: 9 }), /snapshot/);
  await assert.rejects(() => herramienta.handler({ proyecto: e.clave, repo: 'r', numero: '1' }), /positive integer/);
  assert.equal(llamadas, 0);
  assert.equal((await e.trabajos()).length, 0);
});
