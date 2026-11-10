import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escribirJson, rutaInstantanea, rutaTriaje } from '../mcp/lib/cache.mjs';
import { proyecto as cargarProyecto } from '../mcp/lib/config.mjs';
import { aplicarDescartes, huellaHallazgo, leerDescartes } from '../mcp/lib/descartes.mjs';
import { actualizarComentario, leerComentarios } from '../mcp/lib/comentarios.mjs';
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
async function entorno({ ia, prs = [conChecks(1), conChecks(2, []), prDe(3), conChecks(4, HALLAZGOS, { estadoPr: 'MERGED' }), conChecks(5, [BAJO])], ejecutarTriaje = async () => ({ ok: true, costo: 0, modelo: null, resultado: null }), ejecutarCambios } = {}) {
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
  const { url } = await iniciarServidor({ proyecto: clave, puerto: 0, abrir: false, ejecutarTriaje, ...(ejecutarCambios ? { ejecutarCambios } : {}) });
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

test('the AI reason is taken as the motivo only from a false positive verdict of the current commit', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  triaje(e.p, [{ huella: huella(MEDIO_1), veredicto: 'real', razon: 'Reaches the page' }, { huella: huella(MEDIO_2), veredicto: 'dudoso', razon: 'Depends on a helper' }]);
  for (const h of [MEDIO_1, MEDIO_2]) assert.equal((await e.llamar('/api/checks/descartar', { ...R(), huellas: [huella(h)] })).status, 400, h.texto);
  triaje(e.p, [falso(ALTO, 'Only literals reach the tag')], 'b'.repeat(40));
  assert.equal((await e.llamar('/api/checks/descartar', { ...R(), huellas: [huella(ALTO)] })).status, 400);
  assert.deepEqual(leerDescartes(e.p, 'acme/api', 1), []);
  // A person's own reason is enough whatever the verdict.
  assert.equal((await e.llamar('/api/checks/descartar', { ...R(), huellas: [huella(MEDIO_1)], motivo: 'Reviewed by hand' })).status, 200);
});

test('bulk dismissal needs a triage of the current commit', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  triaje(e.p, [falso(MEDIO_1), falso(MEDIO_2)], 'b'.repeat(40));
  assert.equal((await e.llamar('/api/checks/descartar', { ...R(), huellas: [huella(MEDIO_1), huella(MEDIO_2)] })).status, 400);
  assert.equal((await e.llamar('/api/checks/descartar', { ...R(), huellas: [huella(MEDIO_1), huella(MEDIO_2)], motivo: 'Reviewed' })).status, 400);
  assert.deepEqual(leerDescartes(e.p, 'acme/api', 1), []);
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

test('a bulk dismissal with a person motivo is attributed to the person and repeated huellas collapse', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  triaje(e.p, [falso(MEDIO_1), falso(MEDIO_2)]);
  const r = await e.llamar('/api/checks/descartar', { ...R(), huellas: [huella(MEDIO_1), huella(MEDIO_2), huella(MEDIO_1)], motivo: 'Reviewed by hand' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { descartados: 2 });
  const guardados = leerDescartes(e.p, 'acme/api', 1);
  assert.equal(guardados.length, 2);
  assert.ok(guardados.every((d) => d.propuestoPor === 'persona' && d.motivo === 'Reviewed by hand'));
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

// The change job never reaches git or claude: the fake leaves the comment with a proposal, as the real one does.
const cambiosFalsos = (recibido) => async (p, pr, ids, opciones) => {
  recibido.push({ pr: pr.id, ids, ...opciones });
  for (const id of ids) actualizarComentario(p, pr.repo, pr.numero, id, { estado: 'propuesta', propuestaId: 'p-0001' });
  return { ok: true, costo: 0 };
};
const esperar = async (cond) => { for (let i = 0; i < 100 && !cond(); i++) await new Promise((ok) => setTimeout(ok, 20)); };

test('POST /api/checks/arreglar creates the fix comment and queues the change job', async (t) => {
  const recibido = [];
  const e = await entorno({ ejecutarCambios: cambiosFalsos(recibido) });
  t.after(e.cerrar);
  triaje(e.p, [falso(MEDIO_1, 'The value is user input')]);
  const r = await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: huella(MEDIO_1), modo: 'ahorro' });
  assert.equal(r.status, 202);
  const { comentario } = await r.json();
  assert.equal(comentario.tipo, 'cambio');
  assert.equal(comentario.estado, 'en_cola');
  assert.equal(comentario.desde, MEDIO_1.linea);
  assert.equal(comentario.origenCheck.huella, huella(MEDIO_1));
  // The AI reason is kept apart from the request text: the change job reads it as data, never as the instruction.
  assert.equal(comentario.texto, 'Fix the check "Unescaped output" (ejs-sin-escapar) on this line. Escape it Change only what the finding needs.');
  assert.equal(comentario.origenCheck.razon, 'The value is user input');
  assert.deepEqual(leerComentarios(e.p, 'acme/api', 1).map((c) => c.id), [comentario.id]);
  await esperar(() => recibido.length);
  assert.deepEqual(recibido, [{ pr: 'acme/api#1', ids: [comentario.id], modo: 'ahorro' }]);
  const trabajo = (await (await e.llamar('/api/estado')).json()).trabajos.find((x) => x.tipo === 'cambiar');
  assert.match(trabajo.id, new RegExp(`^acme/api#1:cambiar:${huella(MEDIO_1)}:\\d+$`));
});

test('POST /api/checks/arreglar refuses a second request for the same finding but allows a retry after an error', async (t) => {
  const e = await entorno({ ejecutarCambios: cambiosFalsos([]) });
  t.after(e.cerrar);
  const primero = await (await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: huella(MEDIO_1) })).json();
  assert.equal((await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: huella(MEDIO_1) })).status, 409);
  assert.equal((await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: huella(MEDIO_2) })).status, 202);
  await esperar(() => leerComentarios(e.p, 'acme/api', 1).every((c) => c.estado === 'propuesta'));
  actualizarComentario(e.p, 'acme/api', 1, primero.comentario.id, { estado: 'error', motivo: 'The AI made no changes' });
  assert.equal((await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: huella(MEDIO_1) })).status, 202);
});

