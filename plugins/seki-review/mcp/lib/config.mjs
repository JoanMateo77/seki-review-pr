import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilarPatron } from './patrones.mjs';
import { MODOS } from './perfiles.mjs';

const EJEMPLO = join(dirname(fileURLToPath(import.meta.url)), '../../config/proyectos.ejemplo.json');
const USUARIO = join(homedir(), '.config/seki-review/proyectos.json');

export const expandir = (ruta) => (ruta?.startsWith('~/') ? join(homedir(), ruta.slice(2)) : ruta);

// Order: SEKI_REVIEW_CONFIG, then ~/.config/seki-review/proyectos.json. The plugin only ships an example.
export function cargarProyectos() {
  const ruta = [process.env.SEKI_REVIEW_CONFIG, USUARIO].find((r) => r && existsSync(r));
  if (!ruta) throw new Error(`No project configuration found. Copy ${EJEMPLO} to ${USUARIO} and fill it in, or set SEKI_REVIEW_CONFIG.`);
  return { ruta, proyectos: JSON.parse(readFileSync(ruta, 'utf8')) };
}

export const ENTREGAS_DEFECTO = { sufijosRama: ['-pruebas', '-testing', '-staging'], patronId: null, ventanaDias: 30, alertaDias: 5, cerrarTrasDias: 7, maxPorSenal: 12 };
export const IA_DEFECTO = { modo: 'normal', presupuestoDiarioUsd: null, rutasSensibles: [] };
export const VIGIA_DEFECTO = { intervaloSeg: 300 };
export const VIGIA_INTERVALO_MIN = 120;

export const QA_DEFECTO = {
  columnas: ['ID', 'Portal', 'Screen and access', 'Preconditions and data', 'Steps', 'Expected result', 'Priority', 'Result', 'QA notes', 'Evidence', 'Date', 'Tester'],
  resultados: ['OK', 'Fail', 'Blocked', 'Pending', 'N/A'],
  mapeo: { OK: 'ok', Fail: 'fallo', Blocked: 'bloqueado', Pending: null, 'N/A': 'na' },
  chrome: null,
  rastreador: null,
};

const textos = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const positivo = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const VALIDOS = {
  sufijosRama: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  patronId: (v) => v === null || typeof v === 'string',
  ventanaDias: positivo,
  alertaDias: positivo,
  cerrarTrasDias: positivo,
  maxPorSenal: positivo,
  intervaloSeg: positivo,
  columnas: (v) => textos(v) && ['ID', 'Portal', 'Result'].every((c) => v.includes(c)) && new Set(v).size === v.length,
  resultados: textos,
  mapeo: (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => x === null || ['ok', 'fallo', 'bloqueado', 'na'].includes(x)),
  chrome: (v) => v === null || typeof v === 'string',
  modo: (v) => MODOS.includes(v),
  presupuestoDiarioUsd: (v) => v === null || positivo(v),
  rutasSensibles: textos,
};

const MAX_RUTA_SENSIBLE = 200;

// Valid sensitive-path patterns as strings plus their compiled form; an invalid one is dropped with a warning.
function rutasSensibles(lista) {
  const validas = [];
  const patrones = [];
  for (const t of lista) {
    try {
      if (t.length > MAX_RUTA_SENSIBLE) throw new Error('too long');
      patrones.push(compilarPatron(t));
      validas.push(t);
    } catch {
      avisar(`ia.rutasSensibles has an invalid pattern (it must be a regular expression of at most ${MAX_RUTA_SENSIBLE} characters without nested quantifiers); it is ignored`);
    }
  }
  return { validas, patrones };
}

const RASTREADOR_LECTURA = ['hallazgo', 'pasos', 'esperado', 'pantalla', 'prioridad'];
const RASTREADOR_COLUMNAS = ['estado', 'prPruebas', 'prProd', 'enPruebas', 'enProd'];
const objeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cadena = (v) => typeof v === 'string' && v.length > 0;

