import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardarComentarios, leerComentarios } from '../mcp/lib/comentarios.mjs';
import { aprobar, descartar, leerPropuestas, proponerCambios } from '../mcp/lib/propuestas.mjs';
import { rutaCopia } from '../mcp/lib/cache.mjs';
import { falsoClaude, llamadas } from './util/claude.mjs';
import { falsoGh } from './util/gh.mjs';
import { repoConPr, sh } from './util/repo.mjs';

const exito = { type: 'result', is_error: false, subtype: 'success', session_id: 'ses-1', structured_output: { resumen: 'Valida el rango de fechas', hecho: true }, total_cost_usd: 0.02, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 1, outputTokens: 1 } } };
const deps = { contexto: async () => 'CONTEXTO', detalle: async () => null };
const pedido = (id) => ({ id, tipo: 'cambio', estado: 'en_cola', archivo: 'a.ts', lado: 'nuevo', desde: 1, hasta: 1, textoOriginal: 'b', texto: 'Debe validar el rango', headSha: '' });

let gh;
function preparar({ script = 'printf "cambio $N\\n" > a.ts', salida = exito, pedidos = ['c-0001'] } = {}) {
  const r = repoConPr({ antes: 'a\n', despues: 'b\n' });
  const p = { owner: 'o', clave: 'demo', salida: mkdtempSync(join(tmpdir(), 'pw-prop-')), repos: { x: { checkout: r.checkout } } };
  const pr = { id: 'x#7', repo: 'x', numero: 7, titulo: 'T', headSha: r.head, estadoPr: 'OPEN', rama: r.rama, adiciones: 1, eliminaciones: 1 };
  guardarComentarios(p, 'x', 7, pedidos.map((id) => ({ ...pedido(id), headSha: r.head })));
  process.env.PW_CLAUDE = falsoClaude(salida, 0, script);
  gh = falsoGh({ state: 'OPEN', headRefName: r.rama, headRefOid: r.head });
  process.env.PW_GH = gh.ruta;
  return { r, p, pr };
}

beforeEach(() => { delete process.env.PW_IA_MODELO; });

test('proponer crea propuesta con patch y marca el comentario', async () => {
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
  assert.match(prop.comprobaciones.avisos.join(' '), /Lineamientos de el equipo no disponibles/);
});

test('dos pedidos generan dos propuestas con su propio patch', async () => {
  const { p, pr } = preparar({ pedidos: ['c-0001', 'c-0002'] });
  await proponerCambios(p, pr, ['c-0001', 'c-0002'], deps);
  const ps = leerPropuestas(p, 'x', 7);
  assert.equal(ps.length, 2);
  assert.match(ps[0].patch, /\+cambio 1/);
  assert.match(ps[1].patch, /\+cambio 2/);
  assert.doesNotMatch(ps[1].patch, /cambio 1/);
});

test('regla bloqueante provoca un reintento y queda marcada si persiste', async () => {
  const { p, pr } = preparar({ script: 'printf \'qb.where(`a = ${x}`)\\n\' > a.ts' });
  await proponerCambios(p, pr, ['c-0001'], deps);
  assert.equal(llamadas(process.env.PW_CLAUDE), 2);
  const [prop] = leerPropuestas(p, 'x', 7);
  assert.ok(prop.comprobaciones.reglas.bloqueantes > 0);
  assert.equal(prop.conFallos, true);
});

test('pedido que la IA no puede hacer queda en error con su explicación', async () => {
  const { p, pr } = preparar({ script: '', salida: { ...exito, structured_output: { resumen: 'El pedido es ambiguo: no indica el rango', hecho: false } } });
  await proponerCambios(p, pr, ['c-0001'], deps);
  const [c] = leerComentarios(p, 'x', 7);
  assert.equal(c.estado, 'error');
  assert.equal(c.motivo, 'El pedido es ambiguo: no indica el rango');
});

test('PR cerrada no genera propuesta', async () => {
  const { p, pr } = preparar();
  await proponerCambios(p, { ...pr, estadoPr: 'MERGED' }, ['c-0001'], deps);
  assert.equal(leerComentarios(p, 'x', 7)[0].motivo, 'La PR ya no está abierta');
  assert.equal(llamadas(process.env.PW_CLAUDE), 0);
});

