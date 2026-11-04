import vm from 'node:vm';
// Guarded compilation of regular expressions that come from user config.
const MAX_FUENTE = 300;
// The nested-quantifier check is a heuristic; the real bounds are the input length cap and the vm time limit.
const GRUPO_CUANTIFICADO = /\((?:[^()\\]|\\.)*[+*}]\)[+*{]/;

export const tieneCuantificadoresAnidados = (fuente) => GRUPO_CUANTIFICADO.test(fuente);

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

// CPU milliseconds used by this thread (the whole process on Node versions without threadCpuUsage).
const cpuDelHilo = () => {
  const u = (process.threadCpuUsage ?? process.cpuUsage)();
  return (u.user + u.system) / 1000;
};
const VECES_LIMITE_PARED = 10;

// The vm limit is wall time, so on a loaded machine a cheap pattern can be descheduled for the whole window. A timed-out
// run counts only for the CPU it used and is repeated until the runs together used half the limit (an unstarved
// catastrophic run uses about all of it, so it still stops after one run), or until another run would pass 10 times the
// limit of wall time. Per input that bounds the CPU to 1.5 x timeoutMs (75 ms) and the wall time to 10 x timeoutMs (500 ms).
function enContexto(guion, re, texto, { maxLargo, timeoutMs, max = 0, cpu = cpuDelHilo, ahora = performance.now.bind(performance) }) {
  contexto.re = re;
  contexto.s = String(texto).slice(0, maxLargo);
  contexto.max = max;
  try {
    const inicio = ahora();
    let usado = 0;
    for (;;) {
      re.lastIndex = 0;
      const antes = cpu();
      try {
        return guion.runInContext(contexto, { timeout: timeoutMs });
      } catch (e) {
        if (e?.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw e;
      }
      usado += cpu() - antes;
      if (usado >= timeoutMs / 2 || ahora() - inicio + timeoutMs > VECES_LIMITE_PARED * timeoutMs) return AGOTADO;
    }
  } finally {
    contexto.re = null;
    contexto.s = '';
  }
}

// `cpu` and `ahora` (CPU and wall clocks in ms) exist for tests only.
export const probarSeguro = (re, texto, { maxLargo = 4096, timeoutMs = 50, cpu, ahora } = {}) =>
  enContexto(guionProbar, re, texto, { maxLargo, timeoutMs, cpu, ahora });

// Distinct matches (at most maxCoincidencias); the caller regex is not modified.
export function coincidencias(re, texto, { maxLargo = 4096, maxCoincidencias = 50, timeoutMs = 50, cpu, ahora } = {}) {
  const copia = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const r = enContexto(guionTodas, copia, texto, { maxLargo, timeoutMs, max: maxCoincidencias, cpu, ahora });
  return r === AGOTADO ? r : Array.from(r);
}
