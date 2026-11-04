// Content and cuts of the QA guide. Pure except registrarGuia/leerGuias (guias.json).
import { createHmac } from 'node:crypto';
import { QA_DEFECTO } from './config.mjs';
import { conBloqueo, escribirAtomico } from './bloqueo.mjs';
import { leerJson, rutaGuias } from './cache.mjs';

const RAMAS = 'feat|feature|fix|bugfix|hotfix|chore|release|refactor|docs|test|ci|perf|build|style';
const EXT_CODIGO = new Set(['ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'json', 'ejs', 'html', 'css', 'scss', 'sql', 'yml', 'yaml', 'env', 'md', 'py', 'java', 'sh', 'xml', 'lock']);
const NOMBRE_PRODUCTO = /^[A-Z][a-z]+\.js$/;
// Every quantifier is bounded, no group is quantified, and each start is guarded by a lookbehind: linear time.
export const PATRONES_QA = [
  /https?:\/\/[^\s)]{1,300}/gi,
  /(?<![\w./-])github\.com\/[^\s)]{1,300}/gi,
  /(?<![\w./-])[\w./-]{1,300}\/pull\/\d{1,9}[^\s)]{0,100}/gi,
  /(?<![\w./-])[\w.-]{1,100}\/[\w.-]{1,100}#\d{1,9}\b/g,
  /#\d{1,9}\b/g,
  new RegExp(`(?<![\\w./-])(?:origin\\/)?(?:${RAMAS})\\/[\\w./-]{1,100}`, 'gi'),
  /(?<![\w.-])\.env(?:\.[\w-]{1,30})?(?!\w)/gi,
];
// Paths (with a slash, any extension) and dotted file names (listed extensions only).
const PATRON_ARCHIVO = /(?<![\w.~-])[~\w./-]{1,300}\.[A-Za-z][A-Za-z0-9]{0,7}(?!\w)/g;

function esArchivo(token) {
  if (token.includes('/')) return true;
  if (NOMBRE_PRODUCTO.test(token)) return false;
  return EXT_CODIGO.has(token.slice(token.lastIndexOf('.') + 1).toLowerCase());
}

