import { createHash } from 'node:crypto';
import { conBloqueoSync, escribirAtomico } from './bloqueo.mjs';
import { leerJson, rutaDescartes } from './cache.mjs';
import { resumir } from './verificar.mjs';

export const TRIABLES = new Set(['bloqueante', 'alto', 'medio']);
export const MOTIVO_SIN_VEREDICTO = 'The triage gave no verdict';

const MAX_TRIABLES = 40;
const ORDEN_SEVERIDAD = ['bloqueante', 'alto', 'medio'];

// One selection for the standalone triage and for Ultra, so both judge the same findings.
export function triablesOrdenados(hallazgos) {
  return (hallazgos ?? [])
    .filter((h) => TRIABLES.has(h.severidad))
    .map((h) => ({ ...h, huella: h.huella ?? huellaHallazgo(h) }))
    .sort((a, b) => ORDEN_SEVERIDAD.indexOf(a.severidad) - ORDEN_SEVERIDAD.indexOf(b.severidad))
    .slice(0, MAX_TRIABLES);
}

const MOTIVO_MAX = 500;
const AUTORES = new Set(['ia', 'persona']);

// The line is left out on purpose: a push that only shifts the code must not reopen a dismissed finding.
// A finding cached before `hashLinea` existed keeps the fingerprint of its cut text until the checks run again.
export function huellaHallazgo(h) {
  const contenido = h.hashLinea ?? String(h.texto ?? '').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update([h.regla, h.archivo, contenido].join('\0')).digest('hex').slice(0, 16);
}

export const leerDescartes = (p, repo, numero) => leerJson(rutaDescartes(p.salida, repo, numero), []);

// The MCP server and the board are two processes that write this file: the read-modify-write runs under one lock.
// escribirAtomico, not escribirJson, because the lock is not re-entrant. Returning null leaves the file untouched.
function modificar(p, repo, numero, cambiar) {
  const ruta = rutaDescartes(p.salida, repo, numero);
  return conBloqueoSync(ruta, () => {
    const nuevos = cambiar(leerJson(ruta, []));
    if (nuevos !== null) escribirAtomico(ruta, JSON.stringify(nuevos, null, 2) + '\n');
    return nuevos;
  });
}

export function descartar(p, repo, numero, hallazgo, { motivo, propuestoPor }) {
  const limpio = String(motivo ?? '').trim();
  if (limpio.length < 1 || limpio.length > MOTIVO_MAX) throw new Error(`motivo must have between 1 and ${MOTIVO_MAX} characters`);
  if (!AUTORES.has(propuestoPor)) throw new Error("propuestoPor must be 'ia' or 'persona'");
  const huella = huellaHallazgo(hallazgo);
  const descarte = {
    huella,
    regla: hallazgo.regla,
    archivo: hallazgo.archivo,
    texto: hallazgo.texto,
    ...(hallazgo.hashLinea ? { hashLinea: hallazgo.hashLinea } : {}),
    motivo: limpio,
    autor: 'persona',
    propuestoPor,
    fecha: new Date().toISOString(),
  };
  modificar(p, repo, numero, (actuales) => [...actuales.filter((d) => d.huella !== huella), descarte]);
  return descarte;
}

export function reabrir(p, repo, numero, huella) {
  return modificar(p, repo, numero, (actuales) => {
    const resto = actuales.filter((d) => d.huella !== huella);
    return resto.length === actuales.length ? null : resto;
  }) !== null;
}

export function aplicarDescartes(verificaciones, descartes) {
  const porHuella = new Map(descartes.map((d) => [d.huella, d]));
  const hallazgos = [];
  const descartados = [];
  // Already-dismissed entries are re-evaluated too, so applying twice keeps them (and reopening still restores them).
  const previos = (verificaciones.descartados ?? []).map(({ descarte, ...h }) => h);
  for (const h of [...(verificaciones.hallazgos ?? []), ...previos]) {
    const huella = huellaHallazgo(h);
    const descarte = porHuella.get(huella);
    if (descarte) descartados.push({ ...h, huella, descarte });
    else hallazgos.push({ ...h, huella });
  }
  return { ...verificaciones, hallazgos, descartados, resumen: resumir(hallazgos) };
}
