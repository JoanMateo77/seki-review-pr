import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estadoServidor, tokenDe } from '../mcp/lib/acceso.mjs';
import { detenerServidores, esMasNueva, iniciarServidor } from '../mcp/lib/servidor-web.mjs';
import { versionEnDisco } from '../mcp/lib/tablero.mjs';

process.env.SEKI_VIGILANCIA_MS = '100';
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const estadoEn = async (puerto, token) => (await fetch(`http://127.0.0.1:${puerto}/api/estado`, { headers: { 'x-seki-token': token } })).json();
// Whatever a failed test leaves serving or on standby is closed here, so the file always exits.
after(detenerServidores);

// Both wait for a condition, not for a fixed time: the standby takes over on its own schedule. The deadline only turns
// a broken take-over into a failure instead of a hang.
async function hasta(cond) {
  const fin = Date.now() + 30_000;
  while (!cond()) {
    if (Date.now() > fin) throw new Error('the condition was not met');
    await espera(10);
  }
}
async function hastaQueSirvaLaReal(puerto, token) {
  const fin = Date.now() + 30_000;
  let e = null;
  while (!(e && !e.falso)) {
    if (Date.now() > fin) throw new Error('the standby session did not take over the port');
    await espera(50);
    e = await estadoEn(puerto, token).catch(() => null);
  }
  return e;
}

// Each test uses its own project: the real server remembers the ones it already serves in this process.
let n = 0;
function proyecto() {
  const clave = `p${++n}`;
  const salida = mkdtempSync(join(tmpdir(), 'seki-ceder-'));
  const ruta = join(salida, 'proyectos.json');
  writeFileSync(ruta, JSON.stringify({ [clave]: { salida, repos: {} } }));
  process.env.SEKI_REVIEW_CONFIG = ruta;
  return { clave, token: tokenDe({ clave, salida }) };
}

// Another session's dashboard: replies with its state and, if it knows how, releases the port when asked.
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

test('a different, idle version hands over the port and the new session serves on the same link', async () => {
  const { clave, token } = proyecto();
  const { s, puerto } = await otraSesion({ token, version: '0.1.0' });
  const r = await iniciarServidor({ proyecto: clave, puerto, abrir: false });
  assert.equal(r.yaEstaba, false);
  assert.equal(r.url, `http://127.0.0.1:${puerto}/?t=${token}`);
  assert.equal(s.listening, false);
  const e = await (await fetch(`http://127.0.0.1:${puerto}/api/estado`, { headers: { 'x-seki-token': token } })).json();
  assert.notEqual(e.version, '0.1.0');
  // The new dashboard can also hand over: that is how it is closed at the end of the test.
  assert.equal((await fetch(`http://127.0.0.1:${puerto}/api/ceder`, { method: 'POST', headers: { 'x-seki-token': token } })).status, 200);
});

test('with jobs in progress the port is not requested and a notice is given', async () => {
  const { clave, token } = proyecto();
  const { s, puerto } = await otraSesion({ token, version: '0.1.0', trabajos: [{ estado: 'en_curso' }] });
  const r = await iniciarServidor({ proyecto: clave, puerto, abrir: false });
  assert.equal(r.yaEstaba, true);
  assert.match(r.aviso, /jobs in progress/);
  assert.equal(s.listening, true);
  s.close();
  s.closeAllConnections();
  await hastaQueSirvaLaReal(puerto, token);
});

test('an older version that cannot hand over keeps serving and the notice says what to do', async () => {
  const { clave, token } = proyecto();
  const { s, puerto } = await otraSesion({ token, version: undefined, sabeCeder: false });
  const r = await iniciarServidor({ proyecto: clave, puerto, abrir: false });
  assert.equal(r.yaEstaba, true);
  assert.match(r.aviso, /close or restart that session/);
  s.close();
  s.closeAllConnections();
  await hastaQueSirvaLaReal(puerto, token);
});

test('esMasNueva compares numerically and no version counts as the oldest', () => {
  assert.equal(esMasNueva('0.19.10', '0.19.9'), true);
  assert.equal(esMasNueva('0.19.2', '0.19.2'), false);
  assert.equal(esMasNueva('0.19.2', undefined), true);
  assert.equal(esMasNueva('0.18.0', '0.19.0'), false);
});

test('an older session does not take the dashboard from a newer one', async () => {
  const { clave, token } = proyecto();
  const { s, puerto } = await otraSesion({ token, version: '99.0.0' });
  const r = await iniciarServidor({ proyecto: clave, puerto, abrir: false });
  assert.equal(r.yaEstaba, true);
  assert.equal(r.aviso, null);
  assert.equal(s.listening, true);
  s.close();
  s.closeAllConnections();
  await hastaQueSirvaLaReal(puerto, token);
});

test('if the session serving the dashboard closes, the standby one takes it on the same link', async () => {
  const { clave, token } = proyecto();
  const { s, puerto } = await otraSesion({ token, version: versionEnDisco() });
  const r = await iniciarServidor({ proyecto: clave, puerto, abrir: false });
  assert.equal(r.yaEstaba, true);
  assert.equal((await estadoEn(puerto, token)).falso, true);
  s.close();
  s.closeAllConnections();
  const e = await hastaQueSirvaLaReal(puerto, token);
  assert.equal(e.version, versionEnDisco());
});

test('detenerServidores closes the dashboards and stops the standby watchers', async (t) => {
  const servida = proyecto();
  const { url } = await iniciarServidor({ proyecto: servida.clave, puerto: 0, abrir: false });
  const puertoServido = Number(new URL(url).port);
  const enEspera = proyecto();
  const { s, puerto } = await otraSesion({ token: enEspera.token, version: '99.0.0' });
  // Spies keep the real timers: the check is that the standby's interval is cleared, not that it stays quiet for a while.
  const inicio = t.mock.method(globalThis, 'setInterval');
  const fin = t.mock.method(globalThis, 'clearInterval');
  assert.equal((await iniciarServidor({ proyecto: enEspera.clave, puerto, abrir: false })).yaEstaba, true);
  assert.equal(inicio.mock.callCount(), 1);
  const reloj = inicio.mock.calls[0].result;
  await detenerServidores();
  assert.ok(fin.mock.calls.some((c) => c.arguments[0] === reloj), 'the standby watcher interval must be cleared');
  assert.equal(await estadoServidor(puertoServido, servida.token), null);
  await new Promise((ok) => { s.close(ok); s.closeAllConnections(); });
  await hasta(() => !process.getActiveResourcesInfo().includes('TCPServerWrap'));
});
