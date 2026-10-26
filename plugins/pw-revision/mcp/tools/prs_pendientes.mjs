import { recolectar } from '../lib/recolectar.mjs';

const ESTADO = { en_pruebas: 'en pruebas', parcial: 'parcial', no_en_pruebas: 'no en pruebas' };

export default {
  name: 'prs_pendientes',
  description:
    'Lista las PRs abiertas de un proyecto (por defecto las del usuario) agrupadas por acción: ' +
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
        const extra = [
          x.portal,
          x.estadoPruebas && `${ESTADO[x.estadoPruebas.estado]} ${x.estadoPruebas.iguales}/${x.estadoPruebas.total}${x.estadoPruebas.conflicto ? ' con conflicto' : ''}`,
          x.gemela && `gemela #${x.gemela.numero} ${x.gemela.estado}`,
          `${x.dias} d`,
          `+${x.adiciones}/-${x.eliminaciones}`,
          x.explicacion ? (x.explicacion.desactualizada ? 'explicación desactualizada' : 'explicada') : 'sin explicación',
        ].filter(Boolean).join(' · ');
        lineas.push(`- ${x.repo}#${x.numero} ${x.titulo} [${extra}]`);
      }
    }
    return lineas.join('\n');
  },
};
