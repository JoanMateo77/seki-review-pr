import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext, Script } from 'node:vm';
import { construirHtml } from '../mcp/lib/tablero.mjs';

const SHA = 'a'.repeat(40);
const MAL = '<img src=x onerror=alert(1)>';
const PARTES = new URL('../mcp/tablero/partes/', import.meta.url);

const hallazgo = (huella, extra = {}) => ({ huella, regla: 'ejs-sin-escapar', titulo: `Finding ${huella}`, severidad: 'medio', archivo: 'views/list.ejs', linea: 4, texto: `<%- ${huella} %>`, mensaje: 'Unescaped output', origen: 'ejs-sin-escapar', ...extra });
const veredicto = (huella, v, razon = `Reason ${huella}`) => ({ huella, veredicto: v, razon });
const triaje = (veredictos, extra = {}) => ({ headSha: SHA, fecha: '2026-11-09T10:00:00Z', origen: 'triaje', modelo: 'm', costo: 0.2, desactualizado: false, veredictos, ...extra });
const pr = ({ hallazgos = [], descartados = [], t = null } = {}) => ({
  id: 'acme/api#7', repo: 'acme/api', numero: 7, url: 'https://github.test/acme/api/pull/7', headSha: SHA, estadoPr: 'OPEN',
  verificaciones: { headSha: SHA, hallazgos, descartados, resumen: {} }, triaje: t,
});

// The board script parts, evaluated with minimal stubs (as in tablero-plantillas.test.mjs).
function tablero({ api = async () => ({}), sinApi = false, trabajos = [], foto, hash = '', comentarios: iniciales = [] } = {}) {
  const escape = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const llamadas = [];
  const modales = [];
  const cajas = { motivoCheck: { value: '' }, modalIaError: { textContent: '', hidden: true } };
  // The estimate dialog swaps its spinner for the error text: this records what it was swapped for.
  const carga = { outerHTML: '<p class="trabajando"></p>' };
  const repintados = [];
  let guardados = iniciales;
  const seleccionados = [];
  const ctx = createContext({
    API: sinApi ? null : { token: 't' }, FOTO: foto ?? { owner: 'o', prs: [] },
    estado: { cerrados: new Set(), seleccion: 'acme/api#7', tab: 'verificaciones', trabajos: new Map(trabajos.map((t) => [t.id, t])) },
    esc: escape, plural: (a, b, c) => `${a} ${a === 1 ? b : c}`, icono: () => '', usd: (x) => `USD ${x}`, nivel: (v) => v, transcurrido: () => '',
    $: (id) => (id === 'modalIa' ? { querySelector: (sel) => (sel === '.trabajando' ? carga : null) } : cajas[id] ?? null),
    avisar() {}, sondear() {}, pintarDetalle: () => repintados.push('detalle'), repintarDetalle() {}, pintarTodo: () => repintados.push('todo'), seleccionar: (id) => seleccionados.push(id),
    // Bodies are copied out of the vm realm so deepEqual compares plain values.
    api: async (ruta, cuerpo) => { llamadas.push(JSON.parse(JSON.stringify([ruta, cuerpo ?? null]))); return api(ruta, cuerpo); },
    document: { addEventListener() {}, activeElement: null }, window: { addEventListener() {} }, location: { hash }, history: { replaceState() {} },
    comentarios: () => guardados, escribirComentarios: (_pr, lista) => { guardados = lista; }, sincronizarComentarios: async () => {},
    fusionarComentarios: (a, b) => [...a, ...b],
    setTimeout() {}, clearTimeout() {}, sessionStorage: { getItem: () => null, setItem() {} },
  });
  runInContext(readFileSync(new URL('07b-modos.js', PARTES), 'utf8'), ctx);
  runInContext(readFileSync(new URL('07e-checks.js', PARTES), 'utf8'), ctx);
  // The dialog helpers of 07b-modos.js need a DOM: they are replaced by recorders.
  Object.assign(ctx, { abrirModal: (h) => modales.push(h), cerrarModal() {}, modoActual: () => 'normal' });
  return { ctx, llamadas, modales, cajas, carga, repintados, seleccionados, guardados: () => guardados };
}

