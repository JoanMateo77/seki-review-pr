// Token of the served dashboard, fixed per project and machine so the link does not change between sessions.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { conBloqueoSync } from './bloqueo.mjs';

const pausa = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Value stored once per project and machine. The first creation is exclusive ('wx', mode 0600): concurrent processes
// agree on the winner's bytes. `leer(buffer)` returns the value or null when the file content is invalid.
function valorUnico(ruta, bytesNuevos, leer) {
  const valido = () => {
    try { return leer(readFileSync(ruta)); } catch { return null; }
  };
  const existente = valido();
  if (existente !== null) return existente;
  mkdirSync(dirname(ruta), { recursive: true });
  const nuevo = bytesNuevos();
  try {
    writeFileSync(ruta, nuevo, { flag: 'wx', mode: 0o600 });
    return leer(nuevo);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  // Another process may still be writing it; only a file that stays invalid is replaced.
  for (let i = 0; i < 10; i++) {
    const v = valido();
    if (v !== null) return v;
    pausa(10);
  }
  return conBloqueoSync(ruta, () => {
    const v = valido();
    if (v !== null) return v;
    const tmp = `${ruta}.${process.pid}.tmp`;
    writeFileSync(tmp, nuevo, { mode: 0o600 });
    renameSync(tmp, ruta);
    chmodSync(ruta, 0o600);
    return leer(nuevo);
  });
}

export const tokenDe = (p) => valorUnico(
  join(p.salida, 'datos', 'token'),
  () => Buffer.from(`${randomBytes(18).toString('base64url')}\n`),
  (b) => {
    const t = b.toString('utf8').trim();
    return /^[A-Za-z0-9_-]{24}$/.test(t) ? t : null;
  },
);

// Secret of the QA guide signatures: 32 random bytes.
export const secretoQa = (p) => valorUnico(
  join(p.salida, 'datos', 'secreto-qa'),
  () => randomBytes(32),
  (b) => (b.length === 32 ? b : null),
);

// Another Claude Code session may already be serving the same dashboard on the port.
// State of the dashboard already listening on the port with the same token, or null if there is none.
export const estadoServidor = (puerto, token) => new Promise((ok) => {
  const req = request({ host: '127.0.0.1', port: puerto, path: '/api/estado', headers: { 'x-seki-token': token }, timeout: 1500 }, (res) => {
    let cuerpo = '';
    res.on('data', (d) => { cuerpo += d; });
    res.on('end', () => {
      if (res.statusCode !== 200) return ok(null);
      try { ok(JSON.parse(cuerpo)); } catch { ok({}); }
    });
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => ok(null));
  req.end();
});

export const servidorActivo = async (puerto, token) => (await estadoServidor(puerto, token)) !== null;

// Asks another session's dashboard to release the port; returns whether it did (versions before 0.19.2 cannot).
export const pedirCeder = (puerto, token) => new Promise((ok) => {
  const req = request({ host: '127.0.0.1', port: puerto, path: '/api/ceder', method: 'POST', headers: { 'x-seki-token': token, 'content-type': 'application/json' }, timeout: 3000 }, (res) => {
    res.resume();
    ok(res.statusCode === 200);
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => ok(false));
  req.end('{}');
});
