import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leerJson, rutaExplicacion, rutaInstantanea } from './cache.mjs';
import { diffsDeFoto } from './diffs.mjs';

const PLANTILLA = join(dirname(fileURLToPath(import.meta.url)), '../tablero/plantilla.html');
const ANCLAJE = join(dirname(fileURLToPath(import.meta.url)), '../tablero/anclaje.js');
const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '../../.claude-plugin/plugin.json');

// The template is read from disk on every request while the server code stays in memory since startup: after
// a plugin update, the page can be newer than the server. The page compares both versions.
export const versionEnDisco = () => { try { return JSON.parse(readFileSync(PLUGIN, 'utf8')).version; } catch { return null; } };

// The snapshot with the explanations current at serving time (they may have been written after the snapshot).
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

// api: null for the static file; { token } when served by the local server with actions.
// p: project, to embed the saved diffs.
export const construirHtml = (p, foto, api = null) =>
  readFileSync(PLANTILLA, 'utf8')
    .replace('/*ANCLAJE*/', () => readFileSync(ANCLAJE, 'utf8'))
    .replace('/*DATOS*/null', () => incrustar(foto))
    .replace('/*API*/null', () => incrustar(api))
    .replace('/*VERSION*/null', () => JSON.stringify(versionEnDisco()))
    .replace('/*DIFFS*/null', () => incrustar(diffsDeFoto(p, foto)));
