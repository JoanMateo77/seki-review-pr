import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext, Script } from 'node:vm';
import { construirHtml } from '../mcp/lib/tablero.mjs';

const SHA = 'a'.repeat(40);
const PR = { id: 'r#1', repo: 'r', numero: 1, url: 'https://github.test/o/r/pull/1', headSha: SHA, estadoPr: 'OPEN' };
const MAL = '<img src=x onerror=alert(1)>';

// The board script parts, evaluated with minimal stubs: the review intake (Copy review) and the templates tab.
const PARTES = new URL('../mcp/tablero/partes/', import.meta.url);
function tablero({ api = async () => ({}), sinApi = false, revision = null, comentarios = [], hash = '' } = {}) {
  const escape = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clics = [];
  const copias = [];
  const avisos = [];
  const llamadas = [];
  const eventos = [];
  const ctx = createContext({
    API: sinApi ? null : { token: 't' }, FOTO: { owner: 'o', prs: [PR] }, estado: { cerrados: new Set(), seleccion: 'r#1', trabajos: new Map(), tab: 'plantillas' },
    esc: escape, plural: (a, b, c) => `${a} ${a === 1 ? b : c}`, icono: () => '', usd: (x) => `USD ${x}`, $: (id) => (id === 'modalIa' ? { querySelector: () => null } : null), senales: () => '', tono: () => '',
    revision: () => revision, comentarios: () => comentarios, copiar: (boton, texto) => copias.push(texto), avisar: (t) => avisos.push(t),
    DECISIONES: { aprobada: ['Approved', 'verde'], cambios: ['Requests changes', 'rojo'] },
    transcurrido: () => '', sondear() {}, pintarDetalle() {}, repintarDetalle() {}, seleccionar: (id) => eventos.push(['seleccionar', id]), pintarBarra() {}, pintarCola() {},
    api: async (ruta, cuerpo) => { llamadas.push([ruta, cuerpo]); return api(ruta, cuerpo); },
    document: { addEventListener: (tipo, f) => { if (tipo === 'click') clics.push(f); }, activeElement: null }, window: { addEventListener() {} }, location: { hash }, history: { replaceState() {} },
    setTimeout: () => 0, sessionStorage: { getItem: () => null, setItem() {} },
  });
  for (const parte of ['07b-modos.js', '07c-revisar.js', '07d-plantillas.js']) runInContext(readFileSync(new URL(parte, PARTES), 'utf8'), ctx);
  // The dialog helpers of 07b-modos.js need a DOM: they are replaced by recorders.
  Object.assign(ctx, { abrirModal: (h) => eventos.push(['modal', h]), cerrarModal() {}, modoActual: () => 'normal' });
  // A click on "Copy review", then the queued promise callbacks.
  const copiarRevision = async () => {
    const boton = {};
    const ev = { target: { closest: (sel) => (sel === '[data-copiar-revision]' ? boton : null) } };
    for (const f of clics) f(ev);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };
  return { ctx, copias, avisos, llamadas, eventos, copiarRevision };
}

const item = (id, estado, extra = {}) => ({ id, pregunta: `Question ${id}?`, siFalla: { etiqueta: 'issue', bloqueante: true }, estado, origen: 'ia', ...extra });
const resultado = (extra = {}) => ({
  headSha: SHA, fecha: '2026-11-09T10:00:00Z', seleccion: { activas: [{ id: 'ligera', version: 1, titulo: 'Light baseline', motivo: 'siempre' }], omitidas: [], sinPlantilla: [] },
  plantillas: [{ id: 'ligera', version: 1, titulo: 'Light baseline', idioma: 'en', ok: true, costo: 0.5, items: [
    item('L1-descripcion', 'falla', { archivo: 'src/a.ts', linea: 3, cita: MAL, titulo: 'Undeclared change', detalle: 'Detail', veredicto: 'CONFIRMED' }),
    item('L3-gemelas', 'cumple', { repo: 'otro-repo', archivo: 'src/b.ts', linea: 9, cita: 'const twin = true;' }),
    item('L2-pruebas', 'no_verificable', { pedido: 'Where are the tests?' }),
    item('L5-x', 'no_verificable', { motivo: 'The review did not cover this item' }),
    item('L7-tipos', 'cumple', { origen: 'determinista', detalle: 'No added line matches the rules as-any, tipo-any' }),
  ] }],
  comentarios: [{}], markdown: '**issue (blocking): Undeclared change**\n`src/a.ts:3`', recortados: 0, ...extra,
});

