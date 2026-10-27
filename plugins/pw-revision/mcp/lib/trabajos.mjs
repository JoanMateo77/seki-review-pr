// Cola de trabajos de IA del tablero. Cada trabajo trae su propia función `ejecutar`, que devuelve
// { ok, motivo, costo, modelo }; la cola solo ordena, limita el paralelismo y guarda el resultado.
const PARALELO = Math.min(2, Math.max(1, Number(process.env.PW_IA_PARALELO) || 1));

export function crearCola({ alTerminar } = {}) {
  const trabajos = new Map();
  const funciones = new Map();
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
    activos--;
    Object.assign(t, {
      estado: r?.ok === false ? 'error' : 'terminado',
      fin: new Date().toISOString(),
      mensaje: r?.ok === false ? String(r.motivo ?? 'El trabajo falló').slice(0, 400) : null,
      costo: r?.costo ?? null,
      modelo: r?.modelo ?? null,
    });
    alTerminar?.(t);
    siguiente();
  }

  return {
    encolar(items) {
      let n = 0;
      for (const { id, tipo, prId, ejecutar: fn } of items) {
        const previo = trabajos.get(id);
        if (previo && (previo.estado === 'en_cola' || previo.estado === 'en_curso')) continue;
        trabajos.set(id, { id, tipo, prId, estado: 'en_cola', encolado: new Date().toISOString() });
        funciones.set(id, fn);
        n++;
      }
      siguiente();
      return n;
    },
    vaciar() {
      let n = 0;
      for (const t of trabajos.values()) if (t.estado === 'en_cola') { t.estado = 'cancelado'; funciones.delete(t.id); n++; }
      return n;
    },
    lista: () => [...trabajos.values()],
  };
}
