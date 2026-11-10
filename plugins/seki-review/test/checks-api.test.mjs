import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escribirJson, rutaInstantanea } from '../mcp/lib/cache.mjs';
import { proyecto as cargarProyecto } from '../mcp/lib/config.mjs';
import { aplicarDescartes, huellaHallazgo, leerDescartes } from '../mcp/lib/descartes.mjs';
import { guardarTriaje } from '../mcp/lib/triaje.mjs';
import { resumir } from '../mcp/lib/verificar.mjs';
import { detenerServidores, iniciarServidor } from '../mcp/lib/servidor-web.mjs';
import { fotoConExplicaciones } from '../mcp/lib/tablero.mjs';
import herramienta from '../mcp/tools/pr_verificaciones.mjs';

after(detenerServidores);
const temporales = [];
after(() => { for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true }); });

const SHA = 'a'.repeat(40);
const hallazgo = (i, severidad, extra = {}) => ({ regla: 'ejs-sin-escapar', titulo: 'Unescaped output', severidad, archivo: 'views/list.ejs', linea: i, texto: `<%- item${i} %>`, mensaje: 'Escape it', origen: 'base', ...extra });
const MEDIO_1 = hallazgo(1, 'medio');
const MEDIO_2 = hallazgo(2, 'medio');
const ALTO = hallazgo(3, 'alto');
const BLOQUEANTE = hallazgo(4, 'bloqueante');
const BAJO = hallazgo(5, 'bajo');
const huella = huellaHallazgo;
const HALLAZGOS = [MEDIO_1, MEDIO_2, ALTO, BLOQUEANTE, BAJO];
const prDe = (numero, extra = {}) => ({ id: `acme/api#${numero}`, repo: 'acme/api', numero, titulo: `Change ${numero}`, url: 'https://example.test', base: 'main', rama: `f${numero}`, portal: 'P', ambiente: 'prod', estadoPr: 'OPEN', headSha: SHA, mergeada: null, creada: new Date().toISOString(), body: '', ...extra });
const conChecks = (numero, hallazgos = HALLAZGOS, extra = {}) => prDe(numero, { verificaciones: { headSha: SHA, hallazgos, resumen: resumir(hallazgos) }, ...extra });

let n = 0;
// The triage job never reaches git, gh or claude: the server takes this fake instead.
async function entorno({ ia, prs = [conChecks(1), conChecks(2, []), prDe(3), conChecks(4, HALLAZGOS, { estadoPr: 'MERGED' }), conChecks(5, [BAJO])], ejecutarTriaje = async () => ({ ok: true, costo: 0, modelo: null, resultado: null }) } = {}) {
  const clave = `ca${++n}`;
  const dir = mkdtempSync(join(tmpdir(), 'seki-checks-api-'));
  temporales.push(dir);
  const salida = join(dir, 'salida');
  mkdirSync(join(salida, 'datos'), { recursive: true });
  const ruta = join(dir, 'proyectos.json');
  writeFileSync(ruta, JSON.stringify({ [clave]: { owner: 'o', salida, repos: { 'acme/api': { lineas: [{ portal: 'P', prod: 'main', pruebas: 'develop' }] } }, ...(ia ? { ia } : {}) } }));
  process.env.SEKI_REVIEW_CONFIG = ruta;
  const p = cargarProyecto(clave);
  escribirJson(rutaInstantanea(salida), { proyecto: clave, generado: new Date().toISOString(), owner: 'o', prs, recientes: [] });
  const { url } = await iniciarServidor({ proyecto: clave, puerto: 0, abrir: false, ejecutarTriaje });
  const u = new URL(url);
  const token = u.searchParams.get('t');
  const llamar = (r, cuerpo) => fetch(`${u.origin}${r}`, { method: cuerpo === undefined ? 'GET' : 'POST', headers: { 'x-seki-token': token, 'content-type': 'application/json' }, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  return { clave, p, llamar, cerrar: () => llamar('/api/ceder', {}) };
}

const triaje = (p, veredictos, headSha = SHA) => guardarTriaje(p, { repo: 'acme/api', numero: 1, headSha }, { origen: 'checks', modelo: 'm', modo: 'normal', costo: 0.1, veredictos });
const falso = (h, razon = 'The value is a literal') => ({ huella: huella(h), veredicto: 'falso_positivo', razon });
const R = (numero = 1) => ({ repo: 'acme/api', numero });

test('GET /api/checks returns the stored triage, the dismissals, the triable count and the cap', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  triaje(e.p, [falso(MEDIO_1)]);
  const d = await (await e.llamar('/api/checks?repo=acme/api&numero=1')).json();
  assert.equal(d.triables, 4);
  assert.equal(d.triaje.veredictos.length, 1);
  assert.equal(d.triaje.desactualizado, false);
  assert.deepEqual(d.descartes, []);
  assert.equal(typeof d.topeUsd, 'number');
  assert.equal((await e.llamar('/api/checks?repo=acme/api&numero=99')).status, 404);
});

test('POST /api/checks/triar requires confirmation and refuses unknown, closed and empty PRs', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  assert.equal((await e.llamar('/api/checks/triar', R())).status, 400);
  assert.equal((await e.llamar('/api/checks/triar', { ...R(), confirmar: 'true' })).status, 400);
  assert.equal((await e.llamar('/api/checks/triar', { ...R(99), confirmar: true })).status, 409);
  assert.equal((await e.llamar('/api/checks/triar', { ...R(4), confirmar: true })).status, 409);
  assert.equal((await e.llamar('/api/checks/triar', { ...R(3), confirmar: true })).status, 409);
  assert.equal((await e.llamar('/api/checks/triar', { ...R(2), confirmar: true })).status, 409);
  // Only a "bajo" finding: nothing qualifies for triage.
  assert.equal((await e.llamar('/api/checks/triar', { ...R(5), confirmar: true })).status, 409);
  assert.equal((await e.llamar('/api/estado').then((r) => r.json())).trabajos.length, 0);
});