test('the checklist shows each item with its state, link and escaped quote', () => {
  const html = tablero().ctx.resultadoPlantillas(PR, resultado());
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  for (const marca of ['Light baseline', 'L1-descripcion', 'Question L1-descripcion?', 'Fails', 'Passes', 'Not verifiable', 'Where are the tests?', 'The review did not cover this item', 'Undeclared change', 'Detail', 'Confirmed']) {
    assert.ok(html.includes(marca), `the checklist lacks ${marca}`);
  }
  assert.match(html, /class="estado rojo"[^<]*Fails/);
  assert.match(html, /class="estado verde"[^<]*Passes/);
  assert.match(html, /class="estado ambar"[^<]*Not verifiable/);
  // Evidence in this PR links to its files; evidence in another repository is plain text.
  assert.match(html, /<a href="https:\/\/github\.test\/o\/r\/pull\/1\/files"[^>]*>src\/a\.ts:3<\/a>/);
  assert.match(html, /otro-repo · src\/b\.ts:9/);
  assert.doesNotMatch(html, /<a [^>]*>src\/b\.ts:9/);
  // The comments preview is the stored Markdown, escaped, in a <pre>.
  assert.match(html, /<pre[^>]*>\*\*issue \(blocking\): Undeclared change\*\*\n`src\/a\.ts:3`<\/pre>/);
  assert.doesNotMatch(html, /desactualizad|received commits/);
});

test('every field written by the model or a template is escaped', () => {
  const r = resultado({ headSha: MAL, otrosRepos: 'no_disponibles', verificacion: 'fallida', recortados: 2, markdown: MAL });
  r.plantillas.push({ id: MAL, version: 1, titulo: MAL, idioma: 'en', ok: false, motivo: MAL, costo: 0, items: [item(MAL, 'falla', { pregunta: MAL, archivo: MAL, linea: 1, cita: MAL, titulo: MAL, detalle: MAL, repo: MAL }), item('x', 'no_verificable', { pedido: MAL })] });
  const html = tablero().ctx.resultadoPlantillas({ ...PR, url: MAL }, r);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /Other repositories were not available/);
  assert.match(html, /verification pass failed/);
  assert.match(html, /2 comments were left out/);
});

test('the outdated banner shows after new commits', () => {
  const { ctx } = tablero();
  assert.match(ctx.resultadoPlantillas(PR, resultado({ desactualizada: true })), /The PR received commits after this review/);
  // A result loaded before a refresh brought a new head commit is outdated too.
  assert.match(ctx.resultadoPlantillas({ ...PR, headSha: 'c'.repeat(40) }, resultado()), /The PR received commits after this review/);
});

test('the tab shows the selection with its reasons, the estimate button and the stored result', async () => {
  const datos = {
    seleccion: { activas: [{ id: 'ligera', titulo: 'Light baseline', motivo: 'siempre' }, { id: 'owasp-web', titulo: 'OWASP web', motivo: { archivo: 'src/routes/x.ts', glob: 'src/routes/**' } }], omitidas: [{ id: 'pci-dss', titulo: 'PCI DSS' }], sinPlantilla: ['README.md'] },
    invalidas: [{ archivo: 'rota.json', motivo: MAL }], estimacion: { usd: 1.25, base: 'topes', muestras: 0 }, topeUsd: 3.5, resultado: null,
  };
  const t = tablero({ api: async () => datos });
  t.ctx.tabPlantillas(PR);
  await new Promise((r) => setImmediate(r));
  const html = t.ctx.tabPlantillas(PR);
  for (const marca of ['Light baseline', 'Always applies', 'OWASP web', 'src/routes/**', 'src/routes/x.ts', 'PCI DSS', 'README.md', 'rota.json', 'Review with templates · ~USD 1.25', 'data-plantillas-abrir="r#1"', 'has no template review yet']) {
    assert.ok(html.includes(marca), `the tab lacks ${marca}`);
  }
  assert.doesNotMatch(html, /<img/);
  assert.equal(t.llamadas.length, 1);
  assert.equal(t.llamadas[0][0], '/api/plantillas?repo=r&numero=1');
  // A closed PR shows no button.
  assert.doesNotMatch(t.ctx.tabPlantillas({ ...PR, estadoPr: 'MERGED' }), /data-plantillas-abrir/);
});

test('copy review appends the template comments only when the result is current', async () => {
  const t = tablero({ revision: { decision: 'cambios' }, api: async () => ({ seleccion: {}, resultado: resultado() }) });
  const base = t.ctx.revisionMarkdown(PR, { decision: 'cambios' }, []);
  assert.equal(base, 'Decision: Requests changes');
  assert.equal(t.ctx.revisionMarkdown(PR, { decision: 'cambios' }, [], resultado()), `Decision: Requests changes\n\n---\n\n${resultado().markdown}`);
  assert.equal(t.ctx.revisionMarkdown(PR, { decision: 'cambios' }, [], resultado({ markdown: '' })), base);
  assert.equal(t.ctx.revisionMarkdown(PR, null, [], resultado()), resultado().markdown);
  // Not loaded yet: one GET before copying, then the copy carries the template comments.
  await t.copiarRevision();
  assert.deepEqual(t.llamadas.map((x) => x[0]), ['/api/plantillas?repo=r&numero=1']);
  assert.deepEqual(t.copias, [`Decision: Requests changes\n\n---\n\n${resultado().markdown}`]);
  // Loaded: no second GET.
  await t.copiarRevision();
  assert.equal(t.llamadas.length, 1);
  assert.equal(t.copias.length, 2);
});

