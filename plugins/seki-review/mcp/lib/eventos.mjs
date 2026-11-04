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

export function leerEventos(p, { desde } = {}) {
  const ruta = rutaEventos(p.salida);
  if (!existsSync(ruta)) return [];
  const eventos = analizar(readFileSync(ruta, 'utf8'), ruta);
  return eventos.filter((e) => !desde || e.ts > desde).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
}

// Reads the ids already stored and appends only the new ones, all under one lock.
export async function registrarEventos(p, eventos) {
  const ruta = rutaEventos(p.salida);
  return conBloqueo(ruta, () => {
    const existe = existsSync(ruta);
    const conocidos = new Set(existe ? analizar(readFileSync(ruta, 'utf8'), ruta, false).map((e) => e.id) : []);
    const nuevos = [];
    for (const e of eventos) {
      if (conocidos.has(e.id)) continue;
      conocidos.add(e.id);
      nuevos.push(e);
    }
    if (!nuevos.length) return 0;
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
    return nuevos.length;
  });
}
