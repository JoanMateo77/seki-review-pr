import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardarComentarios, leerComentarios } from '../mcp/lib/comentarios.mjs';
import { aprobar, descartar, leerPropuestas, proponerCambios } from '../mcp/lib/propuestas.mjs';
import { escribirJson, leerJson, rutaCopia, rutaPropuestas } from '../mcp/lib/cache.mjs';
import { falsoClaude, llamadas } from './util/claude.mjs';
import { falsoGh } from './util/gh.mjs';
import { repoConPr, sh } from './util/repo.mjs';

const exito = { type: 'result', is_error: false, subtype: 'success', session_id: 'ses-1', structured_output: { resumen: 'Validate the date range', hecho: true }, total_cost_usd: 0.02, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 1, outputTokens: 1 } } };
const deps = { contexto: async () => 'CONTEXTO', detalle: async () => null };
const pedido = (id) => ({ id, tipo: 'cambio', estado: 'borrador', archivo: 'a.ts', lado: 'nuevo', desde: 1, hasta: 1, textoOriginal: 'b', texto: 'Must validate the range', headSha: '' });

let gh;
function preparar({ script = 'printf "cambio $N\\n" > a.ts', salida = exito, pedidos = ['c-0001'] } = {}) {
  const r = repoConPr({ antes: 'a\n', despues: 'b\n' });
  const p = { owner: 'o', clave: 'demo', lineamientos: '/no/existe', salida: mkdtempSync(join(tmpdir(), 'seki-prop-')), repos: { x: { checkout: r.checkout } } };
  const pr = { id: 'x#7', repo: 'x', numero: 7, titulo: 'T', headSha: r.head, estadoPr: 'OPEN', rama: r.rama, adiciones: 1, eliminaciones: 1 };
  guardarComentarios(p, 'x', 7, pedidos.map((id) => ({ ...pedido(id), headSha: r.head })));
  process.env.SEKI_CLAUDE = falsoClaude(salida, 0, script);
  gh = falsoGh({ state: 'OPEN', headRefName: r.rama, headRefOid: r.head });
  process.env.SEKI_GH = gh.ruta;
  return { r, p, pr };
}

beforeEach(() => { delete process.env.SEKI_IA_MODELO; });

test('propose creates a proposal with a patch and marks the comment', async () => {
  const { p, pr } = preparar();
  await proponerCambios(p, pr, ['c-0001'], deps);
  const [c] = leerComentarios(p, 'x', 7);
  assert.equal(c.estado, 'propuesta');
  const [prop] = leerPropuestas(p, 'x', 7);
  assert.equal(prop.id, c.propuestaId);
  assert.equal(prop.estado, 'lista');
  assert.match(prop.patch, /-b\n\+cambio 1/);
  assert.deepEqual(prop.fueraDelComentario, []);
  assert.equal(prop.sesion, 'ses-1');
  assert.match(prop.comprobaciones.avisos.join(' '), /Project guidelines are not available/);
});

test('two requests produce two proposals, each with its own patch', async () => {
  const { p, pr } = preparar({ pedidos: ['c-0001', 'c-0002'] });
  await proponerCambios(p, pr, ['c-0001', 'c-0002'], deps);
  const ps = leerPropuestas(p, 'x', 7);
  assert.equal(ps.length, 2);
  assert.match(ps[0].patch, /\+cambio 1/);
  assert.match(ps[1].patch, /\+cambio 2/);
  assert.doesNotMatch(ps[1].patch, /cambio 1/);
});

test('a blocking rule triggers a retry and stays flagged if it persists', async () => {
  const { p, pr } = preparar({ script: 'printf \'qb.where(`a = ${x}`)\\n\' > a.ts' });
  await proponerCambios(p, pr, ['c-0001'], deps);
  assert.equal(llamadas(process.env.SEKI_CLAUDE), 2);
  const [prop] = leerPropuestas(p, 'x', 7);
  assert.ok(prop.comprobaciones.reglas.bloqueantes > 0);
  assert.equal(prop.conFallos, true);
});