test('every field written by the model or a person is escaped', () => {
  const p = pr({
    hallazgos: [hallazgo('h1', { texto: MAL, titulo: MAL, mensaje: MAL })],
    descartados: [hallazgo('h2', { descarte: { motivo: MAL, propuestoPor: 'persona', fecha: '2026-11-09T10:00:00Z' } })],
    t: triaje([veredicto('h1', 'dudoso', MAL)]),
  });
  const html = tablero().ctx.tabVerificaciones(p);
  assert.doesNotMatch(html, /<img/);
  assert.ok(html.split('&lt;img src=x onerror=alert(1)&gt;').length > 4);
});

test('without the API verdicts and dismissals are shown but no button', () => {
  const p = pr({
    hallazgos: [hallazgo('h1', { severidad: 'alto' })],
    descartados: [hallazgo('h2', { descarte: { motivo: 'Only a literal', propuestoPor: 'ia', fecha: '2026-11-09T10:00:00Z' } })],
    t: triaje([veredicto('h1', 'falso_positivo', 'Escaped upstream')]),
  });
  const html = tablero({ sinApi: true }).ctx.tabVerificaciones(p);
  assert.doesNotMatch(html, /<button|data-check-/);
  for (const marca of ['False positive', 'Escaped upstream', 'Dismissed (1)', 'Only a literal']) assert.ok(html.includes(marca), `lacks ${marca}`);
});

