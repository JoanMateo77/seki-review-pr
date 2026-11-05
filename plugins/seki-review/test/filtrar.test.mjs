import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escribirJson, rutaDiff } from '../mcp/lib/cache.mjs';
import { filtrarPrs, lineaDePr } from '../mcp/lib/filtrar.mjs';
import { falsoClaude, llamadas } from './util/claude.mjs';

const prs = [
  { id: 'api#1', repo: 'api', numero: 1, titulo: 'fix(seguridad): SQLi en la búsqueda', rama: 'fix/sqli', portal: 'Back', headSha: 'a1' },
  { id: 'web#2', repo: 'web', numero: 2, titulo: 'Paginación del listado', rama: 'feat/paginar', portal: 'Web', headSha: 'b2' },
];
const exito = (coincidencias) => ({ type: 'result', is_error: false, subtype: 'success', structured_output: { coincidencias }, total_cost_usd: 0.01, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 1, outputTokens: 1 } } });
const preparar = () => ({ salida: mkdtempSync(join(tmpdir(), 'seki-filtrar-')) });

test('returns only queue ids, without duplicates, and stores the result', async () => {
  const p = preparar();
  process.env.SEKI_CLAUDE = falsoClaude(exito([{ id: 'api#1', relacion: 'directa', motivo: 'SQLi en el título' }, { id: 'api#1', relacion: 'directa', motivo: 'otra' }, { id: 'ajena#9', relacion: 'directa', motivo: 'x' }, { id: 'web#2', relacion: 'otra cosa', motivo: 'toca el listado' }]));
  const r = await filtrarPrs(p, prs, '  PRs de   ciberseguridad ');
  assert.deepEqual(r.coincidencias, [{ id: 'api#1', relacion: 'directa', motivo: 'SQLi en el título' }, { id: 'web#2', relacion: 'relacionada', motivo: 'toca el listado' }]);
  assert.equal(r.consulta, 'PRs de ciberseguridad');
  assert.equal(r.total, 2);
  assert.equal(r.desdeCache, false);
});

test('the same need on the same queue does not call the AI again; if a PR changes commit, it does', async () => {
  const p = preparar();
  process.env.SEKI_CLAUDE = falsoClaude(exito([{ id: 'api#1', motivo: 'm' }]));
  await filtrarPrs(p, prs, 'seguridad');
  const r = await filtrarPrs(p, prs, 'SEGURIDAD');
  assert.equal(r.desdeCache, true);
  assert.equal(r.costo, 0);
  assert.equal(llamadas(process.env.SEKI_CLAUDE), 1);
  await filtrarPrs(p, [{ ...prs[0], headSha: 'a9' }, prs[1]], 'seguridad');
  assert.equal(llamadas(process.env.SEKI_CLAUDE), 2);
});

test('two simultaneous requests with the same need share a single call', async () => {
  const p = preparar();
  process.env.SEKI_CLAUDE = falsoClaude(exito([]));
  const [a, b] = await Promise.all([filtrarPrs(p, prs, 'login'), filtrarPrs(p, prs, 'login')]);
  assert.deepEqual([a.coincidencias, b.coincidencias], [[], []]);
  assert.equal(llamadas(process.env.SEKI_CLAUDE), 1);
});

test('rejects an empty or too long need and reports if the AI fails', async () => {
  const p = preparar();
  await assert.rejects(filtrarPrs(p, prs, '   '), /Describe/);
  await assert.rejects(filtrarPrs(p, prs, 'x'.repeat(301)), /300/);
  process.env.SEKI_CLAUDE = falsoClaude({ type: 'result', is_error: true, subtype: 'error_max_budget_usd', total_cost_usd: 0.5 }, 1);
  await assert.rejects(filtrarPrs(p, prs, 'seguridad'), /could not filter/);
});

test('each PR line carries the stored diff files only if it is from the current commit', () => {
  const p = preparar();
  escribirJson(rutaDiff(p.salida, 'api', 1), { headSha: 'a1', archivos: [{ filename: 'src/Buscar.ts' }] });
  escribirJson(rutaDiff(p.salida, 'web', 2), { headSha: 'viejo', archivos: [{ filename: 'src/Viejo.ts' }] });
  assert.match(lineaDePr(p, prs[0]), /files: src\/Buscar\.ts$/);
  assert.match(lineaDePr(p, prs[1]), /files: no data$/);
});

import { crearPresupuesto } from '../mcp/lib/presupuesto.mjs';
import { fijarEnv } from './util/tz.mjs';

test('budget: an over-budget filter answers 429 with the budget message and forzar lets it run once', async (t) => {
  const p = preparar();
  fijarEnv(t, 'SEKI_CLAUDE', falsoClaude(exito([{ id: 'api#1', relacion: 'directa', motivo: 'm' }])));
  const presupuesto = crearPresupuesto({ limite: () => 1, gasto: () => 0.9 });
  await assert.rejects(filtrarPrs(p, prs, 'presupuesto', { presupuesto }), (e) => e.codigo === 429 && e.forzar === true && /^Blocked by the daily budget \(\$0\.90 of \$1\.00 spent\)$/.test(e.message));
  assert.equal(llamadas(process.env.SEKI_CLAUDE), 0);
  const r = await filtrarPrs(p, prs, 'presupuesto', { presupuesto, forzar: true });
  assert.equal(r.desdeCache, false);
  assert.equal(llamadas(process.env.SEKI_CLAUDE), 1);
  assert.equal(presupuesto.estado().reservado, 0);
});

test('budget: a stored filter never touches the gate', async (t) => {
  const p = preparar();
  fijarEnv(t, 'SEKI_CLAUDE', falsoClaude(exito([])));
  await filtrarPrs(p, prs, 'guardado');
  const r = await filtrarPrs(p, prs, 'guardado', { presupuesto: crearPresupuesto({ limite: () => 0.01, gasto: () => 5 }) });
  assert.equal(r.desdeCache, true);
});
