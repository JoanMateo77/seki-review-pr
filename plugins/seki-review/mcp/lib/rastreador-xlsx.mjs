// Tracker spreadsheet adapter: reads finding content for the QA guide and writes the delivery progress back.
// Columns are located by header text (trimmed, case-insensitive), never by letter. Writes touch only the cells that differ.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { conBloqueo } from './bloqueo.mjs';
import { dirRespaldos, rutaGuias } from './cache.mjs';
import { RANGO_ETAPA } from './etapas.mjs';
import { columnaLetra, leerXlsx } from './xlsx.mjs';
import { editarCeldas } from './xlsx-editar.mjs';

const MAX_ARCHIVO = 5 * 1024 * 1024;
const MAX_RESPALDOS = 20;
const LECTURA = ['hallazgo', 'pasos', 'esperado', 'pantalla', 'prioridad'];
const ESCRITURA = ['estado', 'prPruebas', 'prProd', 'enPruebas', 'enProd'];

const fallar = (codigo, mensaje) => {
  throw Object.assign(new Error(`[seki-review/rastreador] ${mensaje}`), { codigo });
};
const norm = (s) => String(s ?? '').trim().toLowerCase();
const pad = (n) => String(n).padStart(2, '0');
export const fechaLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const lineas = (v) => String(v ?? '').replace(/\r\n?/g, '\n').trim();

// A date cell stored as an Excel serial (1900 system, UTC day) equals the same YYYY-MM-DD text: no rewrite.
function serialAFecha(v) {
  if (!/^\d{1,6}(\.\d+)?$/.test(v) || Number(v) < 61) return null;
  return new Date(Math.floor(Number(v) - 25569) * 86400000).toISOString().slice(0, 10);
}
const igual = (a, b) => {
  const x = lineas(a);
  const y = lineas(b);
  return x === y || (/^\d{4}-\d{2}-\d{2}$/.test(y) && serialAFecha(x) === y);
};

function leerBuffer(ruta) {
  let fd;
  try {
    fd = openSync(ruta, 'r');
  } catch {
    fallar('RASTREADOR_ARCHIVO', 'The tracker file cannot be opened');
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) fallar('RASTREADOR_ARCHIVO', 'The tracker path is not a regular file');
    if (st.size > MAX_ARCHIVO) fallar('RASTREADOR_ARCHIVO', 'The tracker file exceeds 5 MB');
    const b = Buffer.alloc(st.size);
    let n = 0;
    for (let k; n < b.length && (k = readSync(fd, b, n, b.length - n, n)) > 0;) n += k;
    return { buf: b.subarray(0, n), st };
  } finally {
    closeSync(fd);
  }
}

function analizar(cfg, buf) {
  const libro = leerXlsx(buf);
  const hoja = libro.hojas.find((h) => h.nombre === cfg.hoja);
  if (!hoja) fallar('RASTREADOR_HOJA', 'The configured sheet was not found in the tracker');
  const filaEnc = hoja.filas[cfg.filaEncabezado - 1] ?? [];
  const encabezados = new Map();
  filaEnc.forEach((t, i) => {
    const k = norm(t);
    if (k !== '' && !encabezados.has(k)) encabezados.set(k, i);
  });
  const pares = [...LECTURA.map((k) => [k, cfg.lectura?.[k]]), ...ESCRITURA.map((k) => [k, cfg.columnas?.[k]])];
  const textos = { id: cfg.columnaId, ...Object.fromEntries(pares.filter(([, v]) => typeof v === 'string' && v !== '')) };
  const indices = {};
  for (const [clave, texto] of Object.entries(textos)) {
    const i = encabezados.get(norm(texto));
    if (i === undefined) fallar('RASTREADOR_COLUMNA', `Column header not found in the tracker: "${texto}"`);
    indices[clave] = i;
  }
  // The first row with an ID is the main one (reads); `todas` lists every row with that ID (writes).
  const filasPorId = new Map();
  for (let r = cfg.filaEncabezado; r < hoja.filas.length; r++) {
    const celdas = hoja.filas[r] ?? [];
    const id = String(celdas[indices.id] ?? '').trim();
    if (id === '') continue;
    const valores = {};
    for (const [clave, i] of Object.entries(indices)) if (clave !== 'id') valores[clave] = String(celdas[i] ?? '');
    const previa = filasPorId.get(id);
    if (previa) previa.todas.push({ fila: r + 1, valores });
    else filasPorId.set(id, { fila: r + 1, valores, todas: [{ fila: r + 1, valores }] });
  }
  return { filasPorId, encabezados, indices };
}