test('a blocking finding with a false positive verdict stays in the open table', () => {
  const p = pr({ hallazgos: [hallazgo('h1', { severidad: 'bloqueante' })], t: triaje([veredicto('h1', 'falso_positivo')]) });
  const html = tablero().ctx.tabVerificaciones(p);
  const abiertos = html.slice(0, html.indexOf('Dismissed (') === -1 ? undefined : html.indexOf('Dismissed ('));
  assert.ok(abiertos.includes('Finding h1'));
  assert.match(html, /False positive/);
  assert.match(html, /data-check-accion="descartar"[^>]*data-check-huella="h1"/);
  assert.doesNotMatch(html, /Dismissed \(/);
});

test('the verdict column shows Real, Unclear and a dash, and flags an earlier commit', () => {
  const hs = [hallazgo('h1'), hallazgo('h2'), hallazgo('h3', { severidad: 'aviso' })];
  const t = triaje([veredicto('h1', 'real'), veredicto('h2', 'dudoso')], { desactualizado: true });
  const html = tablero().ctx.tabVerificaciones(pr({ hallazgos: hs, t }));
  for (const marca of ['Real', 'Unclear', '—', 'Reason h1', 'from an earlier commit']) assert.ok(html.includes(marca), `lacks ${marca}`);
  assert.doesNotMatch(tablero().ctx.tabVerificaciones(pr({ hallazgos: hs, t: triaje([veredicto('h1', 'real')]) })), /earlier commit/);
});

test('the bulk button needs at least two medium false positives', () => {
  const uno = pr({ hallazgos: [hallazgo('h1'), hallazgo('h2'), hallazgo('h3', { severidad: 'alto' })], t: triaje([veredicto('h1', 'falso_positivo'), veredicto('h2', 'real'), veredicto('h3', 'falso_positivo')]) });
  assert.doesNotMatch(tablero().ctx.tabVerificaciones(uno), /Dismiss all false positives/);
  const dos = pr({ hallazgos: [hallazgo('h1'), hallazgo('h2'), hallazgo('h3', { severidad: 'alto' })], t: triaje([veredicto('h1', 'falso_positivo'), veredicto('h2', 'falso_positivo'), veredicto('h3', 'falso_positivo')]) });
  assert.match(tablero().ctx.tabVerificaciones(dos), /Dismiss all false positives \(2\)/);
});

test('a dismissed finding appears only under Dismissed, with who proposed it and Reopen', () => {
  const p = pr({ hallazgos: [hallazgo('h1')], descartados: [hallazgo('h2', { descarte: { motivo: 'Literal only', propuestoPor: 'ia', fecha: '2026-11-09T10:00:00Z' } })] });
  const html = tablero().ctx.tabVerificaciones(p);
  const corte = html.indexOf('Dismissed (1)');
  assert.ok(corte > 0);
  assert.ok(html.slice(0, corte).includes('Finding h1') && !html.slice(0, corte).includes('Finding h2'));
  assert.ok(html.slice(corte).includes('Finding h2') && !html.slice(corte).includes('Finding h1'));
  assert.match(html.slice(corte), /Literal only/);
  assert.match(html.slice(corte), /AI/);
  assert.match(html, /data-check-accion="reabrir"[^>]*data-check-huella="h2"/);
});

test('Validate with AI is disabled while a job of the PR is active and offers Run again with a current triage', () => {
  const p = pr({ hallazgos: [hallazgo('h1')] });
  const libre = tablero().ctx.tabVerificaciones(p);
  assert.match(libre, /<button[^>]*data-check-accion="validar"(?![^>]*disabled)[^>]*>[^<]*Validate with AI/);
  for (const id of ['acme/api#7:checks', 'acme/api#7:ultra']) {
    const html = tablero({ trabajos: [{ id, estado: 'en_curso' }] }).ctx.tabVerificaciones(p);
    assert.match(html, /<button[^>]*data-check-accion="validar"[^>]*disabled/, id);
  }
  assert.doesNotMatch(tablero({ trabajos: [{ id: 'acme/api#7:checks', estado: 'terminado' }] }).ctx.tabVerificaciones(p), /data-check-accion="validar"[^>]*disabled/);
  assert.doesNotMatch(tablero({ trabajos: [{ id: 'otra#1:checks', estado: 'en_curso' }] }).ctx.tabVerificaciones(p), /data-check-accion="validar"[^>]*disabled/);
  const otra = tablero().ctx.tabVerificaciones(pr({ hallazgos: [hallazgo('h1')], t: triaje([veredicto('h1', 'real')]) }));
  assert.match(otra, /data-check-accion="validar"[^>]*>[^<]*Run again/);
  // Nothing to triage: no button.
  assert.doesNotMatch(tablero().ctx.tabVerificaciones(pr({ hallazgos: [hallazgo('h1', { severidad: 'aviso' })] })), /data-check-accion="validar"/);
});

test('the footer states what the rules are and where dismissals live', () => {
  const html = tablero().ctx.tabVerificaciones(pr({ hallazgos: [hallazgo('h1')] }));
  assert.ok(html.includes('Fixed rules over the added lines, no AI: they flag patterns, they don’t confirm there is a problem. Validate them with AI or dismiss a false positive with a reason; the dismissal is stored by Seki, not in the PR.'));
});

test('Dismiss opens the dialog with the AI reason, blocking warning and a disabled button when empty', () => {
  const p = pr({ hallazgos: [hallazgo('h1', { severidad: 'bloqueante' }), hallazgo('h2')], t: triaje([veredicto('h1', 'falso_positivo', MAL)]) });
  const t = tablero();
  t.ctx.accionCheck('descartar', p, { checkHuella: 'h1' });
  const html = t.modales.at(-1);
  assert.match(html, /<textarea[^>]*maxlength="500"[^>]*>&lt;img src=x onerror=alert\(1\)&gt;<\/textarea>/);
  assert.ok(html.includes('This finding blocks the PR. Dismiss it only if the code shows it is not a problem.'));
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /data-check-accion="descartar-confirmar"[^>]*disabled/);
  // Without an AI reason the person must write one.
  t.ctx.accionCheck('descartar', p, { checkHuella: 'h2' });
  assert.match(t.modales.at(-1), /data-check-accion="descartar-confirmar"[^>]*disabled/);
  assert.doesNotMatch(t.modales.at(-1), /blocks the PR/);
});

test('confirming a dismissal sends the trimmed reason, or none when the AI reason is kept, and reloads the snapshot', async () => {
  const p = pr({ hallazgos: [hallazgo('h1'), hallazgo('h2')], t: triaje([veredicto('h1', 'falso_positivo', 'Escaped upstream')]) });
  const t = tablero({ api: async (ruta) => (ruta === '/api/foto' ? { owner: 'o', prs: [] } : { descartados: 1 }) });
  t.cajas.motivoCheck.value = '  Written by a person  ';
  await t.ctx.accionCheck('descartar-confirmar', p, { checkHuella: 'h1' });
  assert.deepEqual(t.llamadas[0], ['/api/checks/descartar', { repo: 'acme/api', numero: 7, huellas: ['h1'], motivo: 'Written by a person' }]);
  assert.equal(t.llamadas[1][0], '/api/foto');
  assert.ok(t.repintados.includes('todo'));
  t.cajas.motivoCheck.value = ' Escaped upstream ';
  await t.ctx.accionCheck('descartar-confirmar', p, { checkHuella: 'h1' });
  assert.deepEqual(t.llamadas[2][1], { repo: 'acme/api', numero: 7, huellas: ['h1'] });
});

