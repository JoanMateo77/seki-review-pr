import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EJEMPLO = join(dirname(fileURLToPath(import.meta.url)), '../../config/proyectos.ejemplo.json');
const USUARIO = join(homedir(), '.config/seki-review/proyectos.json');

export const expandir = (ruta) => (ruta?.startsWith('~/') ? join(homedir(), ruta.slice(2)) : ruta);

// Order: SEKI_REVIEW_CONFIG, then ~/.config/seki-review/proyectos.json. The plugin only ships an example.
export function cargarProyectos() {
  const ruta = [process.env.SEKI_REVIEW_CONFIG, USUARIO].find((r) => r && existsSync(r));
  if (!ruta) throw new Error(`No project configuration found. Copy ${EJEMPLO} to ${USUARIO} and fill it in, or set SEKI_REVIEW_CONFIG.`);
  return { ruta, proyectos: JSON.parse(readFileSync(ruta, 'utf8')) };
}

// Without a key: SEKI_PROYECTO or the first project in the file.
export function proyecto(clave) {
  const { proyectos, ruta } = cargarProyectos();
  const elegida = clave || process.env.SEKI_PROYECTO || Object.keys(proyectos)[0];
  const p = proyectos[elegida];
  if (!p) throw new Error(`Project "${elegida}" is not in ${ruta}. Available: ${Object.keys(proyectos).join(', ')}`);
  return { clave: elegida, ...p, salida: expandir(p.salida), copias: expandir(p.copias ?? `~/.cache/seki-review/copias/${elegida}`) };
}

// Locates a base branch within the repo's deployment lines.
export function clasificarBase(cfgRepo, base) {
  for (const linea of cfgRepo.lineas) {
    if (linea.prod === base) return { ambiente: 'prod', ...linea };
    if (linea.pruebas === base) return { ambiente: 'pruebas', ...linea };
  }
  if (cfgRepo.inactivas?.[base]) return { ambiente: 'inactiva', portal: base, motivo: cfgRepo.inactivas[base] };
  return { ambiente: 'otra', portal: base };
}