test('POST /api/checks/arreglar refuses dismissed findings, findings without line, closed PRs and bad input', async (t) => {
  const SIN_LINEA = hallazgo(0, 'alto', { linea: undefined, texto: 'sin linea' });
  const e = await entorno({ prs: [conChecks(1, [MEDIO_1, SIN_LINEA]), conChecks(4, HALLAZGOS, { estadoPr: 'MERGED' })], ejecutarCambios: cambiosFalsos([]) });
  t.after(e.cerrar);
  await e.llamar('/api/checks/descartar', { ...R(), huellas: [huella(MEDIO_1)], motivo: 'Reviewed' });
  assert.equal((await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: huella(MEDIO_1) })).status, 409);
  assert.equal((await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: huella(SIN_LINEA) })).status, 409);
  assert.equal((await e.llamar('/api/checks/arreglar', { ...R(4), confirmar: true, huella: huella(MEDIO_1) })).status, 409);
  assert.equal((await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: 'no-existe' })).status, 404);
  assert.equal((await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: 7 })).status, 400);
  assert.equal((await e.llamar('/api/checks/arreglar', { ...R(), huella: huella(SIN_LINEA) })).status, 400);
  assert.equal((await e.llamar('/api/checks/arreglar', { ...R(), confirmar: 'true', huella: huella(SIN_LINEA) })).status, 400);
  assert.equal((await e.llamar('/api/checks/arreglar', { ...R(99), confirmar: true, huella: huella(MEDIO_1) })).status, 404);
  assert.deepEqual(leerComentarios(e.p, 'acme/api', 1), []);
  assert.equal((await e.llamar('/api/estado').then((r) => r.json())).trabajos.length, 0);
});

test('POST /api/checks/arreglar allows a retry after a discarded proposal', async (t) => {
  const e = await entorno({ ejecutarCambios: cambiosFalsos([]) });
  t.after(e.cerrar);
  const primero = await (await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: huella(MEDIO_1) })).json();
  await esperar(() => leerComentarios(e.p, 'acme/api', 1).every((c) => c.estado === 'propuesta'));
  actualizarComentario(e.p, 'acme/api', 1, primero.comentario.id, { estado: 'descartado' });
  const r = await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: huella(MEDIO_1) });
  assert.equal(r.status, 202);
  assert.deepEqual(leerComentarios(e.p, 'acme/api', 1).map((c) => c.id), [(await r.json()).comentario.id]);
});

test('POST /api/checks/arreglar refuses findings of an earlier commit and lines that are not valid', async (t) => {
  const viejo = prDe(1, { verificaciones: { headSha: 'b'.repeat(40), hallazgos: [MEDIO_1], resumen: resumir([MEDIO_1]) } });
  const CERO = hallazgo(0, 'alto', { linea: 0, texto: 'cero' });
  const e = await entorno({ prs: [viejo, conChecks(2, [CERO])], ejecutarCambios: cambiosFalsos([]) });
  t.after(e.cerrar);
  assert.equal((await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: huella(MEDIO_1) })).status, 409);
  assert.equal((await e.llamar('/api/checks/arreglar', { ...R(2), confirmar: true, huella: huella(CERO) })).status, 409);
  assert.deepEqual(leerComentarios(e.p, 'acme/api', 2), []);
});

test('GET /api/checks exposes the cap of a fix job', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  const d = await (await e.llamar('/api/checks?repo=acme/api&numero=1')).json();
  assert.equal(typeof d.topeArreglo, 'number');
  assert.ok(d.topeArreglo > 0);
});

const ATRIBUCION = { regla: 'atribucion-ia', titulo: 'Commit with AI attribution', severidad: 'alto', archivo: 'commit abc1234', texto: 'feat: x', mensaje: 'Remove the trailer.', origen: 'Standing rule' };

