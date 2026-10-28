import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EJEMPLO = join(dirname(fileURLToPath(import.meta.url)), '../../config/proyectos.ejemplo.json');
const USUARIO = join(homedir(), '.config/seki-review/proyectos.json');

export const expandir = (ruta) => (ruta?.startsWith('~/') ? join(homedir(), ruta.slice(2)) : ruta);

// Orden: SEKI_REVIEW_CONFIG y luego ~/.config/seki-review/proyectos.json. El plugin solo trae un ejemplo.
export function cargarProyectos() {
  const ruta = [process.env.SEKI_REVIEW_CONFIG, USUARIO].find((r) => r && existsSync(r));
  if (!ruta) throw new Error(`No hay configuración de proyectos. Copiar ${EJEMPLO} a ${USUARIO} y completarla, o definir SEKI_REVIEW_CONFIG.`);
  return { ruta, proyectos: JSON.parse(readFileSync(ruta, 'utf8')) };
}

// Sin clave: SEKI_PROYECTO o el primer proyecto del archivo.
export function proyecto(clave) {
  const { proyectos, ruta } = cargarProyectos();
  const elegida = clave || process.env.SEKI_PROYECTO || Object.keys(proyectos)[0];
  const p = proyectos[elegida];
  if (!p) throw new Error(`Proyecto "${elegida}" no está en ${ruta}. Disponibles: ${Object.keys(proyectos).join(', ')}`);
  return { clave: elegida, ...p, salida: expandir(p.salida), copias: expandir(p.copias ?? `~/.cache/seki-review/copias/${elegida}`) };
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
