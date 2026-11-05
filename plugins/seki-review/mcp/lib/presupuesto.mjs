// Daily AI budget of the machine: spend of every configured project today (local time) plus what running jobs
// may still spend. Gate in front of the queue and of the synchronous filter.
import { expandir } from './config.mjs';
import { costosDelDia, diaLocal } from './ia.mjs';

const REFRESCO_MS = 30 * 1000;

// Sum of today's records across the cost logs of all projects; unreadable lines are skipped by costosDelDia.
export function gastoMaquina({ proyectos, dia, ahora = Date.now() }) {
  const lista = Array.isArray(proyectos) ? proyectos : Object.values(proyectos ?? {});
  const hoy = dia ?? diaLocal(ahora);
  let total = 0;
  for (const p of lista) if (p?.salida) total += costosDelDia({ salida: expandir(p.salida) }, hoy).total;
  return total;
}

const usd = (n) => `$${n.toFixed(2)}`;

export const mensajeBloqueo = ({ limite, gastado, reservado }) => `Blocked by the daily budget (${usd(gastado + reservado)} of ${usd(limite)} spent)`;

export function crearPresupuesto({ limite, gasto, ahora = Date.now }) {
  let gastado = 0;
  let leidoEn = null;
  let diaLeido = null;
  let extra = 0;
  let reservado = 0;

  // The spend is re-read at most every 30 s and whenever the local day changes.
  function leer() {
    const t = ahora();
    const dia = diaLocal(t);
    if (leidoEn === null || t - leidoEn >= REFRESCO_MS || dia !== diaLeido) {
      gastado = Number(gasto()) || 0;
      extra = 0;
      leidoEn = t;
      diaLeido = dia;
    }
  }

  const estado = () => {
    leer();
    return { limite: limite() ?? null, gastado: gastado + extra, reservado };
  };

  return {
    estado,
    cabe(topeUsd = 0) {
      const e = estado();
      return e.limite === null || e.gastado + e.reservado + topeUsd <= e.limite;
    },
    // The reservation counts as spent until the job ends; then its real cost replaces it.
    reservar(topeUsd = 0) {
      reservado += topeUsd;
      let liberada = false;
      return {
        liberar(costoReal = 0) {
          if (liberada) return;
          liberada = true;
          reservado = Math.max(0, reservado - topeUsd);
          extra += Number(costoReal) || 0;
        },
      };
    },
  };
}