test('POST /api/checks/triar queues one job and refuses a second request', async (t) => {
  const e = await entorno({ ia: { presupuestoDiarioUsd: 0.01 } });
  t.after(e.cerrar);
  const r = await e.llamar('/api/checks/triar', { ...R(), confirmar: true });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { encolado: 'acme/api#1:checks' });
  assert.equal((await e.llamar('/api/checks/triar', { ...R(), confirmar: true })).status, 409);
  const trabajo = (await (await e.llamar('/api/estado')).json()).trabajos.find((x) => x.tipo === 'triar_checks');
  assert.equal(trabajo.id, 'acme/api#1:checks');
  assert.equal(trabajo.estado, 'bloqueado_presupuesto');
});

test('the queued job receives the open findings of the PR, the mode and the repeat flag', async (t) => {
  const recibido = [];
  const e = await entorno({ ejecutarTriaje: async (p, pr, opciones) => { recibido.push({ pr: pr.id, ...opciones }); return { ok: true, costo: 0, modelo: null, resultado: null }; } });
  t.after(e.cerrar);
  await e.llamar('/api/checks/descartar', { ...R(), huellas: [huella(ALTO)], motivo: 'Reviewed' });
  assert.equal((await e.llamar('/api/checks/triar', { ...R(), confirmar: true, repetir: true, modo: 'ahorro' })).status, 202);
  for (let i = 0; i < 50 && !recibido.length; i++) await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(recibido.length, 1);
  assert.equal(recibido[0].repetir, true);
  assert.equal(recibido[0].modo, 'ahorro');
  assert.deepEqual(recibido[0].verificaciones.hallazgos.map((h) => h.huella).sort(), [MEDIO_1, MEDIO_2, BLOQUEANTE, BAJO].map(huella).sort());
});

test('a stored triage for the current commit is returned without a job unless repetir is set', async (t) => {
  let llamadas = 0;
  const e = await entorno({ ejecutarTriaje: async () => { llamadas++; return { ok: true, costo: 0, modelo: null, resultado: null }; } });
  t.after(e.cerrar);
  triaje(e.p, [falso(MEDIO_1)]);
  const r = await e.llamar('/api/checks/triar', { ...R(), confirmar: true });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.desdeCache, true);
  assert.equal(d.resultado.veredictos.length, 1);
  assert.equal(llamadas, 0);
  assert.equal((await e.llamar('/api/checks/triar', { ...R(), confirmar: true, repetir: true })).status, 202);
});

test('an outdated stored triage does not stop a new one', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  triaje(e.p, [falso(MEDIO_1)], 'b'.repeat(40));
  assert.equal((await e.llamar('/api/checks/triar', { ...R(), confirmar: true })).status, 202);
});

test('dismissing one finding with a motivo stores it as a person proposal, at any severity', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  const r = await e.llamar('/api/checks/descartar', { ...R(), huellas: [huella(BLOQUEANTE)], motivo: '  Escaped upstream  ' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { descartados: 1 });
  const [d] = leerDescartes(e.p, 'acme/api', 1);
  assert.equal(d.motivo, 'Escaped upstream');
  assert.equal(d.propuestoPor, 'persona');
});

test('dismissing one finding without a motivo takes the AI reason, and fails without one', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  triaje(e.p, [falso(ALTO, 'Only literals reach the tag')]);
  assert.equal((await e.llamar('/api/checks/descartar', { ...R(), huellas: [huella(BLOQUEANTE)] })).status, 400);
  assert.equal((await e.llamar('/api/checks/descartar', { ...R(), huellas: [huella(BLOQUEANTE)], motivo: '   ' })).status, 400);
  assert.equal((await e.llamar('/api/checks/descartar', { ...R(), huellas: [huella(ALTO)] })).status, 200);
  const [d] = leerDescartes(e.p, 'acme/api', 1);
  assert.equal(d.motivo, 'Only literals reach the tag');
  assert.equal(d.propuestoPor, 'ia');
});