test('a request the AI cannot fulfil ends in error with its explanation', async () => {
  const { p, pr } = preparar({ script: '', salida: { ...exito, structured_output: { resumen: 'The request is ambiguous: it does not state the range', hecho: false } } });
  await proponerCambios(p, pr, ['c-0001'], deps);
  const [c] = leerComentarios(p, 'x', 7);
  assert.equal(c.estado, 'error');
  assert.equal(c.motivo, 'The request is ambiguous: it does not state the range');
});

test('a closed PR produces no proposal', async () => {
  const { p, pr } = preparar();
  await proponerCambios(p, { ...pr, estadoPr: 'MERGED' }, ['c-0001'], deps);
  assert.equal(leerComentarios(p, 'x', 7)[0].motivo, 'The PR is no longer open');
  assert.equal(llamadas(process.env.SEKI_CLAUDE), 0);
});

test('approve pushes a commit without trailers to the branch', async () => {
  const { r, p, pr } = preparar();
  await proponerCambios(p, pr, ['c-0001'], deps);
  const [prop] = leerPropuestas(p, 'x', 7);
  const res = await aprobar(p, pr, prop.id);
  assert.equal(res.ok, true, res.motivo);
  const msg = sh(r.remoto, 'log', '-1', '--format=%B', r.rama);
  assert.equal(msg.trim(), 'Validate the date range');
  assert.doesNotMatch(msg, /Co-Authored-By|Claude/i);
  assert.equal(sh(r.remoto, 'show', `${r.rama}:a.ts`), 'cambio 1');
  assert.equal(leerPropuestas(p, 'x', 7)[0].estado, 'aprobada');
  assert.equal(leerComentarios(p, 'x', 7)[0].estado, 'aprobado');
});

test('two consecutive approvals on the same PR are chained', async () => {
  const { r, p, pr } = preparar({ pedidos: ['c-0001', 'c-0002'], script: 'if [ "$N" = 1 ]; then printf "b\\nuno\\n" > a.ts; else printf "cero\\nb\\n" > a.ts; fi' });
  await proponerCambios(p, pr, ['c-0001', 'c-0002'], deps);
  const [a, b] = leerPropuestas(p, 'x', 7);
  assert.equal((await aprobar(p, pr, a.id)).ok, true);
  gh.fijar({ state: 'OPEN', headRefName: r.rama, headRefOid: sh(r.remoto, 'rev-parse', r.rama) });
  const res = await aprobar(p, pr, b.id);
  assert.equal(res.ok, true, res.motivo);
  assert.equal(sh(r.remoto, 'show', `${r.rama}:a.ts`), 'cero\nb\nuno');
});

test('approve with a moved branch does not apply and leaves a conflict', async () => {
  const { r, p, pr } = preparar();
  await proponerCambios(p, pr, ['c-0001'], deps);
  gh.fijar({ state: 'OPEN', headRefName: r.rama, headRefOid: 'f'.repeat(40) });
  const [prop] = leerPropuestas(p, 'x', 7);
  const res = await aprobar(p, pr, prop.id);
  assert.equal(res.ok, false);
  assert.equal(res.motivo, 'The branch changed since the proposal was generated');
  assert.equal(leerPropuestas(p, 'x', 7)[0].estado, 'conflicto');
  assert.equal(sh(r.remoto, 'rev-parse', r.rama), r.head);
});