// Null when the tracker section is not usable; otherwise the section with its optional parts completed.
function validarRastreador(r) {
  if (r === null || r === undefined) return null;
  if (!objeto(r) || r.tipo !== 'xlsx' || !cadena(r.ruta) || !cadena(r.hoja) || !cadena(r.columnaId)) {
    avisar('qa.rastreador is invalid (it needs tipo "xlsx" and text values for ruta, hoja and columnaId); it is ignored');
    return null;
  }
  const claves = (valor, nombres, nombre) => {
    const base = Object.fromEntries(nombres.map((k) => [k, null]));
    if (valor === undefined) return base;
    if (!objeto(valor) || !Object.values(valor).every((x) => x === null || typeof x === 'string')) {
      avisar(`qa.rastreador.${nombre} has an invalid value; no column is used`);
      return base;
    }
    for (const k of nombres) if (typeof valor[k] === 'string') base[k] = valor[k];
    return base;
  };
  let estados = {};
  if (r.estados !== undefined) {
    if (objeto(r.estados) && Object.values(r.estados).every((x) => typeof x === 'string')) estados = { ...r.estados };
    else avisar('qa.rastreador.estados has an invalid value; no state text is used');
  }
  const fila = Number.isInteger(r.filaEncabezado) && r.filaEncabezado >= 1 ? r.filaEncabezado : 1;
  if (r.filaEncabezado !== undefined && fila !== r.filaEncabezado) avisar('qa.rastreador.filaEncabezado has an invalid value; 1 is used');
  const ruta = expandir(r.ruta);
  if (!isAbsolute(ruta)) {
    avisar('qa.rastreador.ruta must be an absolute path (or start with ~/); the tracker is ignored');
    return null;
  }
  return {
    tipo: 'xlsx',
    ruta,
    hoja: r.hoja,
    filaEncabezado: fila,
    columnaId: r.columnaId,
    lectura: claves(r.lectura, RASTREADOR_LECTURA, 'lectura'),
    columnas: claves(r.columnas, RASTREADOR_COLUMNAS, 'columnas'),
    estados,
    escribir: typeof r.escribir === 'boolean' ? r.escribir : true,
  };
}

const MAX_LISTA_VALIDACION = 255;

// The Result list feeds the cell validation (comma separated, 255 characters at most) and the import maps each
// text through `mapeo`: an inconsistent pair would only fail after QA has filled the guide.
function resultadosCoherentes(qa) {
  const claves = new Set(Object.keys(qa.mapeo).map((k) => k.trim().toLowerCase()));
  if (qa.resultados.some((t) => t.trim() === '' || /[,"]/.test(t))) return 'a result text is empty or contains a comma or a quote';
  if (new Set(qa.resultados.map((t) => t.trim().toLowerCase())).size !== qa.resultados.length) return 'a result text is repeated';
  if (qa.resultados.some((t) => !claves.has(t.trim().toLowerCase()))) return 'a result text has no entry in qa.mapeo';
  if (qa.resultados.join(',').length > MAX_LISTA_VALIDACION) return `the result list is longer than ${MAX_LISTA_VALIDACION} characters`;
  return null;
}

// proyecto() runs on every tool call: each bad key is reported once per process.
const avisados = new Set();
function avisar(mensaje) {
  if (avisados.has(mensaje)) return;
  avisados.add(mensaje);
  console.error(`[seki-review/config] ${mensaje}`);
}

// Defaults under the user's values, merged one level deep; a value of the wrong type falls back to its default.
function conDefectos(defecto, usuario, seccion) {
  const salida = { ...structuredClone(defecto), ...(usuario && typeof usuario === 'object' && !Array.isArray(usuario) ? usuario : {}) };
  for (const k of Object.keys(defecto)) {
    if (VALIDOS[k] && !VALIDOS[k](salida[k])) {
      avisar(`${seccion}.${k} has an invalid value; the default ${JSON.stringify(defecto[k])} is used`);
      salida[k] = structuredClone(defecto[k]);
    }
  }
  return salida;
}

// Without a key: SEKI_PROYECTO or the first project in the file.
export function proyecto(clave) {
  const { proyectos, ruta } = cargarProyectos();
  const elegida = clave || process.env.SEKI_PROYECTO || Object.keys(proyectos)[0];
  const p = proyectos[elegida];
  if (!p) throw new Error(`Project "${elegida}" is not in ${ruta}. Available: ${Object.keys(proyectos).join(', ')}`);
  const vigia = conDefectos(VIGIA_DEFECTO, p.vigia, 'vigia');
  vigia.intervaloSeg = Math.max(VIGIA_INTERVALO_MIN, vigia.intervaloSeg);
  const qa = conDefectos(QA_DEFECTO, p.qa, 'qa');
  const incoherencia = resultadosCoherentes(qa);
  if (incoherencia) {
    avisar(`qa.resultados and qa.mapeo of project "${elegida}" are inconsistent (${incoherencia}); both defaults are used`);
    qa.resultados = structuredClone(QA_DEFECTO.resultados);
    qa.mapeo = structuredClone(QA_DEFECTO.mapeo);
  }
  qa.rastreador = validarRastreador(p.qa?.rastreador);
  const ia = conDefectos(IA_DEFECTO, p.ia, 'ia');
  const sensibles = rutasSensibles(ia.rutasSensibles);
  ia.rutasSensibles = sensibles.validas;
  ia.patronesSensibles = sensibles.patrones;
  let plantillas;
  if (typeof p.plantillas === 'string' && p.plantillas) plantillas = expandir(p.plantillas);
  else if (p.plantillas !== undefined) avisar(`plantillas of project "${elegida}" must be a folder path (or start with ~/); it is ignored`);
  return { clave: elegida, ...p, qa, ia, plantillas, entregas: conDefectos(ENTREGAS_DEFECTO, p.entregas, 'entregas'), vigia, salida: expandir(p.salida), copias: expandir(p.copias ?? `~/.cache/seki-review/copias/${elegida}`) };
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
