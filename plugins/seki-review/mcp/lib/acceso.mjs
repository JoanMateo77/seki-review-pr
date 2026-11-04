// Token of the served dashboard, fixed per project and machine so the link does not change between sessions.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { conBloqueoSync } from './bloqueo.mjs';

export function tokenDe(p) {
  const ruta = join(p.salida, 'datos', 'token');
  if (existsSync(ruta)) {
    const guardado = readFileSync(ruta, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{24}$/.test(guardado)) return guardado;
  }
  mkdirSync(join(p.salida, 'datos'), { recursive: true });
  const token = randomBytes(18).toString('base64url');
  writeFileSync(ruta, `${token}\n`, { mode: 0o600 });
  chmodSync(ruta, 0o600);
  return token;
}

// Secret of the QA guide signatures: 32 random bytes, created once per project and machine.
// The first creation is exclusive ('wx'): concurrent processes agree on the winner's bytes.
const pausa = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function secretoQa(p) {
  const ruta = join(p.salida, 'datos', 'secreto-qa');
  const valido = () => {
    try {
      const b = readFileSync(ruta);
      return b.length === 32 ? b : null;
    } catch { return null; }
  };
  const existente = valido();
  if (existente) return existente;
  mkdirSync(join(p.salida, 'datos'), { recursive: true });
  const nuevo = randomBytes(32);
  try {
    writeFileSync(ruta, nuevo, { flag: 'wx', mode: 0o600 });
    return nuevo;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  // Another process may still be writing it; only a file that stays invalid is replaced.
  for (let i = 0; i < 10; i++) {
    const b = valido();
    if (b) return b;
    pausa(10);
  }
  return conBloqueoSync(ruta, () => {
    const b = valido();
    if (b) return b;
    const tmp = `${ruta}.${process.pid}.tmp`;
    writeFileSync(tmp, nuevo, { mode: 0o600 });
    renameSync(tmp, ruta);
    chmodSync(ruta, 0o600);
    return nuevo;
  });
}

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
