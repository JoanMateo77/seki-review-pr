import { recolectar } from '../lib/recolectar.mjs';

const ESTADO = { en_pruebas: 'en pruebas', parcial: 'parcial', no_en_pruebas: 'no en pruebas' };

export default {
  name: 'prs_pendientes',
  description:
    'Lista las PRs abiertas (y las mergeadas en pruebas cuyo código no llegó a producción) de un proyecto (por defecto las del usuario) agrupadas por acción: ' +
    'ya en pruebas y falta producción, otra versión en pruebas, sin pasar a pruebas, hacia pruebas, ramas inactivas. ' +
    'Para cada PR hacia producción comprueba si su código ya está en la rama de pruebas. Guarda la foto para el tablero.',
  inputSchema: {
    type: 'object',
    properties: {
      proyecto: { type: 'string', description: 'Clave del proyecto en proyectos.json', default: 'demo' },
      repos: { type: 'array', items: { type: 'string' }, description: 'Limitar a estos repos' },
      incluir_inactivas: { type: 'boolean', default: false },
    },
  },
  async handler({ proyecto, repos, incluir_inactivas = false }) {
    const foto = await recolectar({ proyecto, repos, incluirInactivas: true });
    const lineas = [`${foto.proyecto}: ${foto.prs.length} PRs abiertas (${foto.generado.slice(0, 16)})`];
    const c = foto.cambios;
    if (c) {
      lineas.push('', `## Cambios detectados entre ${c.desde.slice(0, 16)} y ${c.hasta.slice(0, 16)}`);
      for (const x of c.mergeadas) lineas.push(`- Mergeada: ${x.repo}#${x.numero} ${x.titulo} (en ${x.base})`);
      for (const x of c.cerradas) lineas.push(`- ${x.estado === 'cerrada' ? 'Cerrada sin mergear' : 'Salió de la lista'}: ${x.repo}#${x.numero} ${x.titulo}`);
      for (const x of c.nuevas) lineas.push(`- Nueva: ${x.repo}#${x.numero} ${x.titulo}`);
      for (const x of c.movidas) lineas.push(`- Cambió de grupo: ${x.repo}#${x.numero} ${foto.acciones[x.de] ?? x.de} -> ${foto.acciones[x.a] ?? x.a}`);
    }
    for (const [accion, titulo] of Object.entries(foto.acciones)) {
      if (accion === 'inactiva' && !incluir_inactivas) {
        const n = foto.prs.filter((x) => x.accion === accion).length;
        if (n) lineas.push('', `## ${titulo}: ${n} PRs (incluir_inactivas=true para listarlas)`);
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
          x.estadoPr === 'MERGED' && 'mergeada en pruebas',
          x.estadoPruebas && `${ESTADO[x.estadoPruebas.estado]} ${x.estadoPruebas.iguales}/${x.estadoPruebas.total}${x.estadoPruebas.conflicto ? ' con conflicto' : ''}`,
          x.sinProd && 'código ausente en producción',
          x.gemela && `gemela #${x.gemela.numero} ${x.gemela.estado}`,
          faltantes.length && `sin equivalente en ${faltantes.join(', ')}`,
          v && (v.bloqueante || v.alto) && `verificaciones: ${v.bloqueante} bloqueantes, ${v.alto} altas`,
          `${x.dias} d`,
          x.adiciones !== undefined && `+${x.adiciones}/-${x.eliminaciones}`,
          `esfuerzo ${x.explicacion?.esfuerzo ?? x.esfuerzoTamano ?? '?'}/5`,
          x.explicacion ? (x.explicacion.desactualizada ? 'explicación desactualizada' : 'explicada') : 'sin explicación',
        ].filter(Boolean).join(' · ');
        lineas.push(`- ${x.repo}#${x.numero} ${x.titulo} [${extra}]`);
      }
    }
    return lineas.join('\n');
  },
};
