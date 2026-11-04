import { proyecto as cargarProyecto } from '../lib/config.mjs';
import { datosEntregas } from '../lib/tablero-entregas.mjs';

export const ETAPAS = [
  ['por_mergear_pruebas', 'To merge in testing'],
  ['qa_fallo', 'QA failed'],
  ['esperando_qa', 'Waiting for QA'],
  ['listo_produccion', 'Ready for production'],
  ['en_produccion', 'In production'],
  ['cerrada', 'Closed'],
];

const TIPOS = {
  pr_mergeada: 'Merged',
  pr_cerrada: 'Closed without merging',
  entrega_cerrada: 'Delivery closed',
  entrega_ajustada: 'Delivery adjusted',
};

export function lineaEvento(e, datos) {
  const pr = e.pr ? datos.prs[e.pr] : null;
  const ambiente = e.ambiente === 'prod' ? ' into production' : e.ambiente === 'pruebas' ? ' into testing' : '';
  const sujeto = e.pr ? `${e.pr}${pr?.titulo ? ` ${pr.titulo}` : ''}${e.tipo === 'pr_mergeada' ? ambiente : ''}` : e.entrega ?? (e.prs ?? []).join(', ');
  return `${String(e.ts).slice(0, 16).replace('T', ' ')} ${TIPOS[e.tipo] ?? e.tipo}: ${sujeto}`;
}

export function resumenEntregas(datos, { desdeVisita = false } = {}) {
  const lineas = [`Deliveries computed at ${String(datos.generado).slice(0, 16).replace('T', ' ')}`];
  if (desdeVisita) {
    if (!datos.visita) lineas.push('', 'No previous visit recorded: no events to list.');
    else {
      const total = datos.totalDesdeVisita ?? datos.desdeVisita.length;
      lineas.push('', `## Since the last visit (${datos.visita.slice(0, 16).replace('T', ' ')}): ${total} events`);
      if (total > datos.desdeVisita.length) lineas.push(`(${total - datos.desdeVisita.length} earlier events not listed)`);
      for (const e of datos.desdeVisita) lineas.push(`- ${lineaEvento(e, datos)}`);
    }
  }
  for (const [etapa, titulo] of ETAPAS) {
    const grupo = datos.entregas.filter((e) => e.etapa === etapa);
    if (!grupo.length) continue;
    lineas.push('', `## ${titulo} (${grupo.length})`);
    for (const e of grupo) {
      const ids = e.ids?.length ? ` [${e.ids.join(', ')}]` : '';
      const alertas = (e.pistas ?? []).flatMap((x) => x.alertas ?? []).map((a) => a.detalle);
      lineas.push(`- ${e.titulo}${ids}: ${e.prs.join(', ')}. Next: ${e.siguiente}.${alertas.length ? ` Alerts: ${[...new Set(alertas)].join('; ')}.` : ''}`);
    }
  }
  const descartadas = datos.entregas.filter((e) => e.etapa === 'descartada').length;
  if (descartadas) lineas.push('', `${descartadas} discarded ${descartadas === 1 ? 'delivery' : 'deliveries'} not listed.`);
  return lineas.join('\n');
}

export default {
  name: 'entregas',
  description:
    'Summarizes the deliveries of a project (groups of related PRs across repos and environments) by stage, with the next action for each one ' +
    '(merge a testing PR, QA pending, merge a production PR, ...). With desde="ultima-visita" it also lists the events since the last dashboard visit. ' +
    'Reads the data computed on the last refresh; it does not query GitHub and does not change the last-visit mark.',
  inputSchema: {
    type: 'object',
    properties: {
      proyecto: { type: 'string', description: 'Project key in proyectos.json; defaults to the default project if omitted' },
      desde: { type: 'string', enum: ['ultima-visita'], description: 'List the events since the last dashboard visit' },
    },
  },
  async handler({ proyecto, desde } = {}) {
    const datos = datosEntregas(cargarProyecto(proyecto));
    if (!datos) return 'There are no deliveries yet: refresh the state first (prs_pendientes or the dashboard "Refresh status" button).';
    return resumenEntregas(datos, { desdeVisita: desde === 'ultima-visita' });
  },
};
