import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIR_BASE = join(dirname(fileURLToPath(import.meta.url)), '../../plantillas');
const MAX_BYTES = 64 * 1024;
const MAX_ITEMS = 30;
const MAX_GLOBS = 40;
const MAX_GLOB = 200;
const ETIQUETAS = ['issue', 'suggestion', 'question', 'nitpick', 'todo'];

// Glob to regular expression: `**`, `*`, `?` and literals, case-sensitive, anchored on the whole path.
// `**/` also matches zero directories; braces and classes are not special.
export function globARegex(glob) {
  let fuente = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        fuente += '(?:.*/)?';
        i += 2;
      } else {
        fuente += '.*';
        i += 1;
      }
    } else if (c === '*') fuente += '[^/]*';
    else if (c === '?') fuente += '[^/]';
    else fuente += c.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
  }
  return new RegExp(`^${fuente}$`);
}

const objeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const texto = (v) => typeof v === 'string' && v.trim().length > 0;
const globs = (v) => Array.isArray(v) && v.length <= MAX_GLOBS && v.every((g) => typeof g === 'string' && g.length > 0 && g.length <= MAX_GLOB);

function motivoItem(it, i) {
  if (!objeto(it)) return `items[${i}] is not an object`;
  if (typeof it.id !== 'string' || !/^[A-Za-z0-9-]{1,40}$/.test(it.id)) return `items[${i}].id is invalid`;
  if (!texto(it.pregunta)) return `${it.id}: pregunta is required`;
  if (!texto(it.evidencia)) return `${it.id}: evidencia is required`;
  if (it.reglas !== undefined && !(Array.isArray(it.reglas) && it.reglas.every(texto))) return `${it.id}: reglas must be a list of rule ids`;
  const s = it.siFalla;
  if (!objeto(s) || !ETIQUETAS.includes(s.etiqueta)) return `${it.id}: siFalla.etiqueta must be one of ${ETIQUETAS.join(', ')}`;
  if (typeof s.bloqueante !== 'boolean') return `${it.id}: siFalla.bloqueante must be true or false`;
  if (s.tema !== undefined && !/^[a-z]{1,20}$/.test(s.tema)) return `${it.id}: siFalla.tema must be 1 to 20 lowercase letters`;
  return null;
}

// Returns the template with its optional parts completed, or the first reason it is not usable.
export function validarPlantilla(obj) {
  const no = (motivo) => ({ ok: false, motivo });
  if (!objeto(obj)) return no('the file is not a JSON object');
  if (typeof obj.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(obj.id)) return no('id must match ^[a-z0-9-]{1,40}$');
  if (!Number.isInteger(obj.version) || obj.version < 1) return no('version must be a positive integer');
  if (!texto(obj.titulo)) return no('titulo is required');
  if (obj.idioma !== undefined && !['es', 'en'].includes(obj.idioma)) return no('idioma must be "es" or "en"');
  if (obj.siempre !== undefined && typeof obj.siempre !== 'boolean') return no('siempre must be true or false');
  for (const k of ['aplicaA', 'excluir']) if (obj[k] !== undefined && !globs(obj[k])) return no(`${k} must hold at most ${MAX_GLOBS} globs of up to ${MAX_GLOB} characters`);
  if (!Array.isArray(obj.items) || obj.items.length < 1 || obj.items.length > MAX_ITEMS) return no(`items must have 1 to ${MAX_ITEMS} entries`);
  for (const [i, it] of obj.items.entries()) {
    const m = motivoItem(it, i);
    if (m) return no(m);
  }
  if (new Set(obj.items.map((it) => it.id)).size !== obj.items.length) return no('item ids must be unique');
  const items = obj.items.map((it) => ({ id: it.id, pregunta: it.pregunta, evidencia: it.evidencia, reglas: it.reglas ?? [], siFalla: { etiqueta: it.siFalla.etiqueta, bloqueante: it.siFalla.bloqueante, ...(it.siFalla.tema ? { tema: it.siFalla.tema } : {}) } }));
  return { ok: true, plantilla: { id: obj.id, version: obj.version, titulo: obj.titulo, idioma: obj.idioma ?? 'en', siempre: obj.siempre ?? false, aplicaA: obj.aplicaA ?? [], excluir: obj.excluir ?? [], items } };
}

// A configured project folder that does not exist is reported, so a typo in `plantillas` is not silently ignored.
function leerDir(dir, { propia = false } = {}) {
  const plantillas = [];
  const invalidas = [];
  const invalida = (archivo, motivo) => {
    invalidas.push({ archivo, motivo });
    console.error(`[seki-review/plantillas] ${archivo} is skipped: ${motivo}`);
  };
  if (!dir) return { plantillas, invalidas };
  if (!existsSync(dir)) {
    if (propia) invalida(dir, 'the project template folder does not exist');
    return { plantillas, invalidas };
  }
  let nombres = [];
  try {
    nombres = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch (e) {
    invalida(dir, `the folder cannot be read (${e.message})`);
  }
  for (const nombre of nombres) {
    try {
      const ruta = join(dir, nombre);
      if (statSync(ruta).size > MAX_BYTES) {
        invalida(nombre, 'the file is larger than 64 KB');
        continue;
      }
      const r = validarPlantilla(JSON.parse(readFileSync(ruta, 'utf8')));
      if (r.ok) plantillas.push(r.plantilla);
      else invalida(nombre, r.motivo);
    } catch (e) {
      invalida(nombre, e instanceof SyntaxError ? `invalid JSON (${e.message})` : e.message);
    }
  }
  return { plantillas, invalidas };
}

// Base templates plus the project's (p.plantillas); the project's replace the base ones by id.
// Order: `siempre` first, then by id.
export function cargarPlantillas(p, { dirBase = DIR_BASE } = {}) {
  const base = leerDir(dirBase);
  const propias = leerDir(typeof p?.plantillas === 'string' ? p.plantillas : null, { propia: true });
  const porId = new Map([...base.plantillas, ...propias.plantillas].map((t) => [t.id, t]));
  const plantillas = [...porId.values()].sort((a, b) => Number(b.siempre) - Number(a.siempre) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { plantillas, invalidas: [...base.invalidas, ...propias.invalidas] };
}

// Which templates apply to the changed paths; no AI involved.
export function seleccionarPlantillas(plantillas, rutas) {
  const activas = [];
  const omitidas = [];
  const cubiertas = new Set();
  for (const t of plantillas) {
    const incluir = t.aplicaA.map((glob) => ({ glob, re: globARegex(glob) }));
    const excluir = t.excluir.map(globARegex);
    let motivo = null;
    for (const ruta of rutas) {
      const hit = incluir.find((g) => g.re.test(ruta));
      if (!hit || excluir.some((re) => re.test(ruta))) continue;
      if (!t.siempre) cubiertas.add(ruta);
      motivo ??= { archivo: ruta, glob: hit.glob };
    }
    if (t.siempre) activas.push({ id: t.id, version: t.version, titulo: t.titulo, motivo: 'siempre' });
    else if (motivo) activas.push({ id: t.id, version: t.version, titulo: t.titulo, motivo });
    else omitidas.push({ id: t.id, titulo: t.titulo });
  }
  return { activas, omitidas, sinPlantilla: rutas.filter((r) => !cubiertas.has(r)) };
}

export const itemsIa = (t) => t.items.filter((i) => i.reglas.length === 0);
export const itemsDeterministas = (t) => t.items.filter((i) => i.reglas.length > 0);
