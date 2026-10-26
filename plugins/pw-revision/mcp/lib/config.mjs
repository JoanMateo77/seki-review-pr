import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREDETERMINADA = join(dirname(fileURLToPath(import.meta.url)), '../../config/proyectos.json');
const USUARIO = join(homedir(), '.config/pw-revision/proyectos.json');

export const expandir = (ruta) => (ruta?.startsWith('~/') ? join(homedir(), ruta.slice(2)) : ruta);

// Orden: PW_REVISION_CONFIG, luego ~/.config/pw-revision, luego la que trae el plugin.
export function cargarProyectos() {
  const ruta = [process.env.PW_REVISION_CONFIG, USUARIO, PREDETERMINADA].find((r) => r && existsSync(r));
  return { ruta, proyectos: JSON.parse(readFileSync(ruta, 'utf8')) };
}

export function proyecto(clave = 'demo') {
  const { proyectos, ruta } = cargarProyectos();
  const p = proyectos[clave];
  if (!p) throw new Error(`Proyecto "${clave}" no está en ${ruta}. Disponibles: ${Object.keys(proyectos).join(', ')}`);
  return { clave, ...p, salida: expandir(p.salida) };
}

// Ubica una rama base dentro de las líneas de despliegue del repo.
export function clasificarBase(cfgRepo, base) {
  for (const linea of cfgRepo.lineas) {
    if (linea.prod === base) return { ambiente: 'prod', ...linea };
    if (linea.pruebas === base) return { ambiente: 'pruebas', ...linea };
  }
  if (cfgRepo.inactivas?.[base]) return { ambiente: 'inactiva', portal: base, motivo: cfgRepo.inactivas[base] };
  return { ambiente: 'otra', portal: base };
}