test('a blank reason is never sent and a server error stays in the dialog', async () => {
  const p = pr({ hallazgos: [hallazgo('h1')] });
  const t = tablero({ api: async () => { throw new Error('A motivo is required'); } });
  t.cajas.motivoCheck.value = '   ';
  await t.ctx.accionCheck('descartar-confirmar', p, { checkHuella: 'h1' });
  assert.equal(t.llamadas.length, 0);
  t.cajas.motivoCheck.value = 'Reason';
  await t.ctx.accionCheck('descartar-confirmar', p, { checkHuella: 'h1' });
  assert.equal(t.cajas.modalIaError.textContent, 'A motivo is required');
  assert.equal(t.cajas.modalIaError.hidden, false);
});

test('the bulk dialog lists the findings and confirming sends every fingerprint without a reason', async () => {
  const p = pr({ hallazgos: [hallazgo('h1'), hallazgo('h2'), hallazgo('h3')], t: triaje([veredicto('h1', 'falso_positivo'), veredicto('h2', 'falso_positivo'), veredicto('h3', 'real')]) });
  const t = tablero({ api: async () => ({ owner: 'o', prs: [] }) });
  t.ctx.accionCheck('descartar-lote', p, {});
  assert.ok(t.modales.at(-1).includes('Finding h1') && t.modales.at(-1).includes('Finding h2') && !t.modales.at(-1).includes('Finding h3'));
  const confirmar = /data-check-accion="descartar-lote-confirmar"[^>]*data-check-huellas="([^"]*)"/.exec(t.modales.at(-1));
  await t.ctx.accionCheck('descartar-lote-confirmar', p, { checkHuellas: confirmar?.[1] });
  assert.deepEqual(t.llamadas[0], ['/api/checks/descartar', { repo: 'acme/api', numero: 7, huellas: ['h1', 'h2'] }]);
});

test('the bulk confirmation sends the fingerprints listed when the dialog opened, not a new selection', async () => {
  const p = pr({ hallazgos: [hallazgo('h1'), hallazgo('h2')], t: triaje([veredicto('h1', 'falso_positivo'), veredicto('h2', 'falso_positivo')]) });
  const t = tablero({ api: async () => ({ owner: 'o', prs: [] }) });
  t.ctx.accionCheck('descartar-lote', p, {});
  const abierto = /data-check-huellas="([^"]*)"/.exec(t.modales.at(-1))?.[1];
  // A reload while the dialog is open changes what the snapshot holds.
  p.triaje = triaje([veredicto('h1', 'falso_positivo'), veredicto('h2', 'real')]);
  p.verificaciones.hallazgos.push(hallazgo('h3'));
  p.triaje.veredictos.push(veredicto('h3', 'falso_positivo'));
  await t.ctx.accionCheck('descartar-lote-confirmar', p, { checkHuellas: abierto });
  assert.deepEqual(t.llamadas[0][1].huellas, ['h1', 'h2']);
});

test('the action column of both tables has a hidden Actions label', () => {
  const p = pr({ hallazgos: [hallazgo('h1')], descartados: [hallazgo('h2', { descarte: { motivo: 'm', propuestoPor: 'persona', fecha: '2026-11-09T10:00:00Z' } })] });
  const html = tablero().ctx.tabVerificaciones(p);
  assert.equal(html.split('<th><span class="sr">Actions</span></th>').length - 1, 2);
  assert.doesNotMatch(html, /<th><\/th>/);
  assert.doesNotMatch(tablero({ sinApi: true }).ctx.tabVerificaciones(p), /Actions/);
});

test('Reopen posts the fingerprint and reloads the snapshot', async () => {
  const t = tablero({ api: async () => ({ owner: 'o', prs: [] }) });
  await t.ctx.accionCheck('reabrir', pr(), { checkHuella: 'h2' });
  assert.deepEqual(t.llamadas[0], ['/api/checks/reabrir', { repo: 'acme/api', numero: 7, huella: 'h2' }]);
  assert.equal(t.llamadas[1][0], '/api/foto');
});