export function leerRastreador(cfg) {
  const { filasPorId, encabezados } = analizar(cfg, leerBuffer(cfg.ruta).buf);
  return { filasPorId, encabezados };
}

export function contenidoRastreador(cfg) {
  const { filasPorId } = leerRastreador(cfg);
  const mapa = new Map();
  for (const [id, f] of filasPorId) mapa.set(id, Object.fromEntries(LECTURA.map((k) => [k, f.valores[k] ?? ''])));
  return mapa;
}

const fusion = (prs) => prs.map((p) => p?.mergeada).filter(Boolean).sort().at(-1) ?? '';

// The most advanced delivery wins per finding ID; a tie goes to the most recent merge.
function entregaDe(entregas, prsPorId) {
  const mejor = new Map();
  for (const e of entregas) {
    const rango = RANGO_ETAPA[e.etapa] ?? -1;
    const merge = fusion((e.prs ?? []).map((id) => prsPorId.get(id)));
    for (const id of new Set(e.ids ?? [])) {
      const a = mejor.get(id);
      if (!a || rango > a.rango || (rango === a.rango && merge > a.merge)) mejor.set(id, { entrega: e, rango, merge });
    }
  }
  return mejor;
}

function deseados(cfg, entrega, prsPorId) {
  const prs = (entrega.prs ?? []).map((id) => prsPorId.get(id)).filter(Boolean);
  const urls = (amb) => [...new Set(prs.filter((p) => p.ambiente === amb && p.url).map((p) => p.url))].join('\n');
  const fecha = (amb) => {
    const m = fusion(prs.filter((p) => p.ambiente === amb));
    return m ? fechaLocal(new Date(m)) : '';
  };
  const estado = cfg.estados?.[entrega.etapa];
  return {
    estado: typeof estado === 'string' ? estado : '',
    prPruebas: urls('pruebas'),
    prProd: urls('prod'),
    enPruebas: fecha('pruebas'),
    enProd: fecha('prod'),
  };
}

function calcular(cfg, entregas, prsPorId, analisis) {
  const cambios = [];
  for (const [id, { entrega }] of entregaDe(entregas, prsPorId)) {
    const fila = analisis.filasPorId.get(id);
    if (!fila) continue;
    const nuevos = deseados(cfg, entrega, prsPorId);
    for (const columna of ESCRITURA) {
      if (!cfg.columnas?.[columna] || nuevos[columna] === '') continue;
      for (const f of fila.todas) {
        const actual = f.valores[columna] ?? '';
        if (igual(actual, nuevos[columna])) continue;
        cambios.push({ id, ref: `${columnaLetra(analisis.indices[columna])}${f.fila}`, columna, actual, nuevo: nuevos[columna] });
      }
    }
  }
  return cambios;
}

export function cambiosPendientes(cfg, entregas, prsPorId) {
  return calcular(cfg, entregas, prsPorId, analizar(cfg, leerBuffer(cfg.ruta).buf));
}

const rechazo = (motivo) => ({ escrito: false, celdas: 0, motivo });
const sello = (d) => `${fechaLocal(d).replaceAll('-', '')}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const quitar = (ruta) => {
  if (!ruta) return;
  try {
    unlinkSync(ruta);
  } catch { /* already gone */ }
};

function respaldar(p, ruta, buf, ahora) {
  const dir = dirRespaldos(p.salida);
  mkdirSync(dir, { recursive: true });
  const base = basename(ruta, extname(ruta));
  for (let n = 1; ; n++) {
    const destino = join(dir, `${base}-${sello(ahora)}${n > 1 ? `-${n}` : ''}.xlsx`);
    try {
      writeFileSync(destino, buf, { flag: 'wx' });
      return destino;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

// Keeps the newest MAX_RESPALDOS backups of this tracker.
function podar(p, ruta) {
  const dir = dirRespaldos(p.salida);
  const base = basename(ruta, extname(ruta)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${base}-\\d{8}-\\d{6}(-\\d+)?\\.xlsx$`);
  try {
    const lista = readdirSync(dir).filter((f) => re.test(f)).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => a.t - b.t || (a.f < b.f ? -1 : 1));
    for (const { f } of lista.slice(0, Math.max(0, lista.length - MAX_RESPALDOS))) quitar(join(dir, f));
  } catch { /* pruning is best effort */ }
}