test('approve recognizes a push that landed before the result was saved and does not repeat it', async () => {
  const { r, p, pr } = preparar();
  await proponerCambios(p, pr, ['c-0001'], deps);
  const [prop] = leerPropuestas(p, 'x', 7);
  const { commit } = await aprobar(p, pr, prop.id);
  // State left by a process killed right after the push.
  const estadoRuta = join(rutaPropuestas(p.salida, 'x', 7), 'estado.json');
  escribirJson(estadoRuta, { rama: r.rama, cadena: [], pendiente: { propuestaId: prop.id, base: r.head, commit } });
  escribirJson(join(rutaPropuestas(p.salida, 'x', 7), `${prop.id}.json`), { ...leerPropuestas(p, 'x', 7)[0], estado: 'lista', commit: undefined });
  gh.fijar({ state: 'OPEN', headRefName: r.rama, headRefOid: commit });
  const res = await aprobar(p, pr, prop.id);
  assert.equal(res.ok, true, res.motivo);
  assert.equal(res.reconciliada, true);
  assert.equal(sh(r.remoto, 'rev-list', '--count', `${r.head}..${r.rama}`).trim(), '1');
  assert.equal(sh(r.remoto, 'rev-parse', r.rama), commit);
  assert.equal(leerPropuestas(p, 'x', 7)[0].estado, 'aprobada');
  assert.deepEqual(leerJson(estadoRuta), { rama: r.rama, cadena: [{ base: r.head, commit }] });
});

test('approve with a previous attempt that did not land discards it and pushes normally', async () => {
  const { r, p, pr } = preparar();
  await proponerCambios(p, pr, ['c-0001'], deps);
  const [prop] = leerPropuestas(p, 'x', 7);
  escribirJson(join(rutaPropuestas(p.salida, 'x', 7), 'estado.json'), { rama: r.rama, cadena: [], pendiente: { propuestaId: prop.id, base: r.head, commit: 'e'.repeat(40) } });
  const res = await aprobar(p, pr, prop.id);
  assert.equal(res.ok, true, res.motivo);
  assert.equal(res.reconciliada, undefined);
  assert.equal(sh(r.remoto, 'rev-parse', r.rama), res.commit);
  assert.equal(leerJson(join(rutaPropuestas(p.salida, 'x', 7), 'estado.json')).pendiente, undefined);
});

test('approve with a closed PR does not apply', async () => {
  const { r, p, pr } = preparar();
  await proponerCambios(p, pr, ['c-0001'], deps);
  gh.fijar({ state: 'CLOSED', headRefName: r.rama, headRefOid: r.head });
  const res = await aprobar(p, pr, leerPropuestas(p, 'x', 7)[0].id);
  assert.equal(res.motivo, 'The PR is no longer open');
});

