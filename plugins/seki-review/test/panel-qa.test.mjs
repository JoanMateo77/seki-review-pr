import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const PARTES = new URL('../mcp/tablero/partes/', import.meta.url);
const fuente = readFileSync(new URL('08a-panel-qa.js', PARTES), 'utf8');
const { descripcionPanelQa } = runInNewContext(`${fuente}\n({ descripcionPanelQa })`);
const HOSTIL = '<img src=x onerror=alert(1)>';

// Every string of the tree, plus the attribute names used: nothing may be an HTML sink.
function recorrer(d, fn) {
  if (d === null || typeof d === 'string') return fn(d);
  fn(d);
  for (const h of d.h) recorrer(h, fn);
}
const textos = (d) => { const t = []; recorrer(d, (x) => { if (typeof x === 'string') t.push(x); }); return t; };
const base = { generando: false, mensajeGuia: null, guia: null, mensajeOperacion: null, importacion: null, rastreador: null, espera: null };

test('no panel when there is nothing to show', () => {
  assert.equal(descripcionPanelQa(base), null);
});

test('generating state shows the wait notice and no Dismiss button', () => {
  const t = textos(descripcionPanelQa({ ...base, generando: true, espera: 'Still waiting: another guide or the PDF export is taking longer than usual.' }));
  assert.ok(t.some((x) => x.startsWith('Generating the QA guide')));
  assert.ok(t.some((x) => x.startsWith('Still waiting')));
  assert.ok(!t.includes('Dismiss'));
});

test('hostile strings stay text in every state and no node carries markup attributes', () => {
  const estados = [
    { guia: { id: HOSTIL, filas: 2, vacia: false, archivos: { xlsx: HOSTIL, pdf: null, html: HOSTIL }, avisoPdf: HOSTIL, pendientes: [HOSTIL], encolados: 1 } },
    { guia: { vacia: true, archivos: {} } },
    { mensajeGuia: HOSTIL },
    { mensajeOperacion: HOSTIL },
    { importacion: { guia: HOSTIL, nuevos: 1, resumen: [{ entrega: HOSTIL, portal: HOSTIL, resultado: HOSTIL, filas: HOSTIL }], rechazadas: [{ etiqueta: HOSTIL, portal: HOSTIL, motivo: HOSTIL }], rastreador: { escrito: false, motivo: HOSTIL } } },
    { rastreador: { configurado: true, pendientes: 0, aviso: HOSTIL } },
  ];
  for (const e of estados) {
    const d = descripcionPanelQa({ ...base, ...e });
    assert.ok(d, JSON.stringify(e));
    recorrer(d, (x) => {
      if (x === null || typeof x === 'string') return;
      assert.ok(['section', 'div', 'p', 'h3', 'ul', 'li', 'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'button'].includes(x.e));
      for (const [k, v] of Object.entries(x.a)) {
        assert.ok(['class', 'type', 'aria-label', 'aria-live', 'accion', 'nombre'].includes(k), `attribute ${k}`);
        if (k !== 'nombre') assert.ok(!String(v).includes('<'), `${k} carries markup`);
      }
    });
    if (e.guia && !e.guia.vacia) assert.ok(textos(d).some((x) => x.includes(HOSTIL)));
  }
});

test('guide with files lists each download as a named action and pending PRs', () => {
  const d = descripcionPanelQa({ ...base, guia: { id: 'guia-2026-11-04-1', filas: 3, vacia: false, archivos: { xlsx: 'guia-2026-11-04-1.xlsx', pdf: null, html: 'guia-2026-11-04-1.html' }, avisoPdf: 'PDF not generated.', pendientes: ['back#1'], encolados: 0 } });
  const acciones = [];
  recorrer(d, (x) => { if (x && typeof x === 'object' && x.a.accion === 'descargar') acciones.push(x.a.nombre); });
  assert.deepEqual(acciones, ['guia-2026-11-04-1.xlsx', 'guia-2026-11-04-1.html']);
  assert.ok(textos(d).includes('back#1'));
  assert.ok(textos(d).includes('PDF not generated.'));
});

test('import summary maps results, falls back to Pending and lists rejected rows', () => {
  const d = descripcionPanelQa({ ...base, importacion: { guia: 'g', nuevos: 2, resumen: [{ entrega: 'D1', portal: 'P', resultado: 'na', filas: 1 }, { entrega: 'D2', portal: 'P', resultado: 'raro', filas: 1 }], rechazadas: [{ etiqueta: 'X-1', portal: 'P', motivo: 'Row not in the guide' }], rastreador: { escrito: true, celdas: 3 } } });
  const t = textos(d);
  assert.ok(t.includes('N/A'));
  assert.ok(t.includes('Pending'));
  assert.ok(t.includes('X-1 · P: Row not in the guide'));
  assert.ok(t.includes('Spreadsheet updated: 3 cells'));
});

test('the board builds the panel without innerHTML', () => {
  const sinComentarios = (t) => t.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const f = sinComentarios(readFileSync(new URL('08b-entregas.js', PARTES), 'utf8') + fuente);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(f));
});