test('Validate with AI asks for the estimate, shows it and starts the triage only after confirmation', async () => {
  const p = pr({ hallazgos: [hallazgo('h1')] });
  const t = tablero({ api: async (ruta) => (ruta.startsWith('/api/checks?') ? { triaje: null, descartes: [], triables: 1, estimacion: { usd: 0.12, base: 'tope', muestras: 0 }, topeUsd: 0.3 } : { encolado: 'acme/api#7:checks' }) });
  await t.ctx.accionCheck('validar', p, {});
  assert.equal(t.llamadas[0][0], '/api/checks?repo=acme%2Fapi&numero=7');
  assert.equal(t.llamadas.length, 1);
  const html = t.modales.at(-1);
  assert.ok(html.includes('USD 0.12'));
  assert.match(html, /data-check-accion="validar-confirmar"[^>]*>[^<]*Validate/);
  await t.ctx.accionCheck('validar-confirmar', p, { repetir: 'false' });
  assert.deepEqual(t.llamadas[1], ['/api/checks/triar', { repo: 'acme/api', numero: 7, confirmar: true, repetir: false, modo: 'normal' }]);
});

test('a failed estimate shows the error inside the dialog and nothing is started', async () => {
  const t = tablero({ api: async () => { throw new Error('Server down'); } });
  await t.ctx.accionCheck('validar', pr({ hallazgos: [hallazgo('h1')] }), {});
  assert.equal(t.llamadas.length, 1);
  assert.match(t.carga.outerHTML, /<p class="error-texto">Server down<\/p>/);
  assert.ok(!t.llamadas.some(([ruta]) => ruta === '/api/checks/triar'));
});

test('a PR that is not open offers no Validate with AI', () => {
  const t = tablero();
  for (const estadoPr of ['MERGED', 'CLOSED']) {
    const html = t.ctx.tabVerificaciones({ ...pr({ hallazgos: [hallazgo('h1')] }), estadoPr });
    assert.doesNotMatch(html, /data-check-accion="validar"/, estadoPr);
    assert.doesNotMatch(html, /Validate with AI/, estadoPr);
  }
});

test('the ?checks=1 link selects the PR on the Checks tab and nothing else', () => {
  const foto = { owner: 'o', prs: [pr()] };
  const t = tablero({ foto, hash: '#/pr/acme%2Fapi/7?checks=1' });
  t.ctx.estado.tab = 'resumen';
  t.ctx.abrirChecksDesdeEnlace();
  assert.equal(t.ctx.estado.tab, 'verificaciones');
  assert.deepEqual(t.seleccionados, ['acme/api#7']);
  assert.equal(t.llamadas.length, 0);
  assert.equal(t.modales.length, 0);
});

const peticion = (huella, extra = {}) => ({ id: `c-${huella}`, tipo: 'cambio', estado: 'en_cola', origenCheck: { huella }, creado: '2026-11-10T10:00:00Z', ...extra });

test('Fix is offered on rows with a line and no active request, and only on an open PR', () => {
  const p = pr({ hallazgos: [hallazgo('h1'), hallazgo('h2', { linea: undefined })] });
  const html = tablero().ctx.tabVerificaciones(p);
  assert.match(html, /data-check-accion="arreglar"[^>]*data-check-huella="h1"/);
  assert.doesNotMatch(html, /data-check-accion="arreglar"[^>]*data-check-huella="h2"/);
  assert.doesNotMatch(tablero().ctx.tabVerificaciones({ ...p, estadoPr: 'MERGED' }), /data-check-accion="arreglar"/);
  assert.doesNotMatch(tablero({ sinApi: true }).ctx.tabVerificaciones(p), /arreglar|>Fix</);
});

