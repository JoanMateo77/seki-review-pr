// Append-only lifecycle history (eventos.jsonl): merges and closures derived from the snapshot.
import { appendFileSync, existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { conBloqueo } from './bloqueo.mjs';
import { rutaEventos } from './cache.mjs';

const huella = (tipo, pr, fecha) => createHash('sha256').update(`${tipo}|${pr}|${fecha}`).digest('hex');

// Pure. A re-merge of the same PR carries a new mergedAt and therefore a new id; the same data yields the same ids.
export function eventosDe(foto, entregas = []) {
  const claveDe = new Map();
  for (const e of entregas) for (const id of e.prs ?? []) claveDe.set(id, e.clave);
  const vistos = new Set();
  const salida = [];
  for (const pr of [...(foto?.prs ?? []), ...(foto?.recientes ?? [])]) {
    const candidatos = [];
    if (pr.mergeada) candidatos.push(['pr_mergeada', pr.mergeada]);
    else if (pr.estadoPr === 'CLOSED' && pr.cerrada) candidatos.push(['pr_cerrada', pr.cerrada]);
    for (const [tipo, fecha] of candidatos) {
      const id = huella(tipo, pr.id, fecha);
      if (vistos.has(id)) continue;
      vistos.add(id);
      salida.push({ id, ts: fecha, tipo, entrega: claveDe.get(pr.id) ?? null, pr: pr.id, ambiente: pr.ambiente, origen: 'github' });
    }
  }
  return salida.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
}

function analizar(texto, ruta, avisar = true) {
  const eventos = [];
  let omitidas = 0;
  for (const linea of texto.split('\n')) {
    if (!linea.trim()) continue;
    try {
      const e = JSON.parse(linea);
      if (e && typeof e === 'object' && typeof e.id === 'string') eventos.push(e);
      else omitidas++;
    } catch {
      omitidas++;
    }
  }
  if (omitidas && avisar) console.error(`[seki-review/eventos] ${omitidas} unreadable line(s) skipped in ${ruta}`);
  return eventos;
}

// `desde` compares against the time an event was stored, not its GitHub time: a merge made before the
// last visit but first seen after it is still news. Events stored before `registrado` existed fall back to ts.
const vistoEn = (e) => e.registrado ?? e.ts;
export function leerEventos(p, { desde } = {}) {
  const ruta = rutaEventos(p.salida);
  if (!existsSync(ruta)) return [];
  const eventos = analizar(readFileSync(ruta, 'utf8'), ruta);
  if (!desde) return eventos.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
  return eventos
    .filter((e) => vistoEn(e) > desde)
    .sort((a, b) => (vistoEn(a) < vistoEn(b) ? -1 : vistoEn(a) > vistoEn(b) ? 1 : a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
}

// Reads the ids already stored and appends only the new ones, all under one lock. Each stored event gets
// `registrado` (append time); the id does not include it, so registering the same data twice stays a no-op.
export async function registrarEventos(p, eventos, { ahora } = {}) {
  const ruta = rutaEventos(p.salida);
  return conBloqueo(ruta, () => {
    const existe = existsSync(ruta);
    const previos = existe ? analizar(readFileSync(ruta, 'utf8'), ruta, false) : [];
    const conocidos = new Set(previos.map((e) => e.id));
    const nuevos = [];
    const registrado = (ahora ?? new Date()).toISOString();
    for (const e of eventos) {
      if (conocidos.has(e.id)) continue;
      conocidos.add(e.id);
      nuevos.push({ ...e, registrado });
    }
    const ordenar = (l) => l.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
    if (!nuevos.length) return { nuevos: 0, todos: ordenar(previos) };
    // A crash mid-write can leave a last line without newline: start on a fresh line.
    let prefijo = '';
    if (existe && statSync(ruta).size > 0) {
      const fd = openSync(ruta, 'r');
      const b = Buffer.alloc(1);
      readSync(fd, b, 0, 1, statSync(ruta).size - 1);
      closeSync(fd);
      if (b[0] !== 10) prefijo = '\n';
    }
    appendFileSync(ruta, prefijo + nuevos.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return { nuevos: nuevos.length, todos: ordenar([...previos, ...nuevos]) };
  });
}
