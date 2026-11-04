// Guarded compilation of regular expressions that come from user config.
const MAX_FUENTE = 300;
// Heuristic guard only: the input length cap (maxLargo in coincidencias) is the real bound.
const GRUPO_CUANTIFICADO = /\((?:[^()\\]|\\.)*[+*}]\)[+*{]/;

export function compilarPatron(fuente, banderas = '') {
  if (typeof fuente !== 'string' || !fuente) throw new Error('Invalid pattern: empty');
  if (fuente.length > MAX_FUENTE) throw new Error(`Invalid pattern: longer than ${MAX_FUENTE} characters`);
  if (GRUPO_CUANTIFICADO.test(fuente)) throw new Error('Invalid pattern: nested quantifiers');
  try {
    return new RegExp(fuente, banderas);
  } catch (e) {
    throw new Error(`Invalid pattern: ${e.message}`);
  }
}

export function coincidencias(re, texto, { maxLargo = 4096, maxCoincidencias = 50 } = {}) {
  const copia = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const unicas = new Set();
  for (const m of String(texto).slice(0, maxLargo).matchAll(copia)) {
    unicas.add(m[0]);
    if (unicas.size >= maxCoincidencias) break;
  }
  return [...unicas];
}
