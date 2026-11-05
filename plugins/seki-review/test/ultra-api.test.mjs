import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escribirJson, rutaDiff, rutaExplicacion, rutaInstantanea, rutaUltra } from '../mcp/lib/cache.mjs';
import { proyecto as cargarProyecto } from '../mcp/lib/config.mjs';
import { detenerServidores, iniciarServidor } from '../mcp/lib/servidor-web.mjs';

after(detenerServidores);
const temporales = [];
after(() => { for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true }); });

const SHA = 'a'.repeat(40);
const pr = (numero, extra = {}) => ({ id: `r#${numero}`, repo: 'r', numero, titulo: `Change ${numero}`, url: 'https://example.test', base: 'main', rama: `f${numero}`, portal: 'P', ambiente: 'prod', estadoPr: 'OPEN', headSha: SHA, mergeada: null, creada: new Date().toISOString(), body: '', ...extra });

let n = 0;
async function entorno({ ia, prs = [pr(1), pr(2)] } = {}) {
  const clave = `ua${++n}`;
  const dir = mkdtempSync(join(tmpdir(), 'seki-ultra-api-'));
  temporales.push(dir);
  const salida = join(dir, 'salida');
  mkdirSync(join(salida, 'datos'), { recursive: true });
  const ruta = join(dir, 'proyectos.json');
  writeFileSync(ruta, JSON.stringify({ [clave]: { owner: 'o', salida, repos: { r: { lineas: [{ portal: 'P', prod: 'main', pruebas: 'develop' }] } }, ...(ia ? { ia } : {}) } }));
  process.env.SEKI_REVIEW_CONFIG = ruta;
  const p = cargarProyecto(clave);
  escribirJson(rutaInstantanea(salida), { proyecto: clave, generado: new Date().toISOString(), owner: 'o', prs, recientes: [] });
  const { url } = await iniciarServidor({ proyecto: clave, puerto: 0, abrir: false });
  const u = new URL(url);
  const token = u.searchParams.get('t');
  const llamar = (r, cuerpo) => fetch(`${u.origin}${r}`, { method: cuerpo === undefined ? 'GET' : 'POST', headers: { 'x-seki-token': token, 'content-type': 'application/json' }, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  return { p, llamar, cerrar: () => llamar('/api/ceder', {}) };
}

test('GET /api/estado exposes the budget and the project mode', async (t) => {
  const e = await entorno({ ia: { modo: 'ahorro', presupuestoDiarioUsd: 10 } });
  t.after(e.cerrar);
  const d = await (await e.llamar('/api/estado')).json();
  assert.equal(d.modo, 'ahorro');
  assert.equal(d.presupuesto.limite, 10);
});

test('GET /api/ultra returns the estimate, the suggestion and the stored result', async (t) => {
  const e = await entorno({ ia: { rutasSensibles: ['auth/'] } });
  t.after(e.cerrar);
  escribirJson(rutaDiff(e.p.salida, 'r', 1), { headSha: SHA, archivos: [{ filename: 'src/auth/login.ts', status: 'modified', additions: 1, deletions: 0 }] });
  escribirJson(rutaUltra(e.p.salida, 'r', 1), { headSha: 'b'.repeat(40), hallazgos: [] });
  const d = await (await e.llamar('/api/ultra?repo=r&numero=1')).json();
  assert.equal(d.estimacion.base, 'topes');
  assert.equal(d.estimacion.usd, 5.5);
  assert.equal(d.sugerida, true);
  assert.equal(d.resultado.desactualizada, true);
  const otra = await (await e.llamar('/api/ultra?repo=r&numero=2')).json();
  assert.equal(otra.sugerida, false);
  assert.equal(otra.resultado, null);
  assert.equal((await e.llamar('/api/ultra?repo=r&numero=99')).status, 404);
});

test('POST /api/ultra enqueues one Ultra job and refuses ahorro, unknown PRs and repeated requests', async (t) => {
  const e = await entorno({ ia: { presupuestoDiarioUsd: 1 } });
  t.after(e.cerrar);
  assert.equal((await e.llamar('/api/ultra', { repo: 'r', numero: 99 })).status, 409);
  assert.equal((await e.llamar('/api/ultra', { repo: 'r', numero: 1, modo: 'ahorro' })).status, 409);
  // The estimate ($5.50) does not fit in the $1 budget: the job waits as blocked.
  assert.equal((await e.llamar('/api/ultra', { repo: 'r', numero: 1 })).status, 202);
  assert.equal((await e.llamar('/api/ultra', { repo: 'r', numero: 1 })).status, 409);
  const t1 = (await (await e.llamar('/api/estado')).json()).trabajos.find((x) => x.tipo === 'revisar_ultra');
  assert.equal(t1.estado, 'bloqueado_presupuesto');
  assert.match(t1.mensaje, /Blocked by the daily budget/);
});

test('a project in ahorro refuses Ultra unless the request picks another mode', async (t) => {
  const e = await entorno({ ia: { modo: 'ahorro' } });
  t.after(e.cerrar);
  assert.equal((await e.llamar('/api/ultra', { repo: 'r', numero: 1 })).status, 409);
  assert.equal((await e.llamar('/api/ultra', { repo: 'r', numero: 1, modo: 'ultra' })).status, 202);
});

test('POST /api/trabajos/forzar runs a blocked job once and answers 404 for anything else', async (t) => {
  const e = await entorno({ ia: { presupuestoDiarioUsd: 1 } });
  t.after(e.cerrar);
  await e.llamar('/api/ultra', { repo: 'r', numero: 1 });
  assert.equal((await e.llamar('/api/trabajos/forzar', { id: 'r#2:ultra' })).status, 404);
  assert.equal((await e.llamar('/api/trabajos/forzar', {})).status, 404);
  assert.equal((await e.llamar('/api/trabajos/forzar', { id: 'r#1:ultra' })).status, 200);
  const t1 = (await (await e.llamar('/api/estado')).json()).trabajos.find((x) => x.id === 'r#1:ultra');
  assert.notEqual(t1.estado, 'bloqueado_presupuesto');
});

test('saving mode does not enqueue an explanation that already covers the current commit, unless completing', async (t) => {
  const e = await entorno({ ia: { presupuestoDiarioUsd: 0.01 } });
  t.after(e.cerrar);
  escribirJson(rutaExplicacion(e.p.salida, 'r', 1), { headSha: SHA, resumen: 'x' });
  const pedido = { prs: [{ repo: 'r', numero: 1 }, { repo: 'r', numero: 2 }] };
  const a = await (await e.llamar('/api/analizar', { ...pedido, modo: 'ahorro' })).json();
  assert.deepEqual([a.encolados, a.reutilizados], [1, 1]);
  const b = await (await e.llamar('/api/analizar', { ...pedido, modo: 'ahorro', completar: true })).json();
  assert.equal(b.reutilizados, 0);
  const c = await (await e.llamar('/api/analizar', { prs: [{ repo: 'r', numero: 1 }], modo: 'normal' })).json();
  assert.equal(c.reutilizados, 0);
});

test('POST /api/filtrar answers 429 with the retry flag when the budget does not fit', async (t) => {
  const e = await entorno({ ia: { presupuestoDiarioUsd: 0.01 } });
  t.after(e.cerrar);
  const r = await e.llamar('/api/filtrar', { consulta: 'security', modo: 'ahorro' });
  assert.equal(r.status, 429);
  const d = await r.json();
  assert.equal(d.forzar, true);
  assert.match(d.error, /daily budget/);
});
