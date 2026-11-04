import { proyecto as cargarProyecto } from '../lib/config.mjs';
import { generarGuia } from '../lib/qa-salida.mjs';

export default {
  name: 'qa_guia',
  description:
    'Generates the QA guide (xlsx, html and pdf under the output folder): one row per finding and portal, with the steps taken from the PR explanations or descriptions. ' +
    'Without keys it covers every track waiting for QA or already failed by QA, including tracks covered by an earlier guide; ' +
    'use desde="ultimo-corte" to include only the tracks merged into testing after the last guide, or claves to choose deliveries. ' +
    'It does not run the AI: PRs without steps are listed so they can be explained first.',
  inputSchema: {
    type: 'object',
    properties: {
      proyecto: { type: 'string', description: 'Project key in proyectos.json; defaults to the default project if omitted' },
      claves: { type: 'array', items: { type: 'string' }, description: 'Delivery keys to include; every track waiting for QA or failed by QA if omitted' },
      desde: { type: 'string', enum: ['ultimo-corte'], description: 'Only tracks merged into testing after the last guide' },
    },
  },
  async handler({ proyecto, claves, desde } = {}) {
    const r = await generarGuia(cargarProyecto(proyecto), { claves, desde });
    if (r.vacia) return 'There are no deliveries waiting for QA for this selection: no guide was generated.';
    const lineas = [`Guide ${r.id}: ${r.filas} rows.`, `- xlsx: ${r.archivos.xlsx}`, `- html: ${r.archivos.html}`, `- pdf: ${r.archivos.pdf ?? 'not generated'}`];
    if (r.avisoPdf) lineas.push('', r.avisoPdf);
    if (r.pendientes.length) lineas.push('', `PRs without steps (${r.pendientes.length}): ${r.pendientes.join(', ')}. Run explain on them, then generate the guide again.`);
    return lineas.join('\n');
  },
};