test('a row with a request shows its state instead of Fix, and links the proposal', () => {
  const p = pr({ hallazgos: [hallazgo('h1'), hallazgo('h2'), hallazgo('h3'), hallazgo('h4')] });
  const html = tablero({ comentarios: [peticion('h1'), peticion('h2', { estado: 'propuesta', propuestaId: 'p-1' }), peticion('h3', { estado: 'error', motivo: MAL }), peticion('h4', { estado: 'aprobado' })] }).ctx.tabVerificaciones(p);
  const fila = (n) => html.split('<tr>').find((f) => f.includes(`Finding h${n}`));
  assert.ok(fila(1).includes('Fix requested') && !/arreglar/.test(fila(1)));
  assert.ok(fila(2).includes('Proposal ready') && !/arreglar/.test(fila(2)));
  assert.match(fila(2), /<a [^>]*data-tab-ir="archivos"[^>]*>[^<]*Proposal ready/);
  assert.ok(fila(3).includes('Fix failed: &lt;img src=x onerror=alert(1)&gt;'));
  assert.match(fila(3), /data-check-accion="arreglar"[^>]*data-check-huella="h3"/);
  assert.doesNotMatch(html, /<img/);
  assert.ok(fila(4).includes('Fix approved') && !/arreglar/.test(fila(4)));
});

test('after a failed request the latest one decides the row', () => {
  const p = pr({ hallazgos: [hallazgo('h1')] });
  const t = tablero({ comentarios: [peticion('h1', { estado: 'error', motivo: 'old', creado: '2026-11-10T09:00:00Z' }), peticion('h1')] });
  assert.ok(t.ctx.tabVerificaciones(p).includes('Fix requested'));
});

