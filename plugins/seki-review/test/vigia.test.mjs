import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escribirJson, leerJson, rutaInstantanea } from '../mcp/lib/cache.mjs';
import { detenerServidores, iniciarServidor } from '../mcp/lib/servidor-web.mjs';
import { ghJson } from '../mcp/lib/proceso.mjs';
import { crearSondeo, crearVigia } from '../mcp/lib/vigia.mjs';

const MIN = 60 * 1000;

const previo = { gh: process.env.SEKI_GH, config: process.env.SEKI_REVIEW_CONFIG };
afterEach(() => {
  for (const [k, v] of [['SEKI_GH', previo.gh], ['SEKI_REVIEW_CONFIG', previo.config]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
});
const temporales = [];
const temporal = (prefijo) => {
  const dir = mkdtempSync(join(tmpdir(), prefijo));
  temporales.push(dir);
  return dir;
};
// Held gh doubles are released and servers closed before the folders go, so a failed test cannot keep the file alive.
const sueltas = [];
after(async () => {
  for (const soltar of sueltas.splice(0)) soltar();
  await detenerServidores();
  for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Fake clock: timers fire only when the test advances time.
function relojFalso(inicio = Date.parse('2026-11-04T10:00:00Z')) {
  let t = inicio;
  let id = 0;
  const pendientes = new Map();
  return {
    ahora: () => t,
    programar: (fn, ms) => { const k = ++id; pendientes.set(k, { fn, en: t + ms }); return k; },
    cancelar: (k) => pendientes.delete(k),
    cuantos: () => pendientes.size,
    siguiente: () => [...pendientes.values()].map((x) => x.en - t).sort((a, b) => a - b)[0],
    async avanzar(ms) {
      t += ms;
      for (const [k, x] of [...pendientes]) if (x.en <= t) { pendientes.delete(k); await x.fn(); }
    },
  };
}
const diferido = () => { let ok; let falla; const promesa = new Promise((a, b) => { ok = a; falla = b; }); return { promesa, ok, falla }; };
const vacio = () => new Promise((ok) => setImmediate(ok));

function armar({ abierto = true, sondear = async () => [], refrescar = async () => {} } = {}) {
  const reloj = relojFalso();
  const v = crearVigia({ intervaloMs: 5 * MIN, sondear, refrescar, tableroAbierto: () => abierto, reloj });
  return { reloj, v };
}

test('no refresh while the dashboard is closed; the timer keeps running', async () => {
  let sondeos = 0;
  const { reloj, v } = armar({ abierto: false, sondear: async () => { sondeos++; return ['a']; } });
  v.iniciar();
  await reloj.avanzar(5 * MIN);
  assert.equal(sondeos, 0);
  assert.equal(reloj.cuantos(), 1);
  v.detener();
});

test('changed repos are passed to refrescar and the last check is recorded', async () => {
  const recibidos = [];
  const { reloj, v } = armar({ sondear: async () => ['a', 'b'], refrescar: async (r) => { recibidos.push(r); } });
  v.iniciar();
  assert.equal(v.estado().ultimo, null);
  await reloj.avanzar(5 * MIN);
  assert.deepEqual(recibidos, [['a', 'b']]);
  assert.equal(v.estado().ultimo, '2026-11-04T10:05:00.000Z');
  assert.equal(v.estado().error, null);
  v.detener();
});

test('an empty probe does not refresh', async () => {
  let llamadas = 0;
  const { reloj, v } = armar({ refrescar: async () => { llamadas++; } });
  v.iniciar();
  await reloj.avanzar(5 * MIN);
  assert.equal(llamadas, 0);
  assert.ok(v.estado().ultimo);
  v.detener();
});

test('errors double the delay up to 30 minutes and a success resets it', async () => {
  let falla = true;
  const { reloj, v } = armar({ sondear: async () => { if (falla) throw new Error('gh failed'); return []; } });
  const original = console.error;
  const logs = [];
  console.error = (m) => logs.push(m);
  try {
    v.iniciar();
    const esperados = [10, 20, 30, 30];
    let siguiente = 5 * MIN;
    for (const min of esperados) {
      await reloj.avanzar(siguiente);
      assert.equal(v.estado().siguienteMs, min * MIN);
      assert.equal(v.estado().error, 'gh failed');
      siguiente = min * MIN;
    }
    falla = false;
    await reloj.avanzar(siguiente);
    assert.equal(v.estado().siguienteMs, 5 * MIN);
    assert.equal(v.estado().error, null);
  } finally { console.error = original; v.detener(); }
  assert.ok(logs.every((l) => l.startsWith('[seki-review/vigia]')));
});

test('ocupado() is true during a cycle and a second timer does not start another', async () => {
  const d = diferido();
  let sondeos = 0;
  const { reloj, v } = armar({ sondear: async () => { sondeos++; await d.promesa; return []; } });
  v.iniciar();
  const avance = reloj.avanzar(5 * MIN);
  await vacio();
  assert.equal(v.ocupado(), true);
  assert.equal(sondeos, 1);
  d.ok();
  await avance;
  assert.equal(v.ocupado(), false);
  assert.equal(sondeos, 1);
  v.detener();
});

test('iniciar twice creates a single timer', () => {
  const { reloj, v } = armar();
  v.iniciar();
  v.iniciar();
  assert.equal(reloj.cuantos(), 1);
  v.detener();
  assert.equal(reloj.cuantos(), 0);
});

test('detener during an in-flight cycle: no rescheduling and the refresh result is ignored', async () => {
  const d = diferido();
  const { reloj, v } = armar({ sondear: async () => ['a'], refrescar: async () => { await d.promesa; } });
  v.iniciar();
  const avance = reloj.avanzar(5 * MIN);
  await vacio();
  assert.equal(v.ocupado(), true);
  v.detener();
  d.ok();
  await avance;
  assert.equal(reloj.cuantos(), 0);
  assert.equal(v.estado().ultimo, null);
});

test('detener during an in-flight cycle that then fails: no backoff, no log, no timer', async () => {
  const d = diferido();
  const { reloj, v } = armar({ sondear: async () => { await d.promesa; return []; } });
  const original = console.error;
  const logs = [];
  console.error = (m) => logs.push(m);
  try {
    v.iniciar();
    const avance = reloj.avanzar(5 * MIN);
    await vacio();
    v.detener();
    d.falla(new Error('late'));
    await avance;
  } finally { console.error = original; }
  assert.equal(reloj.cuantos(), 0);
  assert.equal(v.estado().error, null);
  assert.deepEqual(logs, []);
});

test('probe bound: snapshot time first, then the start of the last successful probe', async () => {
  let t = Date.parse('2026-11-04T10:00:00.789Z');
  const consultas = [];
  const sondeo = crearSondeo({
    owner: 'o', repos: ['r1', 'r2'], ahora: () => t,
    instantanea: () => '2026-11-04T09:00:00.123Z',
    gh: async (args) => { consultas.push(args); return args[3] === 'o/r1' && consultas.length <= 2 ? [{ number: 1 }] : []; },
  });
  assert.deepEqual(await sondeo.sondear(), ['r1']);
  assert.ok(consultas.every((a) => a[a.indexOf('--search') + 1] === 'updated:>=2026-11-04T09:00:00Z'));
  assert.equal(consultas[0].join(' '), 'pr list -R o/r1 --state all --search updated:>=2026-11-04T09:00:00Z --json number,updatedAt --limit 50');
  // The refresh of r1 had not been confirmed: the bound does not move.
  t += 5 * MIN;
  await sondeo.sondear();
  assert.ok(consultas.slice(2).every((a) => a[a.indexOf('--search') + 1] === 'updated:>=2026-11-04T09:00:00Z'));
  // Empty probe: the bound becomes that probe's start (not its end).
  const inicio = new Date(t).toISOString();
  assert.deepEqual(await sondeo.sondear(), []);
  t += 5 * MIN;
  consultas.length = 0;
  await sondeo.sondear();
  assert.equal(consultas[0][consultas[0].indexOf('--search') + 1], `updated:>=${inicio.replace(/\.\d{3}Z$/, 'Z')}`);
});

test('probe bound moves to the probe start after confirmar; without a snapshot every repo counts as changed', async () => {
  let t = Date.parse('2026-11-04T10:00:00Z');
  const consultas = [];
  const sondeo = crearSondeo({ owner: 'o', repos: ['r1', 'r2'], ahora: () => t, instantanea: () => null, gh: async (a) => { consultas.push(a); return [{ number: 1 }]; } });
  assert.deepEqual(await sondeo.sondear(), ['r1', 'r2']);
  assert.equal(consultas.length, 0);
  t += 7 * MIN; // the refresh took time; confirming uses the probe start
  sondeo.confirmar();
  await sondeo.sondear();
  assert.equal(consultas[0][consultas[0].indexOf('--search') + 1], 'updated:>=2026-11-04T10:00:00Z');
});

test('a gh failure for one repo fails the probe', async () => {
  const sondeo = crearSondeo({ owner: 'o', repos: ['r1', 'r2'], instantanea: () => '2026-11-04T09:00:00Z', gh: async (a) => { if (a[3] === 'o/r2') throw new Error('boom'); return []; } });
  await assert.rejects(sondeo.sondear(), /boom/);
});

// Server: real HTTP with a slow gh double (appends each call to a file, answers an empty list after a delay).
let n = 0;
// Fake gh answers after demoraMs or, with retener (true, or a substring of the arguments), only once the release file
// exists or its folder is gone.
async function servidor({ demoraMs = 0, retener = false, repos = ['r1'], cambiados = [], reloj } = {}) {
  const clave = `vig${++n}`;
  const dir = temporal('seki-vigia-');
  const salida = join(dir, 'salida');
  mkdirSync(join(salida, 'datos'), { recursive: true });
  const ruta = join(dir, 'proyectos.json');
  writeFileSync(ruta, JSON.stringify({ [clave]: { owner: 'o', salida, repos: Object.fromEntries(repos.map((r) => [r, { lineas: [{ portal: 'P', prod: 'main', pruebas: 'develop' }] }])) } }));
  process.env.SEKI_REVIEW_CONFIG = ruta;
  escribirJson(rutaInstantanea(salida), { proyecto: clave, generado: '2026-11-04T09:00:00.000Z', owner: 'o', prs: [], recientes: [] });
  const registro = join(dir, 'llamadas.txt');
  const suelta = join(dir, 'suelta');
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(registro)}, process.argv.slice(2).join(' ') + '\\n');
const a = process.argv.slice(2);
const cambiado = a.includes('--search') && !a.join(' ').includes('review-requested:') && ${JSON.stringify(cambiados)}.some((r) => a.includes('o/' + r));
const responder = () => process.stdout.write(cambiado ? '[{"number":1}]' : '[]');
const retener = ${JSON.stringify(retener)};
if (retener === true || (typeof retener === 'string' && a.join(' ').includes(retener))) { const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(suelta)}) || !fs.existsSync(${JSON.stringify(dir)})) { clearInterval(t); responder(); } }, 5); }
else setTimeout(responder, ${demoraMs});
`);
  chmodSync(gh, 0o755);
  process.env.SEKI_GH = gh;
  const { url } = await iniciarServidor({ proyecto: clave, puerto: 0, abrir: false, intervaloVigiaMs: 60, relojVigia: reloj });
  const u = new URL(url);
  const token = u.searchParams.get('t');
  const llamar = (ruta, { metodo = 'GET', cabeceras = {} } = {}) => fetch(`${u.origin}${ruta}`, { method: metodo, headers: { 'x-seki-token': token, ...cabeceras } });
  const llamadas = () => (existsSync(registro) ? readFileSync(registro, 'utf8').split('\n').filter(Boolean) : []);
  const soltar = () => { if (existsSync(dir)) writeFileSync(suelta, ''); };
  sueltas.push(soltar);
  return { llamar, llamadas, soltar, salida };
}
const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms));
// The deadline only turns a missing event into a failure instead of a hang; it is generous so load cannot trip it.
const esperar = async (cond, ms = 30_000) => { const fin = Date.now() + ms; while (!(await cond())) { if (Date.now() > fin) throw new Error('timeout'); await pausa(10); } };

test('server: only the dashboard marker opens the window; ceder is refused while a probe runs; nothing runs after ceder', async () => {
  const reloj = relojFalso();
  const { llamar, llamadas, soltar } = await servidor({ retener: true, reloj });
  assert.equal(reloj.cuantos(), 1);
  assert.equal((await llamar('/api/estado')).status, 200);
  // The cycle runs to completion inside avanzar: without the marker it never reaches the probe.
  await reloj.avanzar(60);
  assert.equal(llamadas().length, 0, 'a request without the marker must not start the watcher');
  assert.equal(reloj.cuantos(), 1);
  const e = await (await llamar('/api/estado', { cabeceras: { 'x-seki-tablero': '1' } })).json();
  assert.equal(e.vigia.ultimo, null);
  const ciclo = reloj.avanzar(60);
  await esperar(() => llamadas().length === 1);
  assert.equal((await llamar('/api/ceder', { metodo: 'POST' })).status, 409);
  // Once the held probe answers, the cycle ends and the port can be handed over.
  soltar();
  await ciclo;
  assert.equal(reloj.cuantos(), 1);
  assert.equal((await llamar('/api/ceder', { metodo: 'POST' })).status, 200);
  assert.equal(reloj.cuantos(), 0, 'ceder must clear the watcher timer');
  await reloj.avanzar(60 * MIN);
  assert.equal(llamadas().length, 1);
});

test('server: a manual refresh during a watcher partial refresh is followed by a full refresh', async () => {
  const reloj = relojFalso();
  const { llamar, llamadas, soltar } = await servidor({ retener: 'repos/o/r1/pulls', repos: ['r1', 'r2'], cambiados: ['r1'], reloj });
  const marca = { 'x-seki-tablero': '1' };
  const pulls = (r) => llamadas().filter((l) => l.includes(`repos/o/${r}/pulls`));
  await llamar('/api/estado', { cabeceras: marca });
  // The partial refresh (r1 only) is held inside gh when the manual one arrives.
  const ciclo = reloj.avanzar(60);
  await esperar(() => pulls('r1').length > 0);
  assert.equal(pulls('r2').length, 0);
  assert.equal((await llamar('/api/refrescar', { metodo: 'POST' })).status, 202);
  assert.equal((await (await llamar('/api/estado')).json()).refrescando, true);
  soltar();
  await ciclo;
  await esperar(() => pulls('r2').length > 0);
  // The fake clock starts no further cycle, so once the chained full refresh ends the port can be handed over.
  await esperar(async () => !(await (await llamar('/api/estado')).json()).refrescando);
  assert.equal((await llamar('/api/ceder', { metodo: 'POST' })).status, 200);
});

test('server: detenerServidores resolves only after the watcher cycle and its refresh have finished', async () => {
  const reloj = relojFalso();
  const { llamar, llamadas, soltar, salida } = await servidor({ retener: 'repos/o/r1/pulls', cambiados: ['r1'], reloj });
  await llamar('/api/estado', { cabeceras: { 'x-seki-tablero': '1' } });
  const ciclo = reloj.avanzar(60);
  await esperar(() => llamadas().some((l) => l.includes('repos/o/r1/pulls')));
  let resuelto = false;
  const parada = detenerServidores().then(() => { resuelto = true; });
  // The refresh is held inside gh, so nothing that waits for it can have resolved yet.
  await new Promise((ok) => setImmediate(ok));
  assert.equal(resuelto, false);
  soltar();
  await parada;
  assert.notEqual(leerJson(rutaInstantanea(salida)).generado, '2026-11-04T09:00:00.000Z', 'the refresh wrote its snapshot before the stop resolved');
  await ciclo;
});

// The process never exits on its own, so only the timeout can end it; the test timeout turns a regression into a failure.
test('gh helper: a timeout rejects a hung process and the probe passes its timeout', { timeout: 60_000 }, async () => {
  const dir = temporal('seki-vigia-gh-');
  const colgado = join(dir, 'gh');
  writeFileSync(colgado, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
  chmodSync(colgado, 0o755);
  process.env.SEKI_GH = colgado;
  await assert.rejects(ghJson(['pr', 'list'], { timeout: 150 }), { killed: true, signal: 'SIGTERM' });
  const opciones = [];
  const sondeo = crearSondeo({ owner: 'o', repos: ['r'], instantanea: () => '2026-11-04T09:00:00Z', gh: async (a, o) => { opciones.push(o); return []; } });
  await sondeo.sondear();
  assert.deepEqual(opciones, [{ timeout: 60000 }]);
});