test('a rejected push leaves the proposal rejected with its patch and the copy clean', async () => {
  const { r, p, pr } = preparar();
  await proponerCambios(p, pr, ['c-0001'], deps);
  const hook = join(r.remoto, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "protected branch" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  const [prop] = leerPropuestas(p, 'x', 7);
  const res = await aprobar(p, pr, prop.id);
  assert.equal(res.ok, false);
  assert.match(res.motivo, /protected branch/);
  assert.equal(res.parche, prop.patch);
  assert.equal(leerPropuestas(p, 'x', 7)[0].estado, 'rechazada');
  const copia = rutaCopia(p, 'x', 7);
  assert.equal(sh(copia, 'rev-parse', 'HEAD'), r.head);
  assert.equal(sh(copia, 'status', '--porcelain'), '');
});

test('approving a proposal with failures without confirming asks for confirmation', async () => {
  const { r, p, pr } = preparar({ script: 'printf \'qb.where(`a = ${x}`)\\n\' > a.ts' });
  await proponerCambios(p, pr, ['c-0001'], deps);
  const [prop] = leerPropuestas(p, 'x', 7);
  assert.equal((await aprobar(p, pr, prop.id)).motivo, 'requiere_confirmacion');
  assert.equal(sh(r.remoto, 'rev-parse', r.rama), r.head);
  assert.equal((await aprobar(p, pr, prop.id, { confirmarFallos: true })).ok, true);
});

test('discarding the last proposal deletes the copy', async () => {
  const { p, pr } = preparar();
  await proponerCambios(p, pr, ['c-0001'], deps);
  const [prop] = leerPropuestas(p, 'x', 7);
  assert.ok(existsSync(rutaCopia(p, 'x', 7)));
  await descartar(p, pr, prop.id);
  assert.equal(leerPropuestas(p, 'x', 7)[0].estado, 'descartada');
  assert.equal(leerComentarios(p, 'x', 7)[0].estado, 'descartado');
  assert.equal(existsSync(rutaCopia(p, 'x', 7)), false);
});

test('approve rejects a stale proposal when the branch has foreign commits', async () => {
  const { r, p, pr } = preparar({ pedidos: ['c-0001', 'c-0002'], script: 'if [ "$N" = 1 ]; then printf "b\\nuno\\n" > a.ts; else printf "cero\\nb\\n" > a.ts; fi' });
  await proponerCambios(p, pr, ['c-0001', 'c-0002'], deps);
  const [a, b] = leerPropuestas(p, 'x', 7);
  assert.equal((await aprobar(p, pr, a.id)).ok, true);
  const ajeno = join(mkdtempSync(join(tmpdir(), 'seki-ajeno-')), 'w');
  sh(r.raiz, 'clone', '-q', r.remoto, ajeno);
  sh(ajeno, 'checkout', '-q', r.rama);
  writeFileSync(join(ajeno, 'otro.ts'), 'ajeno\n');
  sh(ajeno, 'add', '.');
  sh(ajeno, '-c', 'user.name=Otro', '-c', 'user.email=o@x', 'commit', '-qm', 'ajeno');
  sh(ajeno, 'push', '-q', 'origin', r.rama);
  const cabeza = sh(r.remoto, 'rev-parse', r.rama);
  gh.fijar({ state: 'OPEN', headRefName: r.rama, headRefOid: cabeza });
  const res = await aprobar(p, pr, b.id);
  assert.equal(res.ok, false);
  assert.equal(res.motivo, 'The branch changed since the proposal was generated');
  assert.equal(sh(r.remoto, 'rev-parse', r.rama), cabeza);
});

test('approve rejects a PR that comes from a fork', async () => {
  const { r, p, pr } = preparar();
  await proponerCambios(p, pr, ['c-0001'], deps);
  gh.fijar({ state: 'OPEN', headRefName: r.rama, headRefOid: r.head, isCrossRepository: true });
  const res = await aprobar(p, pr, leerPropuestas(p, 'x', 7)[0].id);
  assert.equal(res.ok, false);
  assert.match(res.motivo, /fork/);
  assert.equal(sh(r.remoto, 'rev-parse', r.rama), r.head);
});

test('discard rejects an already approved proposal', async () => {
  const { p, pr } = preparar();
  await proponerCambios(p, pr, ['c-0001'], deps);
  const [prop] = leerPropuestas(p, 'x', 7);
  await aprobar(p, pr, prop.id);
  await assert.rejects(() => descartar(p, pr, prop.id), /approved/);
  assert.equal(leerComentarios(p, 'x', 7)[0].estado, 'aprobado');
});

test('approve with an empty summary uses a default message', async () => {
  const { r, p, pr } = preparar({ salida: { ...exito, structured_output: { resumen: '   ', hecho: true } } });
  await proponerCambios(p, pr, ['c-0001'], deps);
  const res = await aprobar(p, pr, leerPropuestas(p, 'x', 7)[0].id);
  assert.equal(res.ok, true, res.motivo);
  assert.equal(sh(r.remoto, 'log', '-1', '--format=%s', r.rama), 'Change requested in the PR review');
});

test('if preparation fails the requests end in error, not queued', async () => {
  const { p, pr } = preparar();
  p.repos.x.checkout = '/no/existe';
  await assert.rejects(() => proponerCambios(p, pr, ['c-0001'], deps));
  const [c] = leerComentarios(p, 'x', 7);
  assert.equal(c.estado, 'error');
  assert.ok(c.motivo);
});
