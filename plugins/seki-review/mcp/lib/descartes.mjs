import { createHash } from 'node:crypto';
import { escribirJson, leerJson, rutaDescartes } from './cache.mjs';
import { resumir } from './verificar.mjs';

export const TRIABLES = new Set(['bloqueante', 'alto', 'medio']);

const MOTIVO_MAX = 500;
const AUTORES = new Set(['ia', 'persona']);

// The line is left out on purpose: a push that only shifts the code must not reopen a dismissed finding.
export function huellaHallazgo(h) {
  const texto = String(h.texto ?? '').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update([h.regla, h.archivo, texto].join('\0')).digest('hex').slice(0, 16);
}

export const leerDescartes = (p, repo, numero) => leerJson(rutaDescartes(p.salida, repo, numero), []);

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
    motivo: limpio,
    autor: 'persona',
    propuestoPor,
    fecha: new Date().toISOString(),
  };
  const resto = leerDescartes(p, repo, numero).filter((d) => d.huella !== huella);
  escribirJson(rutaDescartes(p.salida, repo, numero), [...resto, descarte]);
  return descarte;
}

export function reabrir(p, repo, numero, huella) {
  const actuales = leerDescartes(p, repo, numero);
  const resto = actuales.filter((d) => d.huella !== huella);
  if (resto.length === actuales.length) return false;
  escribirJson(rutaDescartes(p.salida, repo, numero), resto);
  return true;
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
