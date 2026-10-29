import { recolectar } from '../lib/recolectar.mjs';

const ESTADO = { en_pruebas: 'in testing', parcial: 'partial', no_en_pruebas: 'not in testing' };

export default {
  name: 'prs_pendientes',
  description:
    'Lists the open PRs of a project (plus PRs merged into testing whose code never reached production), by default the first project in proyectos.json and the user\'s own PRs, grouped by action: ' +
    'already in testing and pending production, a different version in testing, not yet in testing, targeting testing, inactive branches. ' +
    'For each PR targeting production it checks whether its code is already in the testing branch. Saves the snapshot for the dashboard.',
  inputSchema: {
    type: 'object',
    properties: {
      proyecto: { type: 'string', description: 'Project key in proyectos.json; defaults to the default project if omitted' },
      repos: { type: 'array', items: { type: 'string' }, description: 'Limit to these repos' },
      incluir_inactivas: { type: 'boolean', default: false },
    },
  },
  async handler({ proyecto, repos, incluir_inactivas = false }) {
    const foto = await recolectar({ proyecto, repos, incluirInactivas: true });
    const lineas = [`${foto.proyecto}: ${foto.prs.length} open PRs (${foto.generado.slice(0, 16)})`];
    const c = foto.cambios;
    if (c) {
      lineas.push('', `## Changes detected between ${c.desde.slice(0, 16)} and ${c.hasta.slice(0, 16)}`);
      for (const x of c.mergeadas) lineas.push(`- Merged: ${x.repo}#${x.numero} ${x.titulo} (into ${x.base})`);
      for (const x of c.cerradas) lineas.push(`- ${x.estado === 'cerrada' ? 'Closed without merging' : 'Left the list'}: ${x.repo}#${x.numero} ${x.titulo}`);
      for (const x of c.nuevas) lineas.push(`- New: ${x.repo}#${x.numero} ${x.titulo}`);
      for (const x of c.movidas) lineas.push(`- Changed group: ${x.repo}#${x.numero} ${foto.acciones[x.de] ?? x.de} -> ${foto.acciones[x.a] ?? x.a}`);
    }
    for (const [accion, titulo] of Object.entries(foto.acciones)) {
      if (accion === 'inactiva' && !incluir_inactivas) {
        const n = foto.prs.filter((x) => x.accion === accion).length;
        if (n) lineas.push('', `## ${titulo}: ${n} PRs (set incluir_inactivas=true to list them)`);
        continue;
      }
      const grupo = foto.prs.filter((x) => x.accion === accion);
      if (!grupo.length) continue;
      lineas.push('', `## ${titulo} (${grupo.length})`);
      for (const x of grupo) {
        const v = x.verificaciones?.resumen;
        const faltantes = (x.hermanas ?? []).filter((h) => !h.numero).map((h) => h.portal);
        const extra = [
          x.portal,
          x.estadoPr === 'MERGED' && 'merged into testing',
          x.estadoPruebas && `${ESTADO[x.estadoPruebas.estado]} ${x.estadoPruebas.iguales}/${x.estadoPruebas.total}${x.estadoPruebas.conflicto ? ' with conflict' : ''}`,
          x.sinProd && 'code missing from production',
          x.gemela && `twin #${x.gemela.numero} ${x.gemela.estado}`,
          faltantes.length && `no equivalent in ${faltantes.join(', ')}`,
          v && (v.bloqueante || v.alto) && `checks: ${v.bloqueante} blocking, ${v.alto} high`,
          `${x.dias} d`,
          x.adiciones !== undefined && `+${x.adiciones}/-${x.eliminaciones}`,
          `effort ${x.explicacion?.esfuerzo ?? x.esfuerzoTamano ?? '?'}/5`,
          x.explicacion ? (x.explicacion.desactualizada ? 'explanation outdated' : 'explained') : 'no explanation',
        ].filter(Boolean).join(' · ');
        lineas.push(`- ${x.repo}#${x.numero} ${x.titulo} [${extra}]`);
      }
    }
    return lineas.join('\n');
  },
};
