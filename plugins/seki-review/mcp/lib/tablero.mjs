import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leerJson, rutaDiff, rutaExplicacion, rutaInstantanea } from './cache.mjs';
import { sugerirUltra } from './perfiles.mjs';
import { diffsDeFoto } from './diffs.mjs';
import { datosEntregas } from './tablero-entregas.mjs';

const PARTES = join(dirname(fileURLToPath(import.meta.url)), '../tablero/partes');
const ANCLAJE = join(dirname(fileURLToPath(import.meta.url)), '../tablero/anclaje.js');
const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '../../.claude-plugin/plugin.json');

// The template is read from disk on every request while the server code stays in memory since startup: after
// a plugin update, the page can be newer than the server. The page compares both versions.
export const versionEnDisco = () => { try { return JSON.parse(readFileSync(PLUGIN, 'utf8')).version; } catch { return null; } };

// File names of a PR's cached diff, kept in memory per commit: the full diff is parsed once, not on every call.
const NOMBRES_MAX = 500;
const nombresCache = new Map();
export function nombresDeArchivos(p, pr) {
  const clave = `${p.salida}|${pr.repo}#${pr.numero}@${pr.headSha}`;
  if (nombresCache.has(clave)) return nombresCache.get(clave);
  const d = leerJson(rutaDiff(p.salida, pr.repo, pr.numero));
  if (d?.headSha !== pr.headSha || !Array.isArray(d.archivos)) return [];
  const nombres = d.archivos.map((a) => a.filename).filter(Boolean);
  nombresCache.set(clave, nombres);
  if (nombresCache.size > NOMBRES_MAX) nombresCache.delete(nombresCache.keys().next().value);
  return nombres;
}

// The snapshot with the explanations current at serving time (they may have been written after the snapshot).
export function fotoConExplicaciones(p) {
  const foto = leerJson(rutaInstantanea(p.salida));
  if (!foto) return null;
  for (const pr of foto.prs) {
    const e = leerJson(rutaExplicacion(p.salida, pr.repo, pr.numero));
    pr.explicacion = e ? { ...e, desactualizada: e.headSha !== pr.headSha } : undefined;
    pr.ultraSugerida = sugerirUltra(p, pr, p.ia?.patronesSensibles?.length ? nombresDeArchivos(p, pr) : []).sugerida;
  }
  return foto;
}

// The template lives in ordered parts (partes/orden.json); read from disk on every call, like the former single file.
export const leerPlantilla = () =>
  JSON.parse(readFileSync(join(PARTES, 'orden.json'), 'utf8'))
    .map((nombre) => readFileSync(join(PARTES, nombre), 'utf8'))
    .join('');

// Safe inside <script>: no "</script>" or "<!--" can close it, and U+2028/2029 stay escaped for older parsers.
export const incrustar = (v) => JSON.stringify(v ?? null).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

// A damaged entregas.json must not take the PR view down with it.
function entregasParaPagina(p) {
  try { return datosEntregas(p); } catch (e) {
    console.error(`[seki-review/tablero] deliveries not embedded: ${e.message}`);
    return null;
  }
}

// api: null for the static file; { token } when served by the local server with actions.
// p: project, to embed the saved diffs.
export const construirHtml = (p, foto, api = null) =>
  leerPlantilla()
    .replace('/*ANCLAJE*/', () => readFileSync(ANCLAJE, 'utf8'))
    .replace('/*DATOS*/null', () => incrustar(foto))
    .replace('/*API*/null', () => incrustar(api))
    .replace('/*VERSION*/null', () => JSON.stringify(versionEnDisco()))
    .replace('/*DIFFS*/null', () => incrustar(diffsDeFoto(p, foto)))
    .replace('/*ENTREGAS*/null', () => incrustar(entregasParaPagina(p)));
