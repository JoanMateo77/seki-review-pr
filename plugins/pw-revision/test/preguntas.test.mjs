import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardarComentarios, leerComentarios } from '../mcp/lib/comentarios.mjs';
import { responderPreguntas } from '../mcp/lib/preguntas.mjs';
import { falsoClaude, llamadas } from './util/claude.mjs';

const pr = { id: 'r#1', repo: 'r', numero: 1, titulo: 'T', headSha: 'abc', adiciones: 10, eliminaciones: 0, esfuerzoTamano: 1 };
const preg = (id, texto) => ({ id, tipo: 'pregunta', estado: 'borrador', archivo: 'a.ts', lado: 'nuevo', desde: 1, hasta: 2, textoOriginal: 'x', texto, headSha: 'abc' });
const deps = { contexto: async () => 'CONTEXTO', detalle: async () => null };
const exito = (respuestas) => ({ type: 'result', is_error: false, subtype: 'success', structured_output: { respuestas }, total_cost_usd: 0.001, modelUsage: { 'claude-haiku-5-5': { inputTokens: 1, outputTokens: 1 } } });

function preparar() {
  const p = { salida: mkdtempSync(join(tmpdir(), 'pw-preg-')) };
  guardarComentarios(p, 'r', 1, [preg('c-0001', '¿Qué hace?'), preg('c-0002', '¿Por qué?')]);
  return p;
}

test('responde dos preguntas en una sola llamada', async () => {
  const p = preparar();
  process.env.PW_CLAUDE = falsoClaude(exito([{ id: 'c-0001', texto: 'Hace A.' }, { id: 'c-0002', texto: 'Por B.' }]));
  const r = await responderPreguntas(p, pr, ['c-0001', 'c-0002'], deps);
  assert.equal(r.ok, true);
  assert.equal(llamadas(process.env.PW_CLAUDE), 1);
  const cs = leerComentarios(p, 'r', 1);
  assert.deepEqual(cs.map((c) => [c.estado, c.respuesta]), [['respondido', 'Hace A.'], ['respondido', 'Por B.']]);
  assert.equal(cs[0].modelo, 'claude-haiku-5-5');
});

test('segunda vez usa la caché sin llamar a claude', async () => {
  const p = preparar();
  process.env.PW_CLAUDE = falsoClaude(exito([{ id: 'c-0001', texto: 'Hace A.' }, { id: 'c-0002', texto: 'Por B.' }]));
  await responderPreguntas(p, pr, ['c-0001', 'c-0002'], deps);
  guardarComentarios(p, 'r', 1, [{ ...preg('c-0003', '¿Qué hace?') }]);
  const r = await responderPreguntas(p, pr, ['c-0003'], deps);
  assert.equal(llamadas(process.env.PW_CLAUDE), 1);
  assert.equal(r.costo, 0);
  const c = leerComentarios(p, 'r', 1).find((x) => x.id === 'c-0003');
  assert.equal(c.estado, 'respondido');
  assert.equal(c.respuesta, 'Hace A.');
  assert.equal(c.desdeCache, true);
});

test('respuesta faltante deja solo esa pregunta en error', async () => {
  const p = preparar();
  process.env.PW_CLAUDE = falsoClaude(exito([{ id: 'c-0001', texto: 'Hace A.' }]));
  await responderPreguntas(p, pr, ['c-0001', 'c-0002'], deps);
  const cs = leerComentarios(p, 'r', 1);
  assert.equal(cs[0].estado, 'respondido');
  assert.equal(cs[1].estado, 'error');
  assert.match(cs[1].motivo, /no devolvió respuesta/);
});

test('tope alcanzado deja el lote en error con motivo', async () => {
  const p = preparar();
  process.env.PW_CLAUDE = falsoClaude({ type: 'result', is_error: true, subtype: 'error_max_budget_usd', total_cost_usd: 1 }, 1);
  const r = await responderPreguntas(p, pr, ['c-0001', 'c-0002'], deps);
  assert.equal(r.ok, false);
  for (const c of leerComentarios(p, 'r', 1)) {
    assert.equal(c.estado, 'error');
    assert.equal(c.motivo, 'Se alcanzó el tope de costo del trabajo');
  }
});

test('ignora ids que no son preguntas o que ya están respondidos', async () => {
  const p = preparar();
  guardarComentarios(p, 'r', 1, [{ ...preg('c-0004', 'nota'), tipo: 'nota', estado: 'nota' }]);
  process.env.PW_CLAUDE = falsoClaude(exito([]));
  const r = await responderPreguntas(p, pr, ['c-0004'], deps);
  assert.equal(r.ok, true);
  assert.equal(llamadas(process.env.PW_CLAUDE), 0);
});

test('si el contexto falla las preguntas quedan en error y no en curso', async () => {
  const p = preparar();
  process.env.PW_CLAUDE = falsoClaude(exito([]));
  await assert.rejects(() => responderPreguntas(p, pr, ['c-0001', 'c-0002'], { ...deps, contexto: async () => { throw new Error('sin red'); } }));
  for (const c of leerComentarios(p, 'r', 1)) {
    assert.equal(c.estado, 'error');
    assert.equal(c.motivo, 'sin red');
  }
});
