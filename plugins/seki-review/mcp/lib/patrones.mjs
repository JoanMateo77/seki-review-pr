import vm from 'node:vm';
// Guarded compilation of regular expressions that come from user config.
const MAX_FUENTE = 300;
// The nested-quantifier check is a heuristic; the real bounds are the input length cap and the vm time limit.
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

// Config regexes run over the first maxLargo characters inside a vm context with a hard time limit:
// the vm timeout interrupts catastrophic backtracking, which a length cap alone does not.
// On timeout both functions return AGOTADO.
export const AGOTADO = Symbol('agotado');
const contexto = vm.createContext({ re: null, s: '', max: 0 });
const guionProbar = new vm.Script('re.test(s)');
const guionTodas = new vm.Script(`(() => {
  const unicas = new Set();
  for (const m of s.matchAll(re)) {
    unicas.add(m[0]);
    if (unicas.size >= max) break;
  }
  return [...unicas];
})()`);

function enContexto(guion, re, texto, { maxLargo, timeoutMs, max = 0 }) {
  contexto.re = re;
  contexto.s = String(texto).slice(0, maxLargo);
  contexto.max = max;
  re.lastIndex = 0;
  try {
    return guion.runInContext(contexto, { timeout: timeoutMs });
  } catch (e) {
    if (e?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return AGOTADO;
    throw e;
  } finally {
    contexto.re = null;
    contexto.s = '';
  }
}

export const probarSeguro = (re, texto, { maxLargo = 4096, timeoutMs = 50 } = {}) =>
  enContexto(guionProbar, re, texto, { maxLargo, timeoutMs });

// Distinct matches (at most maxCoincidencias); the caller regex is not modified.
export function coincidencias(re, texto, { maxLargo = 4096, maxCoincidencias = 50, timeoutMs = 50 } = {}) {
  const copia = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const r = enContexto(guionTodas, copia, texto, { maxLargo, timeoutMs, max: maxCoincidencias });
  return r === AGOTADO ? r : Array.from(r);
}
