import { proyecto as cargarProyecto } from '../lib/config.mjs';
import { importarQa } from '../lib/qa-importar.mjs';

const NOMBRE = { ok: 'passed', fallo: 'failed', pendiente: 'pending', bloqueado: 'blocked' };

export function resumenImportacion(r) {
  const lineas = [`Guide ${r.guia}: ${r.nuevos} new result${r.nuevos === 1 ? '' : 's'} recorded.`];
  for (const x of r.resumen) lineas.push(`- ${x.entrega} / ${x.portal}: ${NOMBRE[x.resultado] ?? x.resultado} (${x.filas} ${x.filas === 1 ? 'row' : 'rows'})`);
  if (r.rechazadas.length) {
    lineas.push('', `Rejected rows (${r.rechazadas.length}):`);
    for (const x of r.rechazadas) lineas.push(`- ${x.etiqueta || '(no ID)'} / ${x.portal || '(no portal)'}: ${x.motivo}`);
  }
  lineas.push('', r.rastreador.escrito ? `Tracker updated (${r.rastreador.celdas ?? 0} cells).` : `Tracker not updated: ${r.rastreador.motivo ?? 'unknown reason'}.`);
  return lineas.join('\n');
}

export default {
  name: 'qa_importar',
  description:
    'Imports a filled QA guide (xlsx) and moves the deliveries from "Waiting for QA" to "Ready for production" or "QA failed" according to the Result column. ' +
    'Rows are matched by their signed ID and portal, so sorting or deleting rows is fine; edited keys and results from an outdated guide are rejected. ' +
    'The file must be inside the output QA folder or Downloads, otherwise confirmar must be true.',
  inputSchema: {
    type: 'object',
    properties: {
      proyecto: { type: 'string', description: 'Project key in proyectos.json; defaults to the default project if omitted' },
      ruta: { type: 'string', description: 'Path of the filled .xlsx guide' },
      confirmar: { type: 'boolean', description: 'Allow a file outside the output QA folder and Downloads' },
    },
    required: ['ruta'],
  },
  async handler({ proyecto, ruta, confirmar } = {}) {
    return resumenImportacion(await importarQa(cargarProyecto(proyecto), { ruta, confirmar: confirmar === true }));
  },
};