test('bulk dismissal needs medium findings whose verdict is a false positive, and is all or nothing', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  triaje(e.p, [falso(MEDIO_1, 'Literal one'), falso(MEDIO_2, 'Literal two'), falso(ALTO, 'Literal three'), { huella: huella(BLOQUEANTE), veredicto: 'real', razon: 'Real' }]);
  const bulk = (huellas, extra = {}) => e.llamar('/api/checks/descartar', { ...R(), huellas, ...extra });
  assert.equal((await bulk([huella(MEDIO_1), huella(ALTO)])).status, 400);
  assert.equal((await bulk([huella(MEDIO_1), huella(BLOQUEANTE)])).status, 400);
  assert.deepEqual(leerDescartes(e.p, 'acme/api', 1), []);
  const ok = await bulk([huella(MEDIO_1), huella(MEDIO_2)]);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { descartados: 2 });
  const guardados = leerDescartes(e.p, 'acme/api', 1);
  assert.deepEqual(guardados.map((d) => d.motivo).sort(), ['Literal one', 'Literal two']);
  assert.ok(guardados.every((d) => d.propuestoPor === 'ia'));
});

test('bulk dismissal without a stored verdict is refused', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  assert.equal((await e.llamar('/api/checks/descartar', { ...R(), huellas: [huella(MEDIO_1), huella(MEDIO_2)], motivo: 'Reviewed' })).status, 400);
});

test('dismiss validates the body and answers 404 for a finding that is not open', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  for (const huellas of [undefined, [], 'x', [1], ['']]) assert.equal((await e.llamar('/api/checks/descartar', { ...R(), huellas, motivo: 'm' })).status, 400, JSON.stringify(huellas));
  assert.equal((await e.llamar('/api/checks/descartar', { ...R(), huellas: ['0'.repeat(16)], motivo: 'm' })).status, 404);
  assert.equal((await e.llamar('/api/checks/descartar', { ...R(99), huellas: [huella(ALTO)], motivo: 'm' })).status, 404);
  assert.equal((await e.llamar('/api/checks/descartar', { ...R(), huellas: [huella(ALTO)], motivo: 'x'.repeat(501) })).status, 400);
  await e.llamar('/api/checks/descartar', { ...R(), huellas: [huella(ALTO)], motivo: 'm' });
  // Already dismissed: no longer an open finding.
  assert.equal((await e.llamar('/api/checks/descartar', { ...R(), huellas: [huella(ALTO)], motivo: 'm' })).status, 404);
});

test('after dismissing, GET /api/checks lists it and the snapshot counts one finding less; reopening restores it', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  const embebido = async () => (await (await e.llamar('/api/foto')).json()).prs.find((x) => x.id === 'acme/api#1').verificaciones;
  const antes = await embebido();
  assert.equal(antes.resumen.alto, 1);
  await e.llamar('/api/checks/descartar', { ...R(), huellas: [huella(ALTO)], motivo: 'Reviewed' });
  const d = await (await e.llamar('/api/checks?repo=acme/api&numero=1')).json();
  assert.deepEqual(d.descartes.map((x) => x.huella), [huella(ALTO)]);
  assert.equal(d.triables, 3);
  const despues = await embebido();
  assert.equal(despues.hallazgos.length, antes.hallazgos.length - 1);
  assert.equal(despues.resumen.alto, 0);
  assert.equal(despues.descartados.length, 1);
  assert.ok(despues.hallazgos.every((h) => /^[0-9a-f]{16}$/.test(h.huella)));
  assert.equal((await e.llamar('/api/checks/reabrir', { ...R(), huella: huella(ALTO) })).status, 200);
  assert.equal((await embebido()).resumen.alto, 1);
});

test('POST /api/checks/reabrir answers ok, or 404 when the finding is not dismissed', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  await e.llamar('/api/checks/descartar', { ...R(), huellas: [huella(ALTO)], motivo: 'm' });
  const r = await e.llamar('/api/checks/reabrir', { ...R(), huella: huella(ALTO) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal((await e.llamar('/api/checks/reabrir', { ...R(), huella: huella(ALTO) })).status, 404);
  assert.equal((await e.llamar('/api/checks/reabrir', { ...R(), huella: 7 })).status, 400);
});

test('the snapshot carries the triage next to the checks and applying dismissals twice changes nothing', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  triaje(e.p, [falso(MEDIO_1)]);
  await e.llamar('/api/checks/descartar', { ...R(), huellas: [huella(ALTO)], motivo: 'm' });
  const foto = fotoConExplicaciones(e.p);
  const pr1 = foto.prs.find((x) => x.id === 'acme/api#1');
  assert.equal(pr1.triaje.veredictos.length, 1);
  assert.equal(foto.prs.find((x) => x.id === 'acme/api#3').triaje, undefined);
  const una = pr1.verificaciones;
  assert.deepEqual(aplicarDescartes(una, leerDescartes(e.p, 'acme/api', 1)), una);
});

test('pr_verificaciones description says verdicts and dismissals are read-only', () => {
  assert.match(herramienta.description, /verdicts and dismissals are read-only here/i);
});