export function limpiarParaQa(texto) {
  let t = String(texto ?? '');
  for (const re of PATRONES_QA) t = t.replace(re, ' ');
  t = t.replace(PATRON_ARCHIVO, (m) => (esArchivo(m) ? ' ' : m));
  return t
    .replace(/\(\s{0,10}\)|\[\s{0,10}\]/g, ' ')
    .replace(/[ \t]{1,200}([,.;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n').map((l) => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const PENDIENTE = 'Steps pending';
const TITULO_PRUEBAS = /how to test|c[oó]mo probar|pruebas/i;
const MAX_CUERPO = 4096;
const MAX_ITEMS = 20;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const numerar = (pasos) => pasos.map((x, i) => `${i + 1}. ${x}`).join('\n');
const aTexto = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').join('\n') : typeof v === 'string' ? v : '');

function pasosDeCuerpo(cuerpo) {
  const lineas = String(cuerpo ?? '').slice(0, MAX_CUERPO).split('\n');
  const items = [];
  let dentro = false;
  for (const linea of lineas) {
    if (/^\s{0,3}#{1,6}\s/.test(linea)) {
      if (dentro) break;
      dentro = TITULO_PRUEBAS.test(linea);
      continue;
    }
    if (!dentro) continue;
    const m = /^\s{0,6}(?:[-*]|\d{1,3}\.)\s+(\S.*)$/.exec(linea);
    if (m && items.length < MAX_ITEMS) items.push(m[1].trim());
  }
  return items;
}

export const fusionDePista = (pista, prsPorId) => (
  pista.prs.map((id) => prsPorId.get(id)).filter((pr) => pr?.ambiente === 'pruebas').map((pr) => pr.mergeada).filter(Boolean).sort().at(-1) ?? null
);
export const claveFusion = (prs) => JSON.stringify([...prs].sort());

// guias.json `fusiones` of a guide generated from these deliveries: only tracks that get rows.
export function fusionesDe(entregas, prsPorId) {
  const fusiones = {};
  for (const e of entregas) {
    for (const pista of e.pistas) {
      if (pista.etapa !== 'esperando_qa' && pista.etapa !== 'qa_fallo') continue;
      const f = fusionDePista(pista, prsPorId);
      if (f) fusiones[claveFusion(pista.prs)] = f;
    }
  }
  return fusiones;
}

function contenidoDePista({ pista, entrega, prsPorId, explicaciones, filaRastreador }) {
  const pruebas = pista.prs.map((id) => prsPorId.get(id)).filter((pr) => pr?.ambiente === 'pruebas');
  const pantalla = limpiarParaQa(filaRastreador?.pantalla ?? '');
  const prioridad = limpiarParaQa(filaRastreador?.prioridad ?? '');
  const esperado = limpiarParaQa(filaRastreador?.esperado ?? '') || limpiarParaQa(entrega.titulo);
  let pasos = limpiarParaQa(aTexto(filaRastreador?.pasos));
  if (!pasos) {
    const lista = [...new Set(pruebas.flatMap((pr) => explicaciones.get(pr.id)?.como_probar ?? []).filter((x) => typeof x === 'string'))];
    pasos = limpiarParaQa(numerar(lista.map(limpiarParaQa).filter(Boolean)));
  }
  if (!pasos) {
    const lista = [...new Set(pruebas.flatMap((pr) => pasosDeCuerpo(pr.descripcion ?? pr.body)))];
    pasos = limpiarParaQa(numerar(lista.map(limpiarParaQa).filter(Boolean)));
  }
  const pendiente = !pasos;
  return { pantalla, prioridad, esperado, pasos: pasos || PENDIENTE, pendiente, hallazgo: limpiarParaQa(filaRastreador?.hallazgo ?? '') };
}

export function filasDeGuia({ entregas, prsPorId, explicaciones = new Map(), rastreador = null, columnas = QA_DEFECTO.columnas }) {
  const filas = [];
  const usadas = new Set();
  entregas.forEach((entrega, i) => {
    const etiquetas = entrega.ids?.length ? [...new Set(entrega.ids)] : [`E${i + 1}`];
    for (const pista of entrega.pistas ?? []) {
      if (pista.etapa !== 'esperando_qa' && pista.etapa !== 'qa_fallo') continue;
      for (const id of etiquetas) {
        // The pair (label, portal) is the import key: a repeat in another delivery gets that delivery's position.
        const etiqueta = usadas.has(`${id}|${pista.portal}`) ? `${id}-E${i + 1}` : id;
        const llave = `${etiqueta}|${pista.portal}`;
        if (usadas.has(llave)) throw new Error(`[seki-review/qa] Duplicate guide row key: ${etiqueta} / ${pista.portal}`);
        usadas.add(llave);
        const c = contenidoDePista({ pista, entrega, prsPorId, explicaciones, filaRastreador: rastreador?.get(id) ?? null });
        // Cells are keyed by column name: the user's list may reorder or extend the defaults. ID and Portal are keys: not cleaned.
        const valores = {
          'Screen and access': c.pantalla, 'Preconditions and data': '', Finding: c.hallazgo,
          Steps: c.pasos, 'Expected result': c.esperado, Priority: c.prioridad,
        };
        const celdas = columnas.map((nombre) => (nombre === 'ID' ? etiqueta : nombre === 'Portal' ? pista.portal : limpiarParaQa(valores[nombre] ?? '')));
        filas.push({ etiqueta, portal: pista.portal, entrega: entrega.clave, prs: [...pista.prs], celdas, pendiente: c.pendiente });
      }
    }
  });
  return filas;
}

export function firmaFila(secreto, { guia, etiqueta, portal, prs, entrega }) {
  return createHmac('sha256', secreto).update(JSON.stringify([guia, etiqueta, portal, [...prs].sort(), entrega])).digest('hex');
}

// Tracks waiting for QA whose newest testing merge is later than the one every covering guide recorded.
// A guide covers a track through its rows (same portal, shared PR), and records the merge under that row's track key.
export function entregasDesdeCorte({ entregas, guias, prsPorId }) {
  return entregas.flatMap((e) => {
    const pistas = e.pistas.filter((pista) => {
      if (pista.etapa !== 'esperando_qa') return false;
      const propios = new Set(pista.prs);
      const previas = (guias ?? []).flatMap((g) => (g.filas ?? [])
        .filter((f) => f.portal === pista.portal && cruzan(f.prs ?? [], propios))
        .map((f) => g.fusiones?.[claveFusion(f.prs)])
        .filter(Boolean));
      if (!previas.length) return true;
      const nueva = fusionDePista(pista, prsPorId);
      return Boolean(nueva) && cmp(nueva, previas.sort().at(-1)) > 0;
    });
    return pistas.length ? [{ ...e, pistas }] : [];
  });
}

export const leerGuias = (p) => {
  const g = leerJson(rutaGuias(p.salida), { guias: [] });
  return { ...g, guias: Array.isArray(g?.guias) ? g.guias : [] };
};

export async function registrarGuia(p, guia) {
  const ruta = rutaGuias(p.salida);
  return conBloqueo(ruta, () => {
    const actual = leerJson(ruta, { guias: [] });
    const previas = Array.isArray(actual?.guias) ? actual.guias : [];
    if (previas.some((g) => g?.id === guia.id)) throw Object.assign(new Error(`[seki-review/qa] The guide id ${guia.id} is already registered`), { codigo: 'QA_GUIA_DUPLICADA' });
    const nueva = { id: guia.id, fecha: guia.fecha, entregas: guia.entregas, filas: guia.filas.map(({ etiqueta, portal, entrega, prs }) => ({ etiqueta, portal, entrega, prs })), fusiones: guia.fusiones };
    escribirAtomico(ruta, JSON.stringify({ guias: [...previas, nueva] }, null, 2) + '\n');
    return nueva;
  });
}

export async function quitarGuia(p, id) {
  const ruta = rutaGuias(p.salida);
  return conBloqueo(ruta, () => {
    const actual = leerJson(ruta, { guias: [] });
    const guias = (Array.isArray(actual?.guias) ? actual.guias : []).filter((g) => g?.id !== id);
    escribirAtomico(ruta, JSON.stringify({ guias }, null, 2) + '\n');
  });
}

const llaveFila = (etiqueta, portal) => JSON.stringify([etiqueta, portal]);
const cruzan = (a, b) => a.some((id) => b.has(id));
const masNueva = (a, b) => (cmp(b.fecha ?? '', a.fecha ?? '') > 0 || (cmp(b.fecha ?? '', a.fecha ?? '') === 0 && cmp(b.id, a.id) > 0) ? b : a);

// True when `b` was generated after `a`.
export const esMasNueva = (b, a) => masNueva(a, b) === b && b.id !== a.id;

export function tieneResultados(guia, pista, eventos) {
  const propios = new Set(pista.prs);
  return (eventos ?? []).some((e) => e?.tipo === 'qa_resultado' && e.guia === guia.id && e.portal === pista.portal && Array.isArray(e.prs) && cruzan(e.prs, propios));
}

// The guide that governs a track: the newest covering guide that has results for it, else the newest covering guide.
// Generating a newer, still empty guide therefore never discards results already imported.
export function guiaVigente(guias, pista, eventos) {
  const propios = new Set(pista.prs);
  const cubren = (guias ?? []).filter((g) => (g.filas ?? []).some((f) => f.portal === pista.portal && cruzan(f.prs ?? [], propios)));
  if (!cubren.length) return null;
  const conResultados = cubren.filter((g) => tieneResultados(g, pista, eventos));
  return (conResultados.length ? conResultados : cubren).reduce(masNueva);
}

// QA state of a track from the imported results: only the rows of the governing guide (guiaVigente) count,
// the newest import of each row wins, any failure fails the track, and the track passes only when every row
// of the guide for it has an ok/na result. Rows whose newest result is `bloqueado` set `bloqueado`.
export function qaDeEventos(eventos, guias) {
  const resultados = (eventos ?? []).filter((e) => e?.tipo === 'qa_resultado' && Array.isArray(e.prs));
  return (_entrega, pista) => {
    const propios = new Set(pista.prs);
    const guia = guiaVigente(guias, pista, resultados);
    if (!guia) return null;
    const filas = guia.filas.filter((f) => f.portal === pista.portal && cruzan(f.prs ?? [], propios));
    const ultimo = new Map();
    for (const e of resultados) {
      if (e.guia !== guia.id || e.portal !== pista.portal || !cruzan(e.prs, propios)) continue;
      const k = llaveFila(e.fila, e.portal);
      const previo = ultimo.get(k);
      const orden = previo ? cmp(e.ts, previo.ts) || cmp(e.registrado ?? '', previo.registrado ?? '') || cmp(e.id, previo.id) : 1;
      if (orden > 0) ultimo.set(k, e);
    }
    const vigentes = filas.map((f) => ultimo.get(llaveFila(f.etiqueta, f.portal))).filter(Boolean);
    if (!vigentes.length) return null;
    const ts = vigentes.map((e) => e.ts).sort().at(-1);
    const bloqueado = vigentes.some((e) => e.resultado === 'bloqueado');
    if (vigentes.some((e) => e.resultado === 'fallo')) return { resultado: 'fallo', ts, bloqueado };
    const completo = vigentes.length === filas.length && vigentes.every((e) => e.resultado === 'ok' || e.resultado === 'na');
    return { resultado: completo ? 'ok' : null, ts, bloqueado };
  };
}
