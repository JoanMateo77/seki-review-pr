import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QA_DEFECTO } from '../mcp/lib/config.mjs';
import { secretoQa } from '../mcp/lib/acceso.mjs';
import { entregasDesdeCorte, filasDeGuia, firmaFila, fusionesDe, leerGuias, limpiarParaQa, registrarGuia } from '../mcp/lib/qa-guia.mjs';

const pr = (id, portal, extra = {}) => ({ id, repo: id.split('#')[0], portal, ambiente: 'pruebas', estadoPr: 'MERGED', mergeada: '2026-11-01T10:00:00Z', descripcion: '', ...extra });
const mapa = (...prs) => new Map(prs.map((x) => [x.id, x]));
const pista = (portal, prs, etapa = 'esperando_qa') => ({ portal, prs, etapa, alertas: [] });
const PROHIBIDO = /#\d|fix\/|feat\/|\.mjs|github\.com/;

test('limpiarParaQa strips each token kind and keeps normal text', () => {
  assert.equal(limpiarParaQa('Fix login (#123)'), 'Fix login');
  assert.equal(limpiarParaQa('See owner/repo#45 now'), 'See now');
  assert.equal(limpiarParaQa('Open https://github.com/o/r/pull/9 please'), 'Open please');
  assert.equal(limpiarParaQa('Branch feat/new-thing and fix/old-bug done'), 'Branch and done');
  assert.equal(limpiarParaQa('Edit src/lib/util.mjs and app.js'), 'Edit and');
  assert.equal(limpiarParaQa('Open the payment screen. Version 1.2 works'), 'Open the payment screen. Version 1.2 works');
  assert.equal(limpiarParaQa('1. Step one\n2. Step two'), '1. Step one\n2. Step two');
});

test('limpiarParaQa runs in linear time on pathological input', () => {
  const entradas = ['a/'.repeat(50000), 'a'.repeat(200000), '#'.repeat(100000), 'feat/' + 'a'.repeat(100000), ' '.repeat(100000) + '.', 'a.'.repeat(60000), 'a/'.repeat(5000) + '.'.repeat(50000)];
  const t0 = Date.now();
  for (const e of entradas) limpiarParaQa(e);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});

function base({ ids = ['X-001', 'X-002'], portales = ['p1', 'p2'] } = {}) {
  const prs = portales.map((po, i) => pr(`r#${i + 1}`, po));
  const e = { clave: 'k1', titulo: 'Fix login (#12) in src/a.mjs', ids, prs: prs.map((x) => x.id), pistas: prs.map((x) => pista(x.portal, [x.id])) };
  return { prs, e, prsPorId: mapa(...prs) };
}
const filas = (o) => filasDeGuia({ cfgRepos: {}, explicaciones: new Map(), rastreador: null, columnas: QA_DEFECTO.columnas, ...o });

test('two IDs x two portals give four rows with unique (etiqueta, portal)', () => {
  const { e, prsPorId } = base();
  const r = filas({ entregas: [e], prsPorId });
  assert.equal(r.length, 4);
  assert.equal(new Set(r.map((x) => `${x.etiqueta}|${x.portal}`)).size, 4);
  assert.equal(r[0].celdas[0], 'X-001');
  assert.equal(r[0].celdas[1], 'p1');
});

test('delivery without IDs gets E<position>', () => {
  const { e, prsPorId } = base({ ids: [], portales: ['p1'] });
  const r = filas({ entregas: [{ ...e, ids: [] }, { ...e, clave: 'k2', ids: [] }], prsPorId });
  assert.deepEqual(r.map((x) => x.etiqueta), ['E1', 'E2']);
});

test('only esperando_qa and qa_fallo tracks produce rows', () => {
  const { e, prsPorId } = base({ ids: [], portales: ['p1', 'p2'] });
  e.pistas[0].etapa = 'listo_produccion';
  e.pistas[1].etapa = 'qa_fallo';
  assert.deepEqual(filas({ entregas: [e], prsPorId }).map((x) => x.portal), ['p2']);
});

