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

export const ENTREGAS_DEFECTO = { sufijosRama: ['-pruebas', '-testing', '-staging'], patronId: null, ventanaDias: 30, alertaDias: 5, cerrarTrasDias: 7 };
export const VIGIA_DEFECTO = { intervaloSeg: 300 };
export const VIGIA_INTERVALO_MIN = 120;

// Defaults under the user's values, merged one level deep.
function conDefectos(defecto, usuario) {
  return { ...defecto, ...(usuario && typeof usuario === 'object' && !Array.isArray(usuario) ? usuario : {}) };
}

// Without a key: SEKI_PROYECTO or the first project in the file.
export function proyecto(clave) {
  const { proyectos, ruta } = cargarProyectos();
  const elegida = clave || process.env.SEKI_PROYECTO || Object.keys(proyectos)[0];
  const p = proyectos[elegida];
  if (!p) throw new Error(`Project "${elegida}" is not in ${ruta}. Available: ${Object.keys(proyectos).join(', ')}`);
  const vigia = conDefectos(VIGIA_DEFECTO, p.vigia);
  vigia.intervaloSeg = Number.isFinite(vigia.intervaloSeg) ? Math.max(VIGIA_INTERVALO_MIN, vigia.intervaloSeg) : VIGIA_DEFECTO.intervaloSeg;
  return { clave: elegida, ...p, entregas: conDefectos(ENTREGAS_DEFECTO, p.entregas), vigia, salida: expandir(p.salida), copias: expandir(p.copias ?? `~/.cache/seki-review/copias/${elegida}`) };
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
