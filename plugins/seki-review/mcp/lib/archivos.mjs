// File helpers shared by the QA import, the guide writer and the tracker adapter.
import { fstatSync, readSync, unlinkSync } from 'node:fs';

export const MAX_ARCHIVO = 5 * 1024 * 1024;

export function quitar(ruta) {
  if (!ruta) return;
  try {
    unlinkSync(ruta);
  } catch { /* already gone */ }
}

// Reads an open descriptor fully with a hard cap: one descriptor serves the size check and the read, so the
// file cannot grow in between. Throws an Error whose `motivo` is 'no-regular' or 'grande'.
export function leerAcotado(fd, max = MAX_ARCHIVO) {
  const st = fstatSync(fd);
  const refuso = (motivo) => Object.assign(new Error(motivo), { motivo });
  if (!st.isFile()) throw refuso('no-regular');
  if (st.size > max) throw refuso('grande');
  const b = Buffer.alloc(Math.min(st.size, max) + 1);
  let n = 0;
  for (let k; n < b.length && (k = readSync(fd, b, n, b.length - n, n)) > 0;) n += k;
  if (n > max) throw refuso('grande');
  return { buf: b.subarray(0, n), st };
}