test('tracker content wins over explanation, explanation over body, then Steps pending', () => {
  const { e, prsPorId } = base({ ids: ['X-001'], portales: ['p1'] });
  prsPorId.get('r#1').descripcion = '## How to test\n- Body step one\n* Body step two\n1. Body step three\n## Other\n- ignored';
  const explicaciones = new Map([['r#1', { como_probar: ['Explain step one', 'Explain step two (#9)'] }]]);
  const rastreador = new Map([['X-001', { hallazgo: 'h', pasos: 'Tracker steps', esperado: 'Tracker expected', pantalla: 'Screen A', prioridad: 'High' }]]);
  const celda = (r, nombre) => r.celdas[QA_DEFECTO.columnas.indexOf(nombre)];
  let r = filas({ entregas: [e], prsPorId, explicaciones, rastreador })[0];
  assert.equal(celda(r, 'Steps'), 'Tracker steps');
  assert.equal(celda(r, 'Expected result'), 'Tracker expected');
  assert.equal(celda(r, 'Screen and access'), 'Screen A');
  assert.equal(celda(r, 'Priority'), 'High');
  r = filas({ entregas: [e], prsPorId, explicaciones })[0];
  assert.equal(celda(r, 'Steps'), '1. Explain step one\n2. Explain step two');
  assert.equal(celda(r, 'Expected result'), 'Fix login in');
  assert.equal(r.pendiente, false);
  r = filas({ entregas: [e], prsPorId })[0];
  assert.equal(celda(r, 'Steps'), '1. Body step one\n2. Body step two\n3. Body step three');
  prsPorId.get('r#1').descripcion = 'nothing useful';
  r = filas({ entregas: [e], prsPorId })[0];
  assert.equal(celda(r, 'Steps'), 'Steps pending');
  assert.equal(r.pendiente, true);
});

test('body list is capped at 20 items and no cell leaks PR numbers, branches or files', () => {
  const { e, prsPorId } = base({ ids: ['X-001'], portales: ['p1'] });
  prsPorId.get('r#1').descripcion = '### Cómo probar\n' + Array.from({ length: 30 }, (_, i) => `- do ${i} (#12) on fix/abc in x.mjs`).join('\n');
  const r = filas({ entregas: [e], prsPorId })[0];
  assert.equal(r.celdas[4].split('\n').length, 20);
  for (const c of r.celdas) assert.doesNotMatch(c, PROHIBIDO);
});

test('entregasDesdeCorte excludes a covered track and includes it again after a newer merge', () => {
  const { e, prsPorId } = base({ ids: ['X-001'], portales: ['p1', 'p2'] });
  const guias = [{ id: 'g1', fusiones: fusionesDe([e], prsPorId) }];
  assert.equal(entregasDesdeCorte({ entregas: [e], guias: [], prsPorId }).length, 1);
  assert.equal(entregasDesdeCorte({ entregas: [e], guias, prsPorId }).length, 0);
  prsPorId.get('r#2').mergeada = '2026-11-03T10:00:00Z';
  const r = entregasDesdeCorte({ entregas: [e], guias, prsPorId });
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].pistas.map((x) => x.portal), ['p2']);
});

test('firmaFila changes with any key field and not with PR order', () => {
  const s = Buffer.alloc(32, 1);
  const k = { guia: 'g', etiqueta: 'X-001', portal: 'p1', prs: ['a#1', 'b#2'], entrega: 'k' };
  const f = firmaFila(s, k);
  assert.match(f, /^[0-9a-f]{64}$/);
  assert.equal(firmaFila(s, { ...k, prs: ['b#2', 'a#1'] }), f);
  for (const c of [{ guia: 'h' }, { etiqueta: 'X-002' }, { portal: 'p2' }, { prs: ['a#1'] }, { entrega: 'z' }]) assert.notEqual(firmaFila(s, { ...k, ...c }), f);
  assert.notEqual(firmaFila(Buffer.alloc(32, 2), k), f);
});

test('secretoQa is stable and mode 0600; registrarGuia round-trips', async () => {
  const p = { salida: mkdtempSync(join(tmpdir(), 'seki-qa-')) };
  const a = secretoQa(p);
  assert.equal(a.length, 32);
  assert.deepEqual(secretoQa(p), a);
  assert.equal(statSync(join(p.salida, 'datos', 'secreto-qa')).mode & 0o777, 0o600);
  assert.deepEqual(leerGuias(p), { guias: [] });
  await registrarGuia(p, { id: 'g1', fecha: '2026-11-04', entregas: ['k'], filas: [{ etiqueta: 'X-001', portal: 'p1', entrega: 'k', prs: ['a#1'], celdas: ['x'] }], fusiones: { 'a#1': '2026-11-01T10:00:00Z' } });
  const { guias } = leerGuias(p);
  assert.equal(guias.length, 1);
  assert.deepEqual(guias[0].filas[0], { etiqueta: 'X-001', portal: 'p1', entrega: 'k', prs: ['a#1'] });
});
