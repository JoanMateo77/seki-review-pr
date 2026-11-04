import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secretoQa, servidorActivo, tokenDe } from '../mcp/lib/acceso.mjs';

const p = () => ({ clave: 'x', salida: mkdtempSync(join(tmpdir(), 'seki-acceso-')) });

test('tokenDe is the same across restarts and readable only by the owner', () => {
  const pr = p();
  const a = tokenDe(pr);
  assert.match(a, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(tokenDe(pr), a);
  assert.equal(statSync(join(pr.salida, 'datos', 'token')).mode & 0o777, 0o600);
});

async function falso(responde) {
  const s = createServer((req, res) => { res.writeHead(responde(req)); res.end('{}'); });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  return { s, puerto: s.address().port };
}

test('servidorActivo recognizes a dashboard that accepts the same token', async () => {
  const { s, puerto } = await falso((req) => (req.headers['x-seki-token'] === 'tok' ? 200 : 403));
  assert.equal(await servidorActivo(puerto, 'tok'), true);
  assert.equal(await servidorActivo(puerto, 'otro'), false);
  s.close();
});

test('servidorActivo returns false when nothing is listening', async () => {
  const { s, puerto } = await falso(() => 200);
  await new Promise((ok) => s.close(ok));
  assert.equal(await servidorActivo(puerto, 'tok'), false);
});

test('secretoQa is 32 bytes, stable across calls and readable only by the owner', () => {
  const pr = p();
  const a = secretoQa(pr);
  assert.equal(a.length, 32);
  assert.deepEqual(secretoQa(pr), a);
  assert.equal(statSync(join(pr.salida, 'datos', 'secreto-qa')).mode & 0o777, 0o600);
});

test('concurrent first creations of the token agree and an invalid file is replaced', async () => {
  const salida = mkdtempSync(join(tmpdir(), 'seki-acceso-'));
  const url = new URL('../mcp/lib/acceso.mjs', import.meta.url).href;
  const codigo = `import('${url}').then((m) => process.stdout.write(m.tokenDe({ salida: ${JSON.stringify(salida)} })))`;
  const lanzar = () => new Promise((ok, no) => execFile(process.execPath, ['-e', codigo], (e, out) => (e ? no(e) : ok(out))));
  const [a, b, c] = await Promise.all([lanzar(), lanzar(), lanzar()]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.match(a, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(tokenDe({ salida }), a);

  const otra = p();
  mkdirSync(join(otra.salida, 'datos'));
  writeFileSync(join(otra.salida, 'datos', 'token'), 'corto');
  const t = tokenDe(otra);
  assert.match(t, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(tokenDe(otra), t);
  assert.equal(statSync(join(otra.salida, 'datos', 'token')).mode & 0o777, 0o600);
});
