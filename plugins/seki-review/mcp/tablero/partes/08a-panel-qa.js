// Pure description of the QA result panel: a tree of { e, a, h } nodes and strings, built from plain data with no DOM.
// Every value that comes from the server or from a file (names, reasons, PR ids) is a text child or a `text` attribute,
// so the builder in 08b can only render it as text.
const RESULTADO_QA = { ok: 'OK', fallo: 'Fail', bloqueado: 'Blocked', pendiente: 'Pending', na: 'N/A' };
const pluralQa = (n, s, p) => `${n} ${n === 1 ? s : p}`;

function descripcionPanelQa({ generando, mensajeGuia, guia, mensajeOperacion, importacion, rastreador, espera }) {
  const nodo = (e, a = {}, ...h) => ({ e, a, h: h.flat().filter((x) => x !== null && x !== undefined && x !== false) });
  const lista = (items, mapa) => nodo('ul', {}, items.map((x) => nodo('li', {}, mapa(x))));
  const archivo = (ext, etiqueta) => (guia.archivos?.[ext] ? { e: 'button', a: { type: 'button', class: 'btn-texto mono', accion: 'descargar', nombre: guia.archivos[ext] }, h: [`${etiqueta} (${guia.archivos[ext]})`] } : null);
  const hayAlgo = generando || guia || importacion || mensajeGuia || mensajeOperacion || rastreador?.aviso;
  if (!hayAlgo) return null;
  return nodo('section', { class: 'panel-qa', 'aria-label': 'QA result', 'aria-live': 'polite' },
    generando ? nodo('p', {}, 'Generating the QA guide. It can take up to a minute while the PDF is produced.') : null,
    generando && espera ? nodo('p', { class: 'aviso-qa' }, espera) : null,
    mensajeGuia ? nodo('p', { class: 'aviso-qa' }, mensajeGuia) : null,
    guia ? (guia.vacia
      ? nodo('p', {}, 'No deliveries are waiting for QA for this selection: no guide was generated.')
      : nodo('div', {},
        nodo('h3', {}, `Guide ${guia.id}: ${pluralQa(guia.filas, 'row', 'rows')}`),
        nodo('div', { class: 'archivos-qa' }, archivo('xlsx', 'Spreadsheet'), archivo('pdf', 'PDF'), archivo('html', 'HTML')),
        guia.avisoPdf ? nodo('p', { class: 'aviso-qa' }, guia.avisoPdf) : null,
        guia.pendientes?.length ? nodo('div', {}, nodo('p', {}, `Rows with steps pending, ${pluralQa(guia.pendientes.length, 'PR', 'PRs')}:`), lista(guia.pendientes, (id) => nodo('span', { class: 'mono' }, id))) : null,
        guia.encolados ? nodo('p', {}, `${pluralQa(guia.encolados, 'explanation', 'explanations')} queued for the PRs without steps. Generate the guide again when they finish.`) : null)) : null,
    mensajeOperacion ? nodo('p', { class: 'aviso-qa' }, mensajeOperacion) : null,
    importacion ? nodo('div', {},
      nodo('h3', {}, `Import of guide ${importacion.guia}: ${pluralQa(importacion.nuevos ?? 0, 'new result', 'new results')}`),
      importacion.resumen?.length ? nodo('table', { class: 'matriz' },
        nodo('thead', {}, nodo('tr', {}, ['Delivery', 'Portal', 'Result', 'Rows'].map((c) => nodo('th', {}, c)))),
        nodo('tbody', {}, importacion.resumen.map((x) => nodo('tr', {}, nodo('td', {}, String(x.entrega)), nodo('td', {}, String(x.portal)), nodo('td', {}, RESULTADO_QA[x.resultado] ?? 'Pending'), nodo('td', {}, String(x.filas)))))) : null,
      importacion.rechazadas?.length ? nodo('div', {}, nodo('p', {}, `Rejected rows (${importacion.rechazadas.length}):`), lista(importacion.rechazadas, (x) => `${x.etiqueta}${x.portal ? ` · ${x.portal}` : ''}: ${x.motivo}`)) : null,
      importacion.rastreador?.escrito ? nodo('p', {}, `Spreadsheet updated: ${pluralQa(importacion.rastreador.celdas, 'cell', 'cells')}`) : (importacion.rastreador?.motivo ? nodo('p', {}, `Spreadsheet: ${importacion.rastreador.motivo}`) : null)) : null,
    rastreador?.aviso ? nodo('p', { class: 'aviso-qa' }, `Tracker: ${rastreador.aviso}`) : null,
    generando ? null : { e: 'button', a: { type: 'button', class: 'btn chico', accion: 'descartar' }, h: ['Dismiss'] });
}
