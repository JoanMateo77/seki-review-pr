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

test('devuelve solo ids de la cola, sin repetir, y guarda el resultado', async () => {
  const p = preparar();
  process.env.SEKI_CLAUDE = falsoClaude(exito([{ id: 'api#1', motivo: 'SQLi en el título' }, { id: 'api#1', motivo: 'otra' }, { id: 'ajena#9', motivo: 'x' }]));
  const r = await filtrarPrs(p, prs, '  PRs de   ciberseguridad ');
  assert.deepEqual(r.coincidencias, [{ id: 'api#1', motivo: 'SQLi en el título' }]);
  assert.equal(r.consulta, 'PRs de ciberseguridad');
  assert.equal(r.total, 2);
  assert.equal(r.desdeCache, false);
});

test('la misma necesidad sobre la misma cola no vuelve a llamar a la IA; si una PR cambia de commit, sí', async () => {
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

test('dos pedidos simultáneos con la misma necesidad comparten una sola llamada', async () => {
  const p = preparar();
  process.env.SEKI_CLAUDE = falsoClaude(exito([]));
  const [a, b] = await Promise.all([filtrarPrs(p, prs, 'login'), filtrarPrs(p, prs, 'login')]);
  assert.deepEqual([a.coincidencias, b.coincidencias], [[], []]);
  assert.equal(llamadas(process.env.SEKI_CLAUDE), 1);
});

test('rechaza una necesidad vacía o demasiado larga y avisa si la IA falla', async () => {
  const p = preparar();
  await assert.rejects(filtrarPrs(p, prs, '   '), /Escriba/);
  await assert.rejects(filtrarPrs(p, prs, 'x'.repeat(301)), /300/);
  process.env.SEKI_CLAUDE = falsoClaude({ type: 'result', is_error: true, subtype: 'error_max_budget_usd', total_cost_usd: 0.5 }, 1);
  await assert.rejects(filtrarPrs(p, prs, 'seguridad'), /no pudo filtrar/);
});

test('la línea de cada PR lleva los archivos del diff guardado solo si es del commit actual', () => {
  const p = preparar();
  escribirJson(rutaDiff(p.salida, 'api', 1), { headSha: 'a1', archivos: [{ filename: 'src/Buscar.ts' }] });
  escribirJson(rutaDiff(p.salida, 'web', 2), { headSha: 'viejo', archivos: [{ filename: 'src/Viejo.ts' }] });
  assert.match(lineaDePr(p, prs[0]), /archivos: src\/Buscar\.ts$/);
  assert.match(lineaDePr(p, prs[1]), /archivos: sin datos$/);
});
