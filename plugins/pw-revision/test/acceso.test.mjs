import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { servidorActivo, tokenDe } from '../mcp/lib/acceso.mjs';

const p = () => ({ clave: 'x', salida: mkdtempSync(join(tmpdir(), 'pw-acceso-')) });

test('tokenDe es el mismo entre arranques y queda solo legible por el dueño', () => {
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

test('servidorActivo reconoce un tablero que acepta el mismo token', async () => {
  const { s, puerto } = await falso((req) => (req.headers['x-pw-token'] === 'tok' ? 200 : 403));
  assert.equal(await servidorActivo(puerto, 'tok'), true);
  assert.equal(await servidorActivo(puerto, 'otro'), false);
  s.close();
});

test('servidorActivo da false si no hay nada escuchando', async () => {
  const { s, puerto } = await falso(() => 200);
  await new Promise((ok) => s.close(ok));
  assert.equal(await servidorActivo(puerto, 'tok'), false);
});
