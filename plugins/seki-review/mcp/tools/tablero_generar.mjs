import { execFile } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { proyecto as cargarProyecto } from '../lib/config.mjs';
import { recolectar } from '../lib/recolectar.mjs';
import { construirHtml, fotoConExplicaciones } from '../lib/tablero.mjs';

export default {
  name: 'tablero_generar',
  description:
    'Generates the local HTML PR review dashboard (a file, not published to any service) with filters by portal, action and risk, ' +
    'and each PR\'s detail with its explanation. Uses the latest prs_pendientes snapshot unless refrescar=true.',
  inputSchema: {
    type: 'object',
    properties: {
      proyecto: { type: 'string', description: 'Project key in proyectos.json; defaults to the default project if omitted' },
      refrescar: { type: 'boolean', default: false, description: 'Query GitHub again before generating' },
      abrir: { type: 'boolean', default: true, description: 'Open in the local browser' },
    },
  },
  async handler({ proyecto, refrescar = false, abrir = true }) {
    const p = cargarProyecto(proyecto);
    if (refrescar || !fotoConExplicaciones(p)) await recolectar({ proyecto });
    const foto = fotoConExplicaciones(p);
    const html = construirHtml(p, foto);
    const ruta = join(p.salida, 'tablero.html');
    mkdirSync(p.salida, { recursive: true });
    writeFileSync(ruta, html);
    if (abrir && process.platform === 'darwin') execFile('open', [ruta]);
    const explicadas = foto.prs.filter((x) => x.explicacion && !x.explicacion.desactualizada).length;
    return `Dashboard at ${ruta}: ${foto.prs.length} PRs, ${explicadas} with an up-to-date explanation. Snapshot from ${foto.generado.slice(0, 16)}.`;
  },
};
