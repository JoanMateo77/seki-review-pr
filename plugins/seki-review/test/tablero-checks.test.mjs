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
function tablero({ api = async () => ({}), sinApi = false, trabajos = [], foto, hash = '' } = {}) {
  const escape = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const llamadas = [];
  const modales = [];
  const cajas = { motivoCheck: { value: '' }, modalIaError: { textContent: '', hidden: true } };
  const repintados = [];
  const seleccionados = [];
  const ctx = createContext({
    API: sinApi ? null : { token: 't' }, FOTO: foto ?? { owner: 'o', prs: [] },
    estado: { cerrados: new Set(), seleccion: 'acme/api#7', tab: 'verificaciones', trabajos: new Map(trabajos.map((t) => [t.id, t])) },
    esc: escape, plural: (a, b, c) => `${a} ${a === 1 ? b : c}`, icono: () => '', usd: (x) => `USD ${x}`, nivel: (v) => v, transcurrido: () => '',
    $: (id) => (id === 'modalIa' ? { querySelector: () => null } : cajas[id] ?? null),
    avisar() {}, sondear() {}, pintarDetalle: () => repintados.push('detalle'), repintarDetalle() {}, pintarTodo: () => repintados.push('todo'), seleccionar: (id) => seleccionados.push(id),
    // Bodies are copied out of the vm realm so deepEqual compares plain values.
    api: async (ruta, cuerpo) => { llamadas.push(JSON.parse(JSON.stringify([ruta, cuerpo ?? null]))); return api(ruta, cuerpo); },
    document: { addEventListener() {}, activeElement: null }, window: { addEventListener() {} }, location: { hash }, history: { replaceState() {} },
    setTimeout() {}, clearTimeout() {}, sessionStorage: { getItem: () => null, setItem() {} },
  });
  runInContext(readFileSync(new URL('07b-modos.js', PARTES), 'utf8'), ctx);
  runInContext(readFileSync(new URL('07e-checks.js', PARTES), 'utf8'), ctx);
  // The dialog helpers of 07b-modos.js need a DOM: they are replaced by recorders.
  Object.assign(ctx, { abrirModal: (h) => modales.push(h), cerrarModal() {}, modoActual: () => 'normal' });
  return { ctx, llamadas, modales, cajas, repintados, seleccionados };
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
  await t.ctx.accionCheck('descartar-lote-confirmar', p, {});
  assert.deepEqual(t.llamadas[0], ['/api/checks/descartar', { repo: 'acme/api', numero: 7, huellas: ['h1', 'h2'] }]);
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

test('the built page carries the Checks tab parts in order and parses', () => {
  const orden = JSON.parse(readFileSync(new URL('orden.json', PARTES), 'utf8'));
  assert.equal(orden.indexOf('02e-checks.css'), orden.indexOf('02d-revisar.css') + 1);
  assert.equal(orden.indexOf('07e-checks.js'), orden.indexOf('07d-plantillas.js') + 1);
  const html = construirHtml({ salida: '/nonexistent', ia: {} }, { prs: [pr({ hallazgos: [hallazgo('h1')] })] }, { token: 't' });
  for (const marca of ['data-check-accion', '?checks=1', 'Dismiss all false positives']) assert.ok(html.includes(marca), `the built page lacks ${marca}`);
  assert.equal((html.match(/function tabVerificaciones/g) ?? []).length, 1);
  for (const codigo of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Script(codigo[1]));
});
