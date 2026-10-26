import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proyecto as cargarProyecto } from '../lib/config.mjs';
import { leerJson, rutaExplicacion, rutaInstantanea } from '../lib/cache.mjs';
import { recolectar } from '../lib/recolectar.mjs';

const PLANTILLA = join(dirname(fileURLToPath(import.meta.url)), '../tablero/plantilla.html');

export default {
  name: 'tablero_generar',
  description:
    'Genera el tablero HTML local de revisión de PRs (archivo, sin publicar en ningún servicio) con filtros por portal, acción y riesgo, ' +
    'y el detalle de cada PR con su explicación. Usa la última foto de prs_pendientes salvo refrescar=true.',
  inputSchema: {
    type: 'object',
    properties: {
      proyecto: { type: 'string', default: 'demo' },
      refrescar: { type: 'boolean', default: false, description: 'Volver a consultar GitHub antes de generar' },
      abrir: { type: 'boolean', default: true, description: 'Abrir en el navegador local' },
    },
  },
  async handler({ proyecto, refrescar = false, abrir = true }) {
    const p = cargarProyecto(proyecto);
    let foto = refrescar ? null : leerJson(rutaInstantanea(p.salida));
    if (!foto) foto = await recolectar({ proyecto });
    for (const pr of foto.prs) {
      const e = leerJson(rutaExplicacion(p.salida, pr.repo, pr.numero));
      if (e) pr.explicacion = { ...e, desactualizada: e.headSha !== pr.headSha };
    }
    const datos = JSON.stringify(foto).replace(/</g, '\\u003c');
    const html = readFileSync(PLANTILLA, 'utf8').replace('/*DATOS*/null', datos);
    const ruta = join(p.salida, 'tablero.html');
    mkdirSync(p.salida, { recursive: true });
    writeFileSync(ruta, html);
    if (abrir && process.platform === 'darwin') execFile('open', [ruta]);
    const explicadas = foto.prs.filter((x) => x.explicacion && !x.explicacion.desactualizada).length;
    return `Tablero en ${ruta}: ${foto.prs.length} PRs, ${explicadas} con explicación vigente. Foto del ${foto.generado.slice(0, 16)}.`;
  },
};
