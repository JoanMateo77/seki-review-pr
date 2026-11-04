// Content and cuts of the QA guide. Pure except registrarGuia/leerGuias (guias.json).
import { createHmac } from 'node:crypto';
import { QA_DEFECTO } from './config.mjs';
import { conBloqueo, escribirAtomico } from './bloqueo.mjs';
import { leerJson, rutaGuias } from './cache.mjs';

const EXTENSIONES = 'mjs|cjs|js|jsx|ts|tsx|json|ya?ml|md|ejs|html?|css|scss|sql|sh|py|java|xml|txt|csv|xlsx?|png|jpe?g|svg|lock|env';
// Every quantifier is bounded and each start is guarded by a lookbehind: input of any shape is scanned in linear time.
const PATRONES = [
  /https?:\/\/[^\s)]{1,300}\/pull\/\d{1,9}[^\s)]{0,100}/g,
  /(?<![\w./-])[\w.-]{1,100}\/[\w.-]{1,100}#\d{1,9}\b/g,
  /#\d{1,9}\b/g,
  /(?<![\w./-])(?:feat|fix|hotfix|chore|release)\/[\w./-]{1,100}/g,
  new RegExp(`(?<![\\w./-])(?:[\\w.-]{1,100}\\/){1,10}[\\w.-]{1,100}\\.(?:${EXTENSIONES})(?![\\w])`, 'g'),
  new RegExp(`(?<![\\w./-])[\\w-]{1,100}\\.(?:${EXTENSIONES})(?![\\w])`, 'g'),
];

export function limpiarParaQa(texto) {
  let t = String(texto ?? '');
  for (const re of PATRONES) t = t.replace(re, ' ');
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
export const claveFusion = (prs) => [...prs].sort().join(',');

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
    const lista = [...new Set(pruebas.flatMap((pr) => pasosDeCuerpo(pr.descripcion ?? pr.cuerpo ?? pr.body)))];
    pasos = limpiarParaQa(numerar(lista.map(limpiarParaQa).filter(Boolean)));
  }
  const pendiente = !pasos;
  return { pantalla, prioridad, esperado, pasos: pasos || PENDIENTE, pendiente, hallazgo: limpiarParaQa(filaRastreador?.hallazgo ?? '') };
}

export function filasDeGuia({ entregas, prsPorId, cfgRepos, explicaciones = new Map(), rastreador = null, columnas = QA_DEFECTO.columnas }) {
  void cfgRepos;
  const filas = [];
  entregas.forEach((entrega, i) => {
    const etiquetas = entrega.ids?.length ? entrega.ids : [`E${i + 1}`];
    for (const pista of entrega.pistas ?? []) {
      if (pista.etapa !== 'esperando_qa' && pista.etapa !== 'qa_fallo') continue;
      for (const etiqueta of etiquetas) {
        const c = contenidoDePista({ pista, entrega, prsPorId, explicaciones, filaRastreador: rastreador?.get(etiqueta) ?? null });
        // Cells are keyed by column name: the user's list may reorder or extend the defaults.
        const valores = {
          ID: etiqueta, Portal: pista.portal, 'Screen and access': c.pantalla || c.hallazgo, 'Preconditions and data': '',
          Steps: c.pasos, 'Expected result': c.esperado, Priority: c.prioridad,
        };
        const celdas = columnas.map((nombre) => limpiarParaQa(valores[nombre] ?? ''));
        filas.push({ etiqueta, portal: pista.portal, entrega: entrega.clave, prs: [...pista.prs], celdas, pendiente: c.pendiente });
      }
    }
  });
  return filas;
}

export function firmaFila(secreto, { guia, etiqueta, portal, prs, entrega }) {
  return createHmac('sha256', secreto).update([guia, etiqueta, portal, [...prs].sort().join(','), entrega].join('\n')).digest('hex');
}

// Tracks waiting for QA whose newest testing merge is later than the one every covering guide recorded.
export function entregasDesdeCorte({ entregas, guias, prsPorId }) {
  const registros = (guias ?? []).flatMap((g) => Object.entries(g.fusiones ?? {}).map(([k, f]) => ({ ids: new Set(k.split(',')), f })));
  return entregas.flatMap((e) => {
    const pistas = e.pistas.filter((pista) => {
      if (pista.etapa !== 'esperando_qa') return false;
      const cubiertos = registros.filter((r) => pista.prs.some((id) => r.ids.has(id)));
      if (!cubiertos.length) return true;
      const nueva = fusionDePista(pista, prsPorId);
      const previa = cubiertos.map((r) => r.f).sort().at(-1);
      return Boolean(nueva) && cmp(nueva, previa) > 0;
    });
    return pistas.length ? [{ ...e, pistas }] : [];
  });
}

export const leerGuias = (p) => leerJson(rutaGuias(p.salida), { guias: [] });

export async function registrarGuia(p, guia) {
  const ruta = rutaGuias(p.salida);
  return conBloqueo(ruta, () => {
    const actual = leerJson(ruta, { guias: [] });
    const nueva = { id: guia.id, fecha: guia.fecha, entregas: guia.entregas, filas: guia.filas.map(({ etiqueta, portal, entrega, prs }) => ({ etiqueta, portal, entrega, prs })), fusiones: guia.fusiones };
    escribirAtomico(ruta, JSON.stringify({ guias: [...actual.guias, nueva] }, null, 2) + '\n');
    return nueva;
  });
}
