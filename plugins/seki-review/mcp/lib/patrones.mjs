import vm from 'node:vm';
// Guarded compilation of regular expressions that come from user config.
const MAX_FUENTE = 300;
// The nested-quantifier check is a heuristic; the real bounds are the input length cap and probarSeguro's time limit.
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

// Runs a config regex over the first maxLargo characters with a hard time limit (vm timeout
// interrupts catastrophic backtracking, which a length cap alone does not). Returns AGOTADO on timeout.
export const AGOTADO = Symbol('agotado');
const contexto = vm.createContext({ re: null, s: '' });
const guion = new vm.Script('re.test(s)');
export function probarSeguro(re, texto, { maxLargo = 4096, timeoutMs = 50 } = {}) {
  contexto.re = re;
  contexto.s = String(texto).slice(0, maxLargo);
  re.lastIndex = 0;
  try {
    return guion.runInContext(contexto, { timeout: timeoutMs });
  } catch (e) {
    if (e?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return AGOTADO;
    throw e;
  } finally {
    contexto.re = null;
  }
}
