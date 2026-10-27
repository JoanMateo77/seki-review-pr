import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const leerJson = (ruta, porDefecto = null) => (existsSync(ruta) ? JSON.parse(readFileSync(ruta, 'utf8')) : porDefecto);

export function escribirJson(ruta, datos) {
  mkdirSync(join(ruta, '..'), { recursive: true });
  writeFileSync(ruta, JSON.stringify(datos, null, 2) + '\n');
}

export const rutaExplicacion = (salida, repo, numero) => join(salida, 'explicaciones', `${repo}-${numero}.json`);
export const rutaInstantanea = (salida) => join(salida, 'datos', 'prs.json');
export const rutaCacheEstados = (salida) => join(salida, 'datos', 'estados-cache.json');
export const rutaVerificacion = (salida, repo, numero) => join(salida, 'verificaciones', `${repo}-${numero}.json`);
export const rutaCacheVerificaciones = (salida) => join(salida, 'datos', 'verificaciones-cache.json');
export const rutaDiff = (salida, repo, numero) => join(salida, 'diffs', `${repo}-${numero}.json`);
export const rutaComentarios = (salida, repo, numero) => join(salida, 'comentarios', `${repo}-${numero}.json`);
