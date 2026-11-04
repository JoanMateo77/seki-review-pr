import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { basename, dirname } from 'node:path';

// Paths held by this process (sync acquires cannot wait for them) and, per async context, by the running holder.
const retenidas = new Set();
const contexto = new AsyncLocalStorage();
const reentrada = (ruta) => new Error(`Lock already held by this process: ${basename(ruta)}`);

const OBSOLETO_MS = 30_000;
const REINTENTO_MS = 50;

function procesoVivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH'; // EPERM: the process exists
  }
}

// A lock is stale when it is older than 30 s and its owner is gone; an unreadable lock is judged by its mtime.
function esObsoleto(rutaLock, contenido) {
  let datos = null;
  try {
    datos = JSON.parse(contenido);
  } catch { /* corrupt */ }
  if (datos && Number.isFinite(datos.ts)) {
    return Date.now() - datos.ts > OBSOLETO_MS && !procesoVivo(datos.pid);
  }
  try {
    return Date.now() - statSync(rutaLock).mtimeMs > OBSOLETO_MS;
  } catch {
    return false;
  }
}

function leerLock(rutaLock) {
  try {
    return readFileSync(rutaLock, 'utf8');
  } catch {
    return null;
  }
}

// Take-overs are serialised by a guard file so that only one contender judges and removes a stale lock.
// A guard older than 30 s is stale; that window is safe because a guard is held for microseconds.
function retirarObsoleto(rutaLock, contenido) {
  const guarda = `${rutaLock}.takeover`;
  let fd;
  try {
    fd = openSync(guarda, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      if (Date.now() - statSync(guarda).mtimeMs > OBSOLETO_MS) unlinkSync(guarda);
    } catch { /* released meanwhile */ }
    return;
  }
  try {
    if (leerLock(rutaLock) === contenido) unlinkSync(rutaLock);
  } catch { /* already gone */ } finally {
    closeSync(fd);
    try {
      unlinkSync(guarda);
    } catch { /* already gone */ }
  }
}

// One attempt: returns the token that proves ownership, or null if the lock is held.
function intentar(rutaLock) {
  const token = JSON.stringify({ pid: process.pid, ts: Date.now(), n: randomBytes(4).toString('hex') });
  for (let vuelta = 0; vuelta < 2; vuelta++) {
    try {
      const fd = openSync(rutaLock, 'wx');
      try {
        writeFileSync(fd, token);
      } finally {
        closeSync(fd);
      }
      return token;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const contenido = leerLock(rutaLock);
    if (contenido === null) continue; // vanished between open and read: retry at once
    if (!esObsoleto(rutaLock, contenido)) return null;
    retirarObsoleto(rutaLock, contenido);
  }
  return null;
}

function liberar(rutaLock, token) {
  if (leerLock(rutaLock) !== token) return;
  try {
    unlinkSync(rutaLock);
  } catch { /* already gone */ }
}

const preparar = (ruta) => {
  mkdirSync(dirname(ruta), { recursive: true });
  return `${ruta}.lock`;
};
const ocupado = (ruta) => new Error(`Lock busy: ${basename(ruta)}`);

export function conBloqueoSync(ruta, fn, { esperaMs = 5000 } = {}) {
  if (retenidas.has(ruta)) throw reentrada(ruta);
  const rutaLock = preparar(ruta);
  const limite = Date.now() + esperaMs;
  const pausa = new Int32Array(new SharedArrayBuffer(4));
  let token;
  while (!(token = intentar(rutaLock))) {
    if (Date.now() >= limite) throw ocupado(ruta);
    Atomics.wait(pausa, 0, 0, REINTENTO_MS);
  }
  retenidas.add(ruta);
  try {
    return fn();
  } finally {
    retenidas.delete(ruta);
    liberar(rutaLock, token);
  }
}

export async function conBloqueo(ruta, fn, { esperaMs = 5000 } = {}) {
  const propias = contexto.getStore() ?? new Set();
  if (propias.has(ruta)) throw reentrada(ruta);
  const rutaLock = preparar(ruta);
  const limite = Date.now() + esperaMs;
  let token;
  while (!(token = intentar(rutaLock))) {
    if (Date.now() >= limite) throw ocupado(ruta);
    await new Promise((r) => setTimeout(r, REINTENTO_MS));
  }
  retenidas.add(ruta);
  try {
    return await contexto.run(new Set([...propias, ruta]), fn);
  } finally {
    retenidas.delete(ruta);
    liberar(rutaLock, token);
  }
}

export function escribirAtomico(ruta, texto) {
  const tmp = `${ruta}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, texto);
    renameSync(tmp, ruta);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch { /* never created */ }
    throw e;
  }
}

export function anexarLinea(ruta, linea) {
  return conBloqueo(ruta, () => appendFileSync(ruta, `${linea.replace(/\n+$/, '')}\n`));
}
