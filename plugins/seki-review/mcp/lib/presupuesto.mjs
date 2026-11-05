// Daily AI budget of the machine: spend of every configured project today (local time) plus what running jobs
// may still spend. Gate in front of the queue and of the synchronous filter.
import { resolve } from 'node:path';
import { expandir } from './config.mjs';
import { costosDelDia, diaLocal } from './ia.mjs';

const REFRESCO_MS = 30 * 1000;

// Sum of today's records across the cost logs of all projects; unreadable lines are skipped by costosDelDia.
export function gastoMaquina({ proyectos, dia, ahora = Date.now() }) {
  const lista = Array.isArray(proyectos) ? proyectos : Object.values(proyectos ?? {});
  const hoy = dia ?? diaLocal(ahora);
  // Two projects may share an output folder: its costs file counts once.
  const salidas = new Set(lista.filter((p) => p?.salida).map((p) => resolve(expandir(p.salida))));
  let total = 0;
  for (const salida of salidas) total += costosDelDia({ salida }, hoy).total;
  return total;
}

const usd = (n) => `$${n.toFixed(2)}`;

export function mensajeBloqueo({ limite, gastado, reservado }, topeUsd = 0) {
  if (topeUsd > limite) return `Blocked by the daily budget (the job cap of ${usd(topeUsd)} exceeds the daily limit of ${usd(limite)} on its own)`;
  return `Blocked by the daily budget (${usd(gastado + reservado)} of ${usd(limite)} spent)`;
}

// What running jobs may still spend is a property of the process, not of a served project: every budget created
// with the same `compartido` sees the same reservations, each with its own limit.
export const crearReservas = () => ({ reservado: 0, instancias: new Set() });

export function crearPresupuesto({ limite, gasto, ahora = Date.now, compartido = crearReservas() }) {
  let gastado = 0;
  let leidoEn = null;
  let diaLeido = null;
  let extra = 0;
  let lecturas = 0;

  // The spend is re-read at most every 30 s and whenever the local day changes.
  function leer() {
    const t = ahora();
    const dia = diaLocal(t);
    if (leidoEn === null || t - leidoEn >= REFRESCO_MS || dia !== diaLeido) {
      gastado = Number(gasto()) || 0;
      extra = 0;
      leidoEn = t;
      lecturas++;
      diaLeido = dia;
    }
  }

  const estado = () => {
    leer();
    return { limite: limite() ?? null, gastado: gastado + extra, reservado: compartido.reservado };
  };

  const instancia = { invalidar: () => { leidoEn = null; } };
  compartido.instancias.add(instancia);

  return {
    estado,
    soltar: () => compartido.instancias.delete(instancia),
    cabe(topeUsd = 0) {
      const e = estado();
      return e.limite === null || e.gastado + e.reservado + topeUsd <= e.limite;
    },
    // The reservation counts as spent until the job ends; then its real cost replaces it. If the spend was re-read
    // while the job ran, that read may already hold part of its cost: adding it again would count it twice, so the
    // next call re-reads the disk instead.
    reservar(topeUsd = 0) {
      compartido.reservado += topeUsd;
      const lecturaAlReservar = lecturas;
      let liberada = false;
      return {
        liberar(costoReal = 0) {
          if (liberada) return;
          liberada = true;
          compartido.reservado = Math.max(0, compartido.reservado - topeUsd);
          if (lecturas === lecturaAlReservar) extra += Number(costoReal) || 0;
          else leidoEn = null;
          // Another project's budget cannot add this cost by itself: it re-reads the disk.
          for (const o of compartido.instancias) if (o !== instancia) o.invalidar();
        },
      };
    },
  };
}