test('aprobar sube un commit sin trailers a la rama', async () => {
  const { r, p, pr } = preparar();
  await proponerCambios(p, pr, ['c-0001'], deps);
  const [prop] = leerPropuestas(p, 'x', 7);
  const res = await aprobar(p, pr, prop.id);
  assert.equal(res.ok, true, res.motivo);
  const msg = sh(r.remoto, 'log', '-1', '--format=%B', r.rama);
  assert.equal(msg.trim(), 'Valida el rango de fechas');
  assert.doesNotMatch(msg, /Co-Authored-By|Claude/i);
  assert.equal(sh(r.remoto, 'show', `${r.rama}:a.ts`), 'cambio 1');
  assert.equal(leerPropuestas(p, 'x', 7)[0].estado, 'aprobada');
  assert.equal(leerComentarios(p, 'x', 7)[0].estado, 'aprobado');
});

test('dos aprobaciones seguidas en la misma PR se encadenan', async () => {
  const { r, p, pr } = preparar({ pedidos: ['c-0001', 'c-0002'], script: 'if [ "$N" = 1 ]; then printf "b\\nuno\\n" > a.ts; else printf "cero\\nb\\n" > a.ts; fi' });
  await proponerCambios(p, pr, ['c-0001', 'c-0002'], deps);
  const [a, b] = leerPropuestas(p, 'x', 7);
  assert.equal((await aprobar(p, pr, a.id)).ok, true);
  gh.fijar({ state: 'OPEN', headRefName: r.rama, headRefOid: sh(r.remoto, 'rev-parse', r.rama) });
  const res = await aprobar(p, pr, b.id);
  assert.equal(res.ok, true, res.motivo);
  assert.equal(sh(r.remoto, 'show', `${r.rama}:a.ts`), 'cero\nb\nuno');
});

test('aprobar con la rama movida no aplica y deja conflicto', async () => {
  const { r, p, pr } = preparar();
  await proponerCambios(p, pr, ['c-0001'], deps);
  gh.fijar({ state: 'OPEN', headRefName: r.rama, headRefOid: 'f'.repeat(40) });
  const [prop] = leerPropuestas(p, 'x', 7);
  const res = await aprobar(p, pr, prop.id);
  assert.equal(res.ok, false);
  assert.equal(res.motivo, 'La rama cambió desde que se generó la propuesta');
  assert.equal(leerPropuestas(p, 'x', 7)[0].estado, 'conflicto');
  assert.equal(sh(r.remoto, 'rev-parse', r.rama), r.head);
});

test('aprobar con PR cerrada no aplica', async () => {
  const { r, p, pr } = preparar();
  await proponerCambios(p, pr, ['c-0001'], deps);
  gh.fijar({ state: 'CLOSED', headRefName: r.rama, headRefOid: r.head });
  const res = await aprobar(p, pr, leerPropuestas(p, 'x', 7)[0].id);
  assert.equal(res.motivo, 'La PR ya no está abierta');
});

test('push rechazado deja la propuesta rechazada con su parche y la copia limpia', async () => {
  const { r, p, pr } = preparar();
  await proponerCambios(p, pr, ['c-0001'], deps);
  const hook = join(r.remoto, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "rama protegida" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  const [prop] = leerPropuestas(p, 'x', 7);
  const res = await aprobar(p, pr, prop.id);
  assert.equal(res.ok, false);
  assert.match(res.motivo, /rama protegida/);
  assert.equal(res.parche, prop.patch);
  assert.equal(leerPropuestas(p, 'x', 7)[0].estado, 'rechazada');
  const copia = rutaCopia(p, 'x', 7);
  assert.equal(sh(copia, 'rev-parse', 'HEAD'), r.head);
  assert.equal(sh(copia, 'status', '--porcelain'), '');
});

test('aprobar propuesta con fallos sin confirmar pide confirmación', async () => {
  const { r, p, pr } = preparar({ script: 'printf \'qb.where(`a = ${x}`)\\n\' > a.ts' });
  await proponerCambios(p, pr, ['c-0001'], deps);
  const [prop] = leerPropuestas(p, 'x', 7);
  assert.equal((await aprobar(p, pr, prop.id)).motivo, 'requiere_confirmacion');
  assert.equal(sh(r.remoto, 'rev-parse', r.rama), r.head);
  assert.equal((await aprobar(p, pr, prop.id, { confirmarFallos: true })).ok, true);
});

test('descartar la última propuesta borra la copia', async () => {
  const { p, pr } = preparar();
  await proponerCambios(p, pr, ['c-0001'], deps);
  const [prop] = leerPropuestas(p, 'x', 7);
  assert.ok(existsSync(rutaCopia(p, 'x', 7)));
  await descartar(p, pr, prop.id);
  assert.equal(leerPropuestas(p, 'x', 7)[0].estado, 'descartada');
  assert.equal(leerComentarios(p, 'x', 7)[0].estado, 'descartado');
  assert.equal(existsSync(rutaCopia(p, 'x', 7)), false);
});
