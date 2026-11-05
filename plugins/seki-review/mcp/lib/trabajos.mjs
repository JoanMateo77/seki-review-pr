// The dashboard's AI job queue. Each job brings its own `ejecutar` function, which returns
// { ok, motivo, costo, modelo }; the queue only orders jobs, limits parallelism and stores the result.
// With a budget gate, a job that does not fit stays blocked (not failed) until spend allows it or it is forced.
import { mensajeBloqueo } from './presupuesto.mjs';

export const paralelo = () => Math.min(2, Math.max(1, Number(process.env.SEKI_IA_PARALELO) || 1));

const ESPERANDO = new Set(['en_cola', 'bloqueado_presupuesto']);

const REINTENTO_MS = 30 * 1000;

export function crearCola({ alTerminar, presupuesto, reintentoMs = REINTENTO_MS } = {}) {
  const trabajos = new Map();
  const funciones = new Map();
  const cancelaciones = new Map();
  const reservas = new Map();
  let activos = 0;
  const corriendo = new Set();
  let reloj = null;

  // Blocked jobs are only re-checked on queue events; while any is blocked a timer re-checks them, so a day
  // change or a lower spend reading releases them by itself.
  function vigilarBloqueados() {
    const hay = [...trabajos.values()].some((t) => t.estado === 'bloqueado_presupuesto');
    if (hay && !reloj) {
      reloj = setTimeout(() => { reloj = null; siguiente(); }, reintentoMs);
      reloj.unref();
    } else if (!hay && reloj) {
      clearTimeout(reloj);
      reloj = null;
    }
  }

  function siguiente() {
    try { revisar(); } finally { vigilarBloqueados(); }
  }

  function revisar() {
    for (const t of [...trabajos.values()]) {
      if (activos >= paralelo()) return;
      if (!ESPERANDO.has(t.estado)) continue;
      if (presupuesto && !t.forzado) {
        if (!presupuesto.cabe(t.topeUsd ?? 0)) {
          if (t.estado !== 'bloqueado_presupuesto') console.error(`[seki-review/presupuesto] A ${t.tipo} job is blocked by the daily budget`);
          Object.assign(t, { estado: 'bloqueado_presupuesto', mensaje: mensajeBloqueo(presupuesto.estado(), t.topeUsd) });
          continue;
        }
        Object.assign(t, { estado: 'en_cola', mensaje: null });
      }
      const pr = ejecutar(t);
      corriendo.add(pr);
      pr.finally(() => corriendo.delete(pr));
    }
  }

  async function ejecutar(t) {
    activos++;
    if (presupuesto) reservas.set(t.id, presupuesto.reservar(t.topeUsd ?? 0));
    Object.assign(t, { estado: 'en_curso', inicio: new Date().toISOString() });
    let r;
    try { r = await funciones.get(t.id)(); } catch (e) { r = { ok: false, motivo: e.message, costo: e?.costo }; }
    funciones.delete(t.id);
    cancelaciones.delete(t.id);
    // A failure that does not report its cost is released at the reserved cap, so the spend is never undercounted.
    reservas.get(t.id)?.liberar(r?.costo ?? (r?.ok === false ? t.topeUsd : 0));
    reservas.delete(t.id);
    activos--;
    Object.assign(t, {
      estado: r?.ok === false ? 'error' : 'terminado',
      fin: new Date().toISOString(),
      mensaje: r?.ok === false ? String(r.motivo ?? 'The job failed').slice(0, 400) : null,
      costo: r?.costo ?? null,
      modelo: r?.modelo ?? null,
    });
    delete t.forzado;
    alTerminar?.(t);
    siguiente();
  }

  return {
    encolar(items) {
      let n = 0;
      for (const { id, tipo, prId, ejecutar: fn, alCancelar, topeUsd = 0, forzado = false } of items) {
        const previo = trabajos.get(id);
        if (previo && (ESPERANDO.has(previo.estado) || previo.estado === 'en_curso')) continue;
        trabajos.set(id, { id, tipo, prId, topeUsd, ...(forzado ? { forzado } : {}), estado: 'en_cola', encolado: new Date().toISOString() });
        funciones.set(id, fn);
        if (alCancelar) cancelaciones.set(id, alCancelar);
        n++;
      }
      siguiente();
      return n;
    },
    vaciar() {
      let n = 0;
      for (const t of trabajos.values()) {
        if (!ESPERANDO.has(t.estado)) continue;
        t.estado = 'cancelado';
        t.mensaje = null;
        funciones.delete(t.id);
        try { cancelaciones.get(t.id)?.(); } catch { /* the notification must not stop the cancellation */ }
        cancelaciones.delete(t.id);
        n++;
      }
      vigilarBloqueados();
      return n;
    },
    // Lets one blocked job run once; later jobs are gated again.
    forzar(id) {
      const t = trabajos.get(id);
      if (t?.estado !== 'bloqueado_presupuesto') return false;
      console.error(`[seki-review/presupuesto] A blocked ${t.tipo} job was forced to run`);
      Object.assign(t, { estado: 'en_cola', forzado: true, mensaje: null });
      siguiente();
      return true;
    },
    // Cancels the queued jobs and resolves once the running ones have finished.
    async detener() {
      this.vaciar();
      while (corriendo.size) await Promise.allSettled([...corriendo]);
    },
    lista: () => [...trabajos.values()],
  };
}
