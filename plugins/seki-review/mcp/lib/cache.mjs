import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { conBloqueoSync, escribirAtomico } from './bloqueo.mjs';

export const leerJson = (ruta, porDefecto = null) => (existsSync(ruta) ? JSON.parse(readFileSync(ruta, 'utf8')) : porDefecto);

export function escribirJson(ruta, datos) {
  conBloqueoSync(ruta, () => escribirAtomico(ruta, JSON.stringify(datos, null, 2) + '\n'));
}

export const rutaExplicacion = (salida, repo, numero) => join(salida, 'explicaciones', `${repo}-${numero}.json`);
export const rutaInstantanea = (salida) => join(salida, 'datos', 'prs.json');
export const rutaCacheEstados = (salida) => join(salida, 'datos', 'estados-cache.json');
export const rutaVerificacion = (salida, repo, numero) => join(salida, 'verificaciones', `${repo}-${numero}.json`);
export const rutaCacheVerificaciones = (salida) => join(salida, 'datos', 'verificaciones-cache.json');
export const rutaDiff = (salida, repo, numero) => join(salida, 'diffs', `${repo}-${numero}.json`);
export const rutaComentarios = (salida, repo, numero) => join(salida, 'comentarios', `${repo}-${numero}.json`);
export const rutaCostos = (salida) => join(salida, 'datos', 'costos.jsonl');
export const rutaRespuesta = (salida, clave) => join(salida, 'respuestas', `${clave}.json`);
// p.copias (configuration) keeps the copies outside the project folder so they do not inherit its CLAUDE.md.
export const rutaCopia = (p, repo, numero, sufijo = '') => join(p.copias ?? join(p.salida, 'copias'), `${repo}-${numero}${sufijo}`);
export const rutaBaseline = (salida, repo, sha) => join(salida, 'datos', 'baseline', `${repo}-${sha}.json`);
export const rutaPropuestas = (salida, repo, numero) => join(salida, 'propuestas', `${repo}-${numero}`);
export const rutaEventos = (salida) => join(salida, 'datos', 'eventos.jsonl');
export const rutaEntregas = (salida) => join(salida, 'datos', 'entregas.json');
export const rutaAjustes = (salida) => join(salida, 'datos', 'ajustes.json');
export const rutaVisita = (salida) => join(salida, 'datos', 'visita.json');