test('Fix opens a dialog with the escaped finding, the cost cap and nothing is sent yet', async () => {
  const t = tablero({ api: async () => ({ topeArreglo: 0.5 }) });
  await t.ctx.accionCheck('arreglar', pr({ hallazgos: [hallazgo('h1', { titulo: MAL })] }), { checkHuella: 'h1' });
  assert.deepEqual(t.llamadas, [['/api/checks?repo=acme%2Fapi&numero=7&modo=normal', null]]);
  const html = t.modales.at(-1);
  assert.ok(html.includes('Fix this finding with AI'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;') && !html.includes('<img'));
  assert.ok(html.includes('views/list.ejs:4'));
  assert.ok(html.includes('An AI edits a copy of the branch and leaves a proposal. Nothing is pushed until the proposal is approved.'));
  assert.ok(html.includes('Up to USD 0.5'));
  assert.match(html, /data-check-accion="arreglar-confirmar"[^>]*data-check-huella="h1"[^>]*>Request fix</);
  assert.ok(html.includes('data-modal-cerrar'));
});

test('Request fix sends the confirmation, replaces a failed or discarded request locally and repaints', async () => {
  const comentario = peticion('h1', { estado: 'en_cola' });
  const t = tablero({ api: async () => ({ comentario }), comentarios: [peticion('h1', { id: 'c-viejo', estado: 'error', motivo: 'x' }), peticion('h1', { id: 'c-desc', estado: 'descartado' }), peticion('h9')] });
  await t.ctx.accionCheck('arreglar-confirmar', pr({ hallazgos: [hallazgo('h1')] }), { checkHuella: 'h1' });
  assert.deepEqual(t.llamadas, [['/api/checks/arreglar', { repo: 'acme/api', numero: 7, huella: 'h1', modo: 'normal', confirmar: true }]]);
  assert.deepEqual(t.guardados().map((c) => c.id), ['c-h9', 'c-h1']);
  assert.ok(t.repintados.length > 0);
});

test('Request fix is disabled while the request is in flight and enabled again after an error', async () => {
  const boton = { disabled: false };
  let estadoEnVuelo;
  const t = tablero({ api: async () => { estadoEnVuelo = boton.disabled; throw new Error('Server down'); } });
  t.ctx.$ = (id) => (id === 'modalIa' ? { querySelector: () => boton } : t.cajas[id] ?? null);
  await t.ctx.accionCheck('arreglar-confirmar', pr({ hallazgos: [hallazgo('h1')] }), { checkHuella: 'h1' });
  assert.equal(estadoEnVuelo, true);
  assert.equal(boton.disabled, false);
  assert.equal(t.cajas.modalIaError.textContent, 'Server down');
});

test('a discarded request shows Fix discarded together with Fix', () => {
  const p = pr({ hallazgos: [hallazgo('h1')] });
  const html = tablero({ comentarios: [peticion('h1', { estado: 'descartado' })] }).ctx.tabVerificaciones(p);
  assert.ok(html.includes('Fix discarded'));
  assert.match(html, /data-check-accion="arreglar"[^>]*data-check-huella="h1"/);
});

// The proposal card (06-script-3.js) with the stubs it needs.
function tarjeta({ pr: prDe = {}, api = async () => ({ ok: true, commit: 'abcdef123' }), confirmar = null } = {}) {
  const avisos = [];
  const ctx = createContext({
    API: { token: 't' }, avisos,
    estado: { propuestas: new Map(), confirmarAprobar: confirmar, ajustando: null, seleccion: 'acme/api#7' },
    esc: (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    prSel: () => ({ id: 'acme/api#7', url: 'https://github.test/acme/api/pull/7', estadoPr: 'OPEN', ...prDe }),
    plural: (a, b, c) => `${a} ${a === 1 ? b : c}`, icono: () => '', usd: (x) => `USD ${x}`, nombreModelo: (m) => m, check: () => '',
    SekiAnclaje: { lineasDePatch: () => [] }, api: async (...a) => api(...a), avisar: (m) => avisos.push(m), sincronizarComentarios: async () => {},
    pintarDetalle() {}, sondear() {}, transcurrido: () => '', almacen: {}, $: () => ({ scrollTop: 0, querySelector: () => null, querySelectorAll: () => [] }),
  });
  runInContext(readFileSync(new URL('06-script-3.js', PARTES), 'utf8'), ctx);
  return ctx;
}
const propuesta = (extra = {}) => ({ id: 'p-1', estado: 'lista', resumen: 'fix: x', patch: '', archivos: [], fueraDelComentario: [], modelo: 'm', conFallos: false, comprobaciones: { reglas: { bloqueantes: 0, hallazgos: [], resumen: {} }, tipos: null, tests: null }, ...extra });
const tarjetaDe = (ctx, prop) => { ctx.estado.propuestas.set(prop.id, prop); return ctx.propuestaHtml({ propuestaId: prop.id }); };

test('the proposal card flags a check proposal that keeps the finding and needs the second click', () => {
  const ctx = tarjeta();
  const ok = tarjetaDe(ctx, propuesta({ check: { huella: 'h1', regla: 'r', resuelto: true } }));
  assert.doesNotMatch(ok, /Does not remove the finding/);
  assert.ok(ok.includes('Approve and push to the branch'));
  const no = propuesta({ check: { huella: 'h1', regla: 'r', resuelto: false } });
  assert.equal(ctx.necesitaConfirmar(no), true);
  assert.equal(ctx.necesitaConfirmar(propuesta({ conFallos: true })), true);
  assert.equal(ctx.necesitaConfirmar(propuesta()), false);
  const primera = tarjetaDe(ctx, no);
  assert.ok(primera.includes('Does not remove the finding'));
  assert.doesNotMatch(primera, /Approve and push to the branch/);
  assert.doesNotMatch(primera, /A second click pushes/);
  ctx.estado.confirmarAprobar = 'p-1';
  assert.match(tarjetaDe(ctx, no), /A second click pushes it to the branch anyway/);
});

test('the approve button names the author, escaped, only for a PR in the To review list', () => {
  const prop = propuesta();
  assert.ok(tarjetaDe(tarjeta({ pr: { paraRevisar: 'asignada', autor: MAL } }), prop).includes('Approve and push to &lt;img src=x onerror=alert(1)&gt;’s branch'));
  assert.ok(tarjetaDe(tarjeta({ pr: { autor: 'ana' } }), prop).includes('Approve and push to the branch'));
  assert.ok(tarjetaDe(tarjeta({ pr: { paraRevisar: 'asignada' } }), prop).includes('Approve and push to the branch'));
  assert.doesNotMatch(tarjetaDe(tarjeta({ pr: { paraRevisar: 'asignada', autor: MAL } }), prop), /<img/);
});

test('every approve state and the confirmation paragraph name the owner on a To review PR', () => {
  const alPropietario = { paraRevisar: 'asignada', autor: 'ana' };
  const casos = [
    [propuesta({ conFallos: true }), 'Approve with failures and push to ana’s branch', 'Confirm: approve with failures and push to ana’s branch'],
    [propuesta({ check: { huella: 'h', regla: 'r', resuelto: false } }), 'Approve anyway and push to ana’s branch', 'Confirm: approve anyway and push to ana’s branch'],
  ];
  for (const [prop, primera, segunda] of casos) {
    const ctx = tarjeta({ pr: alPropietario });
    assert.ok(tarjetaDe(ctx, prop).includes(`>${primera}<`));
    ctx.estado.confirmarAprobar = prop.id;
    const html = tarjetaDe(ctx, prop);
    assert.ok(html.includes(`>${segunda}<`));
    assert.ok(html.includes('A second click pushes it to ana’s branch anyway.'));
  }
  const ctx = tarjeta({ pr: { paraRevisar: 'asignada', autor: MAL } });
  ctx.estado.confirmarAprobar = 'p-1';
  const html = tarjetaDe(ctx, propuesta({ conFallos: true }));
  assert.doesNotMatch(html, /<img/);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;’s branch anyway.'));
  // Without an owner the wording is the one of the own branch.
  const propia = tarjeta();
  propia.estado.confirmarAprobar = 'p-1';
  assert.ok(tarjetaDe(propia, propuesta({ conFallos: true })).includes('>Confirm: approve with failures<'));
});

test('the approve click of an unresolved check proposal sends confirmarFallos only on the second click', async () => {
  const cuerpos = [];
  const ctx = tarjeta({ api: async (ruta, cuerpo) => { cuerpos.push(cuerpo); return { ok: true, commit: 'abcdef123' }; } });
  ctx.estado.propuestas.set('p-1', propuesta({ check: { huella: 'h1', regla: 'r', resuelto: false } }));
  const boton = { disabled: false };
  await ctx.clicAprobar('p-1', boton);
  assert.equal(cuerpos.length, 0);
  assert.equal(ctx.estado.confirmarAprobar, 'p-1');
  assert.equal(boton.disabled, false);
  await ctx.clicAprobar('p-1', boton);
  assert.equal(cuerpos.length, 1);
  assert.equal(cuerpos[0].confirmarFallos, true);
  assert.equal(boton.disabled, true);
});

test('a proposal that needs no confirmation is approved at the first click', async () => {
  const cuerpos = [];
  const ctx = tarjeta({ api: async (ruta, cuerpo) => { cuerpos.push(cuerpo); return { ok: true, commit: 'abcdef123' }; } });
  ctx.estado.propuestas.set('p-1', propuesta({ check: { huella: 'h1', regla: 'r', resuelto: true } }));
  await ctx.clicAprobar('p-1', { disabled: false });
  assert.equal(cuerpos[0].confirmarFallos, false);
});

test('after approving a check proposal the notice says the twin does not have the fix', async () => {
  const conGemela = tarjeta({ pr: { gemela: { numero: 12, estado: 'OPEN' } } });
  conGemela.estado.propuestas.set('p-1', propuesta({ check: { huella: 'h1', regla: 'r', resuelto: true } }));
  await conGemela.accionPropuesta('aprobar', 'p-1', { confirmarFallos: false });
  assert.deepEqual(conGemela.avisos, ['Change pushed to the branch (abcdef1). The twin #12 does not have this fix.']);
  const sinCheck = tarjeta({ pr: { gemela: { numero: 12, estado: 'OPEN' } } });
  sinCheck.estado.propuestas.set('p-1', propuesta());
  await sinCheck.accionPropuesta('aprobar', 'p-1');
  assert.deepEqual(sinCheck.avisos, ['Change pushed to the branch (abcdef1).']);
});

test('the built page carries the Checks tab parts in order and parses', () => {
  const orden = JSON.parse(readFileSync(new URL('orden.json', PARTES), 'utf8'));
  assert.equal(orden.indexOf('02e-checks.css'), orden.indexOf('02d-revisar.css') + 1);
  assert.equal(orden.indexOf('07e-checks.js'), orden.indexOf('07d-plantillas.js') + 1);
  const html = construirHtml({ salida: '/nonexistent', ia: {} }, { prs: [pr({ hallazgos: [hallazgo('h1')] })] }, { token: 't' });
  for (const marca of ['data-check-accion', '?checks=1', 'Dismiss all false positives']) assert.ok(html.includes(marca), `the built page lacks ${marca}`);
  assert.equal((html.match(/function tabVerificaciones/g) ?? []).length, 1);
  for (const codigo of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Script(codigo[1]));
});
