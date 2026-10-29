// The dashboard's AI job queue. Each job brings its own `ejecutar` function, which returns
// { ok, motivo, costo, modelo }; the queue only orders jobs, limits parallelism and stores the result.
const PARALELO = Math.min(2, Math.max(1, Number(process.env.SEKI_IA_PARALELO) || 1));

export function crearCola({ alTerminar } = {}) {
  const trabajos = new Map();
  const funciones = new Map();
  const cancelaciones = new Map();
  let activos = 0;

  function siguiente() {
    while (activos < PARALELO) {
      const t = [...trabajos.values()].find((x) => x.estado === 'en_cola');
      if (!t) return;
      ejecutar(t);
    }
  }

  async function ejecutar(t) {
    activos++;
    Object.assign(t, { estado: 'en_curso', inicio: new Date().toISOString() });
    let r;
    try { r = await funciones.get(t.id)(); } catch (e) { r = { ok: false, motivo: e.message }; }
    funciones.delete(t.id);
    cancelaciones.delete(t.id);
    activos--;
    Object.assign(t, {
      estado: r?.ok === false ? 'error' : 'terminado',
      fin: new Date().toISOString(),
      mensaje: r?.ok === false ? String(r.motivo ?? 'The job failed').slice(0, 400) : null,
      costo: r?.costo ?? null,
      modelo: r?.modelo ?? null,
    });
    alTerminar?.(t);
    siguiente();
  }

  return {
    encolar(items) {
      let n = 0;
      for (const { id, tipo, prId, ejecutar: fn, alCancelar } of items) {
        const previo = trabajos.get(id);
        if (previo && (previo.estado === 'en_cola' || previo.estado === 'en_curso')) continue;
        trabajos.set(id, { id, tipo, prId, estado: 'en_cola', encolado: new Date().toISOString() });
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
        if (t.estado !== 'en_cola') continue;
        t.estado = 'cancelado';
        funciones.delete(t.id);
        try { cancelaciones.get(t.id)?.(); } catch { /* the notification must not stop the cancellation */ }
        cancelaciones.delete(t.id);
        n++;
      }
      return n;
    },
    lista: () => [...trabajos.values()],
  };
}
