import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenDe } from '../mcp/lib/acceso.mjs';
import { iniciarServidor } from '../mcp/lib/servidor-web.mjs';

// Cada prueba usa su propio proyecto: el servidor real recuerda los que ya sirve en este proceso.
let n = 0;
function proyecto() {
  const clave = `p${++n}`;
  const salida = mkdtempSync(join(tmpdir(), 'seki-ceder-'));
  const ruta = join(salida, 'proyectos.json');
  writeFileSync(ruta, JSON.stringify({ [clave]: { salida, repos: {} } }));
  process.env.SEKI_REVIEW_CONFIG = ruta;
  return { clave, token: tokenDe({ clave, salida }) };
}

// Tablero de otra sesión: responde su estado y, si sabe, suelta el puerto al pedírselo.
async function otraSesion({ token, version, trabajos = [], sabeCeder = true }) {
  const s = createServer((req, res) => {
    if (req.headers['x-seki-token'] !== token) { res.writeHead(403); return res.end('{}'); }
    if (req.url === '/api/estado') { res.writeHead(200); return res.end(JSON.stringify({ version, refrescando: false, trabajos })); }
    if (req.url === '/api/ceder' && sabeCeder) { res.writeHead(200); res.end('{}'); s.close(); return s.closeAllConnections(); }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  return { s, puerto: s.address().port };
}

test('una versión distinta y libre cede el puerto y la nueva sesión sirve en el mismo enlace', async () => {
  const { clave, token } = proyecto();
  const { s, puerto } = await otraSesion({ token, version: '0.1.0' });
  const r = await iniciarServidor({ proyecto: clave, puerto, abrir: false });
  assert.equal(r.yaEstaba, false);
  assert.equal(r.url, `http://127.0.0.1:${puerto}/?t=${token}`);
  assert.equal(s.listening, false);
  const e = await (await fetch(`http://127.0.0.1:${puerto}/api/estado`, { headers: { 'x-seki-token': token } })).json();
  assert.notEqual(e.version, '0.1.0');
  // El tablero nuevo también sabe ceder: así se cierra al terminar la prueba.
  assert.equal((await fetch(`http://127.0.0.1:${puerto}/api/ceder`, { method: 'POST', headers: { 'x-seki-token': token } })).status, 200);
});

test('con trabajos en curso no se le pide el puerto y se avisa', async () => {
  const { clave, token } = proyecto();
  const { s, puerto } = await otraSesion({ token, version: '0.1.0', trabajos: [{ estado: 'en_curso' }] });
  const r = await iniciarServidor({ proyecto: clave, puerto, abrir: false });
  assert.equal(r.yaEstaba, true);
  assert.match(r.aviso, /trabajos en curso/);
  assert.equal(s.listening, true);
  s.close();
});

test('una versión anterior que no sabe ceder sigue sirviendo y el aviso dice qué hacer', async () => {
  const { clave, token } = proyecto();
  const { s, puerto } = await otraSesion({ token, version: undefined, sabeCeder: false });
  const r = await iniciarServidor({ proyecto: clave, puerto, abrir: false });
  assert.equal(r.yaEstaba, true);
  assert.match(r.aviso, /cierre o reinicie esa sesión/);
  s.close();
});