test('copy review ignores an outdated template result', async () => {
  const { ctx } = tablero();
  assert.equal(ctx.revisionMarkdown(PR, { decision: 'cambios' }, [], resultado({ desactualizada: true })), 'Decision: Requests changes');
  assert.equal(ctx.revisionMarkdown({ ...PR, headSha: 'c'.repeat(40) }, { decision: 'cambios' }, [], resultado()), 'Decision: Requests changes');
  const t = tablero({ revision: { decision: 'cambios' }, api: async () => ({ seleccion: {}, resultado: resultado({ desactualizada: true }) }) });
  await t.copiarRevision();
  assert.deepEqual(t.copias, ['Decision: Requests changes']);
  // Only an outdated result and nothing of the owner's: nothing to copy.
  const vacio = tablero({ api: async () => ({ seleccion: {}, resultado: resultado({ desactualizada: true }) }) });
  await vacio.copiarRevision();
  assert.deepEqual(vacio.copias, []);
  assert.equal(vacio.avisos.length, 1);
});

test('copy review still works without the API or when the template data cannot be loaded', async () => {
  const sinApi = tablero({ sinApi: true, revision: { decision: 'aprobada' } });
  await sinApi.copiarRevision();
  assert.deepEqual(sinApi.copias, ['Decision: Approved']);
  assert.equal(sinApi.llamadas.length, 0);
  const falla = tablero({ revision: { decision: 'aprobada' }, api: async () => { throw new Error('down'); } });
  await falla.copiarRevision();
  assert.deepEqual(falla.copias, ['Decision: Approved']);
});

test('the link selects the PR and opens the confirmation without starting the review', async () => {
  const datos = { seleccion: { activas: [{ id: 'ligera', titulo: 'Light baseline', motivo: 'siempre' }], omitidas: [], sinPlantilla: [] }, invalidas: [], estimacion: { usd: 1.25, base: 'historial', muestras: 4 }, topeUsd: 2, resultado: resultado() };
  const t = tablero({ hash: '#/pr/r/1?plantillas=1', api: async () => datos });
  t.ctx.abrirPlantillasDesdeEnlace();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(t.eventos[0], ['seleccionar', 'r#1']);
  const modal = t.eventos.filter((e) => e[0] === 'modal').at(-1)[1];
  for (const marca of ['Template review of r #1', 'Light baseline', 'Always applies', 'USD 1.25', 'from 4 earlier reviews', 'Run again', 'data-plantillas-confirmar="r#1"']) {
    assert.ok(modal.includes(marca), `the confirmation lacks ${marca}`);
  }
  assert.ok(t.llamadas.every(([, cuerpo]) => cuerpo === undefined), 'the link never posts');
  const otro = tablero({ hash: '#/pr/r/1?ultra=1' });
  otro.ctx.abrirPlantillasDesdeEnlace();
  assert.equal(otro.eventos.length, 0);
});

test('only the confirmation button posts, with confirmar and the repeat flag', async () => {
  const datos = { seleccion: { activas: [], omitidas: [], sinPlantilla: [] }, invalidas: [], estimacion: { usd: 0, base: 'topes', muestras: 0 }, topeUsd: 0, resultado: null };
  const t = tablero({ api: async (ruta, cuerpo) => (cuerpo ? { encolado: 'r#1:plantillas' } : datos) });
  await t.ctx.abrirPlantillas('r#1');
  const modal = t.eventos.filter((e) => e[0] === 'modal').at(-1)[1];
  assert.match(modal, /no AI cost: only fixed rules apply/);
  assert.match(modal, /data-repetir="false">Start review</);
  assert.ok(t.llamadas.every(([, cuerpo]) => cuerpo === undefined));
  await t.ctx.confirmarPlantillas('r#1', false);
  assert.deepEqual(JSON.parse(JSON.stringify(t.llamadas.at(-1))), ['/api/plantillas', { repo: 'r', numero: 1, repetir: false, modo: 'normal', confirmar: true }]);
  assert.equal(t.ctx.estado.tab, 'plantillas');
});

test('the built page carries the templates tab and its link', () => {
  const orden = JSON.parse(readFileSync(new URL('orden.json', PARTES), 'utf8'));
  assert.equal(orden.indexOf('07d-plantillas.js'), orden.indexOf('07c-revisar.js') + 1);
  const html = construirHtml({ salida: '/nonexistent', ia: {} }, { prs: [] }, { token: 't' });
  for (const marca of ['data-plantillas-abrir', 'data-plantillas-confirmar', '?plantillas=1', 'Template review', "'plantillas', 'Templates'"]) {
    assert.ok(html.includes(marca), `the built page lacks ${marca}`);
  }
  for (const codigo of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Script(codigo[1]));
});