function escribirTemporal(ruta, datos, modo) {
  const tmp = join(dirname(ruta), `.${basename(ruta)}.${randomBytes(6).toString('hex')}.seki.tmp`);
  const fd = openSync(tmp, 'wx', modo);
  try {
    let n = 0;
    while (n < datos.length) n += writeSync(fd, datos, n, datos.length - n);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    quitar(tmp);
    throw e;
  }
  closeSync(fd);
  try { chmodSync(tmp, modo); } catch { /* best effort */ }
  return tmp;
}

// `gancho` is a test seam: it runs after the temporary file is written and before the final recheck.
export async function aplicarRastreador(p, entregas, prsPorId, { ahora = new Date(), gancho } = {}) {
  const cfg = p.qa?.rastreador;
  if (!cfg) return rechazo('No tracker configured');
  if (cfg.escribir === false) return rechazo('Tracker writes are disabled in the configuration');
  const ruta = cfg.ruta;
  const impedimento = () => {
    let st;
    try {
      st = lstatSync(ruta);
    } catch {
      return 'The tracker file does not exist';
    }
    if (st.isSymbolicLink()) return 'The tracker path is a symbolic link';
    if (!st.isFile()) return 'The tracker path is not a regular file';
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return 'The spreadsheet belongs to another user';
    if (existsSync(join(dirname(ruta), `~$${basename(ruta)}`))) return 'The tracker is open in another program: close it and import again';
    return null;
  };
  const previo = impedimento();
  if (previo) return rechazo(previo);

  // The lock lives under salida/datos (not beside the tracker, which may be a synced folder), keyed by the tracker path.
  const rutaLock = join(dirname(rutaGuias(p.salida)), `rastreador-${sha(resolve(ruta)).slice(0, 16)}`);
  let tmp = null;
  let respaldo = null;
  let renombrado = false;
  try {
    return await conBloqueo(rutaLock, async () => {
      const otro = impedimento();
      if (otro) return rechazo(otro);
      const { buf, st } = leerBuffer(ruta);
      const cambios = calcular(cfg, entregas, prsPorId, analizar(cfg, buf));
      if (cambios.length === 0) return rechazo('Nothing to update');
      let editado;
      try {
        editado = editarCeldas(buf, { hoja: cfg.hoja, celdas: cambios.map((c) => ({ ref: c.ref, valor: c.nuevo })), filaEncabezado: cfg.filaEncabezado });
      } catch (e) {
        if (e?.codigo === 'XLSX_FORMULA') return rechazo('A cell to update contains a formula: the tracker was not changed');
        if (e?.codigo === 'XLSX_TABLA') return rechazo('A cell to update is in a table header or outside a table range: the tracker was not changed');
        throw e;
      }
      // rename replaces the inode: hard links and extended attributes of the original are not preserved.
      tmp = escribirTemporal(ruta, editado, st.mode & 0o7777);
      if (gancho) await gancho();
      const cambio = impedimento() ?? (() => {
        const ahoraSt = statSync(ruta);
        if (ahoraSt.mtimeMs !== st.mtimeMs || ahoraSt.size !== st.size || ahoraSt.ino !== st.ino) return 'changed';
        return sha(readFileSync(ruta)) === sha(buf) ? null : 'changed';
      })();
      if (cambio) {
        quitar(tmp);
        tmp = null;
        return rechazo(cambio === 'changed' ? 'The tracker changed while it was being updated: import again' : cambio);
      }
      respaldo = respaldar(p, ruta, buf, ahora);
      renameSync(tmp, ruta);
      renombrado = true;
      tmp = null;
      podar(p, ruta);
      return { escrito: true, celdas: cambios.length, respaldo };
    });
  } catch (e) {
    quitar(tmp);
    if (!renombrado) quitar(respaldo);
    if (typeof e?.codigo === 'string' && /^(RASTREADOR|XLSX)_/.test(e.codigo)) return rechazo(e.message.replace(/^\[seki-review\/[a-z]+\]\s*/, ''));
    console.error(`[seki-review/rastreador] The tracker could not be updated (${e?.code ?? e?.codigo ?? 'error'})`);
    return rechazo('The tracker could not be updated');
  }
}
