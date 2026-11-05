import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escribirJson, rutaDiff, rutaInstantanea, rutaUltra } from '../mcp/lib/cache.mjs';
import { registrarCosto } from '../mcp/lib/ia.mjs';
import { proyecto as cargarProyecto } from '../mcp/lib/config.mjs';
import herramienta from '../mcp/tools/pr_ultra.mjs';

const temporales = [];
after(() => { for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true }); });
const SHA = 'a'.repeat(40);

let n = 0;
function entorno(ia) {
  const clave = `pu${++n}`;
  const dir = mkdtempSync(join(tmpdir(), 'seki-pr-ultra-'));
  temporales.push(dir);
  const salida = join(dir, 'salida');
  mkdirSync(salida, { recursive: true });
  const ruta = join(dir, 'proyectos.json');
  writeFileSync(ruta, JSON.stringify({ [clave]: { owner: 'o', salida, repos: {}, ...(ia ? { ia } : {}) } }));
  process.env.SEKI_REVIEW_CONFIG = ruta;
  const pr = { id: 'r#1', repo: 'r', numero: 1, titulo: 'T', headSha: SHA, estadoPr: 'OPEN' };
  escribirJson(rutaInstantanea(salida), { proyecto: clave, generado: new Date().toISOString(), owner: 'o', prs: [pr], recientes: [] });
  return { clave, p: cargarProyecto(clave), salida };
}

test('pr_ultra is read-only, declares its inputs and needs a PR from the snapshot', async () => {
  assert.equal(herramienta.name, 'pr_ultra');
  assert.deepEqual(herramienta.inputSchema.required, ['repo', 'numero']);
  const e = entorno();
  await assert.rejects(() => herramienta.handler({ proyecto: e.clave, repo: 'r', numero: 9 }), /snapshot/);
  await assert.rejects(() => herramienta.handler({ proyecto: e.clave, repo: 'r', numero: '1' }), /positive integer/);
});

test('pr_ultra returns the estimate from the caps, the mode, the link and no result', async () => {
  const e = entorno({ modo: 'ahorro', presupuestoDiarioUsd: 10 });
  const r = await herramienta.handler({ proyecto: e.clave, repo: 'r', numero: 1 });
  assert.equal(r.estimacion.usd, 5.5);
  assert.equal(r.estimacion.base, 'topes');
  assert.equal(r.resultado, null);
  assert.equal(r.sugerida, false);
  assert.equal(r.modo, 'ahorro');
  assert.equal(r.disponible, false);
  assert.equal(r.presupuesto.limite, 10);
  assert.equal(r.enlace, '#/pr/r/1?ultra=1');
});

test('pr_ultra uses earlier reviews for the estimate, flags sensitive paths and returns the stored result', async () => {
  const e = entorno({ rutasSensibles: ['auth/'] });
  for (const c of [2, 3, 4]) registrarCosto(e.p, { tipo: 'revisar_ultra', modo: 'ultra', prId: 'r#1', costo: c, ok: true });
  escribirJson(rutaDiff(e.salida, 'r', 1), { headSha: SHA, archivos: [{ filename: 'src/auth/x.ts', status: 'modified' }] });
  escribirJson(rutaUltra(e.salida, 'r', 1), { headSha: 'b'.repeat(40), hallazgos: [{ titulo: 'x' }] });
  const r = await herramienta.handler({ proyecto: e.clave, repo: 'r', numero: 1 });
  assert.deepEqual([r.estimacion.usd, r.estimacion.base, r.estimacion.muestras], [3, 'historial', 3]);
  assert.equal(r.sugerida, true);
  assert.equal(r.disponible, true);
  assert.equal(r.resultado.desactualizada, true);
  assert.equal(r.resultado.hallazgos.length, 1);
});

test('pr_ultra ignores a cached diff of another commit when it looks for sensitive paths', async () => {
  const e = entorno({ rutasSensibles: ['auth/'] });
  escribirJson(rutaDiff(e.salida, 'r', 1), { headSha: 'c'.repeat(40), archivos: [{ filename: 'src/auth/x.ts', status: 'modified' }] });
  const r = await herramienta.handler({ proyecto: e.clave, repo: 'r', numero: 1 });
  assert.equal(r.sugerida, false);
  assert.equal(r.topeUsd, 5.5);
});
