import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenDe } from '../mcp/lib/acceso.mjs';
import { esMasNueva, iniciarServidor } from '../mcp/lib/servidor-web.mjs';
import { versionEnDisco } from '../mcp/lib/tablero.mjs';

process.env.SEKI_VIGILANCIA_MS = '100';
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const estadoEn = async (puerto, token) => (await fetch(`http://127.0.0.1:${puerto}/api/estado`, { headers: { 'x-seki-token': token } })).json();
const cerrarReal = (puerto, token) => fetch(`http://127.0.0.1:${puerto}/api/ceder`, { method: 'POST', headers: { 'x-seki-token': token } });

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
    if (req.url === '/api/estado') { res.writeHead(200); return res.end(JSON.stringify({ version, refrescando: false, trabajos, falso: true })); }
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
  await espera(400);
  await cerrarReal(puerto, token);
});

test('una versión anterior que no sabe ceder sigue sirviendo y el aviso dice qué hacer', async () => {
  const { clave, token } = proyecto();
  const { s, puerto } = await otraSesion({ token, version: undefined, sabeCeder: false });
  const r = await iniciarServidor({ proyecto: clave, puerto, abrir: false });
  assert.equal(r.yaEstaba, true);
  assert.match(r.aviso, /cierre o reinicie esa sesión/);
  s.close();
  await espera(400);
  await cerrarReal(puerto, token);
});

test('esMasNueva compara por números y sin versión cuenta como la más vieja', () => {
  assert.equal(esMasNueva('0.19.10', '0.19.9'), true);
  assert.equal(esMasNueva('0.19.2', '0.19.2'), false);
  assert.equal(esMasNueva('0.19.2', undefined), true);
  assert.equal(esMasNueva('0.18.0', '0.19.0'), false);
});

test('una sesión vieja no le quita el tablero a una más nueva', async () => {
  const { clave, token } = proyecto();
  const { s, puerto } = await otraSesion({ token, version: '99.0.0' });
  const r = await iniciarServidor({ proyecto: clave, puerto, abrir: false });
  assert.equal(r.yaEstaba, true);
  assert.equal(r.aviso, null);
  assert.equal(s.listening, true);
  s.close();
  await espera(400);
  await cerrarReal(puerto, token);
});

test('si la sesión que sirve el tablero se cierra, la de reserva lo toma en el mismo enlace', async () => {
  const { clave, token } = proyecto();
  const { s, puerto } = await otraSesion({ token, version: versionEnDisco() });
  const r = await iniciarServidor({ proyecto: clave, puerto, abrir: false });
  assert.equal(r.yaEstaba, true);
  assert.equal((await estadoEn(puerto, token)).falso, true);
  s.close();
  s.closeAllConnections();
  let e = null;
  for (let i = 0; i < 30 && !(e && !e.falso); i++) { await espera(100); e = await estadoEn(puerto, token).catch(() => null); }
  assert.equal(e?.falso, undefined);
  assert.equal(e?.version, versionEnDisco());
  await cerrarReal(puerto, token);
});