test('an AI attribution finding is not triable and has no fix, but a person can dismiss it with a reason', async (t) => {
  const e = await entorno({ prs: [conChecks(1, [ATRIBUCION]), conChecks(2, [ATRIBUCION, ALTO])], ejecutarCambios: cambiosFalsos([]) });
  t.after(e.cerrar);
  assert.equal((await (await e.llamar('/api/checks?repo=acme/api&numero=1')).json()).triables, 0);
  assert.equal((await (await e.llamar('/api/checks?repo=acme/api&numero=2')).json()).triables, 1);
  assert.equal((await e.llamar('/api/checks/triar', { ...R(), confirmar: true })).status, 409);
  assert.equal((await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: huella(ATRIBUCION) })).status, 409);
  assert.equal((await e.llamar('/api/checks/descartar', { ...R(), huellas: [huella(ATRIBUCION)], motivo: 'Trailer removed on merge' })).status, 200);
});

test('a fix approved on an earlier commit no longer blocks a new request; one approved on this commit does', async (t) => {
  const e = await entorno({ ejecutarCambios: cambiosFalsos([]) });
  t.after(e.cerrar);
  const primero = await (await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: huella(MEDIO_1) })).json();
  await esperar(() => leerComentarios(e.p, 'acme/api', 1).every((c) => c.estado === 'propuesta'));
  actualizarComentario(e.p, 'acme/api', 1, primero.comentario.id, { estado: 'aprobado' });
  assert.equal((await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: huella(MEDIO_1) })).status, 409);
  actualizarComentario(e.p, 'acme/api', 1, primero.comentario.id, { headSha: 'b'.repeat(40) });
  const r = await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: huella(MEDIO_1) });
  assert.equal(r.status, 202);
  // The approved request stays as the record of what was pushed.
  assert.deepEqual(leerComentarios(e.p, 'acme/api', 1).map((c) => c.id), [primero.comentario.id, (await r.json()).comentario.id]);
});

test('cancelling the queue leaves a check fix failed with the reason Cancelled, so it can be requested again', async (t) => {
  const e = await entorno({ ia: { presupuestoDiarioUsd: 0.01 }, ejecutarCambios: cambiosFalsos([]) });
  t.after(e.cerrar);
  const { comentario } = await (await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: huella(MEDIO_1) })).json();
  assert.equal((await (await e.llamar('/api/estado')).json()).trabajos.find((x) => x.tipo === 'cambiar').estado, 'bloqueado_presupuesto');
  assert.equal((await (await e.llamar('/api/cancelar-cola', {})).json()).cancelados, 1);
  const c = leerComentarios(e.p, 'acme/api', 1).find((x) => x.id === comentario.id);
  assert.deepEqual([c.estado, c.motivo], ['error', 'Cancelled']);
  assert.equal((await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: huella(MEDIO_1) })).status, 202);
});

test('a fix that cannot be queued answers 409 and leaves its request failed', async (t) => {
  const e = await entorno({ ia: { presupuestoDiarioUsd: 0.01 }, ejecutarCambios: cambiosFalsos([]) });
  t.after(e.cerrar);
  const ahora = Date.now;
  const fijo = ahora();
  // Two requests in the same millisecond get the same job id while the first one still waits in the queue.
  Date.now = () => fijo;
  try {
    const primero = await (await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: huella(MEDIO_1) })).json();
    actualizarComentario(e.p, 'acme/api', 1, primero.comentario.id, { estado: 'error', motivo: 'x' });
    const r = await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: huella(MEDIO_1) });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, 'The fix could not be queued');
    const [c] = leerComentarios(e.p, 'acme/api', 1);
    assert.deepEqual([c.estado, c.motivo], ['error', 'The fix could not be queued']);
    // Another finding in the same millisecond gets its own job.
    assert.equal((await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: huella(MEDIO_2) })).status, 202);
  } finally {
    Date.now = ahora;
  }
});

test('a stored triage file without a verdict list does not break dismissing or fixing', async (t) => {
  const e = await entorno({ ejecutarCambios: cambiosFalsos([]) });
  t.after(e.cerrar);
  escribirJson(rutaTriaje(e.p.salida, 'acme/api', 1), { headSha: SHA, origen: 'checks' });
  assert.equal((await e.llamar('/api/checks/descartar', { ...R(), huellas: [huella(ALTO)] })).status, 400);
  assert.equal((await e.llamar('/api/checks/descartar', { ...R(), huellas: [huella(ALTO)], motivo: 'Reviewed' })).status, 200);
  assert.equal((await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: huella(MEDIO_1) })).status, 202);
});

test('POST /api/checks/arreglar leaves out the reason of a triage from an earlier commit', async (t) => {
  const e = await entorno({ ejecutarCambios: cambiosFalsos([]) });
  t.after(e.cerrar);
  triaje(e.p, [falso(MEDIO_1, 'Judged on other code')], 'b'.repeat(40));
  const r = await e.llamar('/api/checks/arreglar', { ...R(), confirmar: true, huella: huella(MEDIO_1) });
  assert.equal(r.status, 202);
  assert.equal((await r.json()).comentario.origenCheck.razon, undefined);
});
