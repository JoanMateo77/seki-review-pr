// Merge watcher: while the dashboard is open in a browser, cheaply polls GitHub and runs a partial refresh for the
// repos that changed. All timing goes through `reloj`, so tests drive it with a fake clock.
import { enParalelo } from './proceso.mjs';

export const BACKOFF_MAX_MS = 30 * 60 * 1000;
export const VENTANA_TABLERO_MS = 10 * 60 * 1000;
const RELOJ_REAL = { ahora: () => Date.now(), programar: (f, ms) => setTimeout(f, ms), cancelar: (t) => clearTimeout(t) };

const mensajeCorto = (e) => String(e?.message ?? e).slice(0, 200);

export function crearVigia({ intervaloMs, sondear, refrescar, tableroAbierto, reloj = RELOJ_REAL }) {
  let temporizador = null;
  let activo = false; // between iniciar() and detener()
  let enCurso = false;
  let fallos = 0;
  let ultimo = null;
  let error = null;
  let siguienteMs = intervaloMs;

  const retardo = () => Math.min(intervaloMs * 2 ** fallos, BACKOFF_MAX_MS);

  const programar = () => {
    if (!activo) return;
    siguienteMs = retardo();
    temporizador = reloj.programar(ciclo, siguienteMs);
    temporizador?.unref?.();
  };

  async function ciclo() {
    temporizador = null;
    if (!activo || enCurso) return;
    if (!tableroAbierto()) return programar();
    enCurso = true;
    try {
      const repos = await sondear();
      if (!activo) return;
      if (repos.length) await refrescar(repos);
      if (!activo) return;
      ultimo = new Date(reloj.ahora()).toISOString();
      error = null;
      fallos = 0;
    } catch (e) {
      if (activo) {
        fallos++;
        error = mensajeCorto(e);
        console.error(`[seki-review/vigia] ${error}`);
      }
    } finally {
      enCurso = false;
    }
    programar();
  }

  return {
    iniciar() {
      if (activo) return;
      activo = true;
      programar();
    },
    // After this, no callback does anything, including the end of a cycle already running.
    detener() {
      activo = false;
      if (temporizador !== null) reloj.cancelar(temporizador);
      temporizador = null;
    },
    ocupado: () => enCurso,
    estado: () => ({ ultimo, error, siguienteMs }),
  };
}

const sinMilisegundos = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// Probe per repo with one `gh pr list` each. The first bound is the snapshot time (no snapshot: every repo counts as
// changed); afterwards it is the instant the last successful probe started, so nothing falls between probe and refresh.
export function crearSondeo({ owner, repos, instantanea, gh, ahora = Date.now }) {
  let limite = null;
  let candidato = null;
  return {
    async sondear() {
      const inicio = ahora();
      const cota = limite ?? instantanea();
      candidato = inicio;
      if (!cota) return [...repos];
      const iso = sinMilisegundos(Date.parse(cota));
      const resultados = await enParalelo(repos, 4, async (repo) => {
        const lista = await gh(['pr', 'list', '-R', `${owner}/${repo}`, '--state', 'all', '--search', `updated:>=${iso}`, '--json', 'number,updatedAt', '--limit', '50']);
        return Array.isArray(lista) && lista.length > 0;
      });
      const cambiados = repos.filter((_, i) => resultados[i]);
      if (!cambiados.length) limite = new Date(inicio).toISOString();
      return cambiados;
    },
    // Called after the refresh of the probed repos succeeded.
    confirmar() {
      if (candidato !== null) limite = new Date(candidato).toISOString();
    },
  };
}
