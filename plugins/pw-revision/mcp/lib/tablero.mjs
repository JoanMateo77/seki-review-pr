import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leerJson, rutaExplicacion, rutaInstantanea } from './cache.mjs';

const PLANTILLA = join(dirname(fileURLToPath(import.meta.url)), '../tablero/plantilla.html');

// La foto con las explicaciones vigentes al momento de servirla (pueden haberse escrito después de la foto).
export function fotoConExplicaciones(p) {
  const foto = leerJson(rutaInstantanea(p.salida));
  if (!foto) return null;
  for (const pr of foto.prs) {
    const e = leerJson(rutaExplicacion(p.salida, pr.repo, pr.numero));
    pr.explicacion = e ? { ...e, desactualizada: e.headSha !== pr.headSha } : undefined;
  }
  return foto;
}

const incrustar = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

// api: null para el archivo estático; { token } cuando lo sirve el servidor local con acciones.
export const construirHtml = (foto, api = null) =>
  readFileSync(PLANTILLA, 'utf8').replace('/*DATOS*/null', incrustar(foto)).replace('/*API*/null', incrustar(api));
