import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argsClaude, costosDelDia, ejecutarClaude, elegirModelo, herramientasUsadas, reglasSecretos, registrarCosto, resumenCostos } from '../mcp/lib/ia.mjs';

import { falsoClaude } from './util/claude.mjs';

const chica = { seguridad: false, adiciones: 20, eliminaciones: 5, esfuerzoTamano: 1 };

beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('SEKI_IA_MODELO')) delete process.env[k];
});

test('elegirModelo: small question on small PR uses haiku', () => {
  assert.equal(elegirModelo({ tipo: 'responder', pr: chica, lineasSeleccionadas: 3 }), 'haiku');
});

test('elegirModelo: question about many lines uses sonnet', () => {
  assert.equal(elegirModelo({ tipo: 'responder', pr: chica, lineasSeleccionadas: 80 }), 'sonnet');
});

test('elegirModelo: cambiar never uses haiku even with SEKI_IA_MODELO=haiku', () => {
  process.env.SEKI_IA_MODELO = 'haiku';
  assert.equal(elegirModelo({ tipo: 'cambiar', pr: chica }), 'sonnet');
});

test('elegirModelo: per-type override beats the general one', () => {
  process.env.SEKI_IA_MODELO = 'opus';
  process.env.SEKI_IA_MODELO_RESPONDER = 'sonnet';
  assert.equal(elegirModelo({ tipo: 'responder', pr: chica }), 'sonnet');
});

test('elegirModelo: security PR uses opus when explaining', () => {
  assert.equal(elegirModelo({ tipo: 'explicar', pr: { ...chica, seguridad: true } }), 'opus');
});

test('elegirModelo: large PR uses opus when changing', () => {
  assert.equal(elegirModelo({ tipo: 'cambiar', pr: { ...chica, adiciones: 1400, eliminaciones: 200 } }), 'opus');
});

test('argsClaude: minimal mode includes strict-mcp, tools and disable-slash-commands, without CLAUDE.md', () => {
  const a = argsClaude({ tipo: 'explicar', modelo: 'sonnet', sistema: 'S', prompt: 'P', tools: ['Read'], mcp: true, tope: 2, turnos: 30, persistir: false });
  for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--system-prompt']) assert.ok(a.includes(f), f);
  assert.equal(a[a.indexOf('--tools') + 1], 'Read');
  assert.equal(a[a.indexOf('--setting-sources') + 1], '');
  assert.equal(a[a.indexOf('--max-budget-usd') + 1], '2');
  assert.ok(!a.includes('--add-dir'));
  const mcp = JSON.parse(a[a.indexOf('--mcp-config') + 1]);
  assert.deepEqual(Object.keys(mcp.mcpServers), ['seki-review']);
  assert.match(a[a.indexOf('--allowedTools') + 1], /mcp__seki-review/);
});

test('argsClaude: without tools passes empty --tools and does not load MCP', () => {
  const a = argsClaude({ tipo: 'responder', modelo: 'haiku', sistema: 'S', prompt: 'P', tools: [], mcp: false, tope: 0.5, turnos: 4, persistir: false, schema: { type: 'object' } });
  assert.equal(a[a.indexOf('--tools') + 1], '');
  assert.ok(!a.includes('--mcp-config'));
  assert.equal(a[a.indexOf('--json-schema') + 1], '{"type":"object"}');
});

test('argsClaude: resume session', () => {
  const a = argsClaude({ tipo: 'cambiar', modelo: 'sonnet', sistema: 'S', prompt: 'P', tools: [], mcp: false, tope: 1, turnos: 4, persistir: true, sesion: 'abc' });
  assert.equal(a[a.indexOf('--resume') + 1], 'abc');
  assert.ok(!a.includes('--no-session-persistence'));
});

test('ejecutarClaude: success returns structured output, usage and cost', async () => {
  process.env.SEKI_CLAUDE = falsoClaude({ type: 'result', is_error: false, subtype: 'success', result: '{}', structured_output: { respuestas: [] }, session_id: 's1', total_cost_usd: 0.01, modelUsage: { 'claude-haiku-5-5': { inputTokens: 2, outputTokens: 10, cacheReadInputTokens: 100, cacheCreationInputTokens: 50 } } });
  const r = await ejecutarClaude(['-p', 'x', '--json-schema', '{}'], { cwd: tmpdir() });
  assert.equal(r.ok, true);
  assert.deepEqual(r.salida, { respuestas: [] });
  assert.equal(r.sesion, 's1');
  assert.equal(r.costo, 0.01);
  assert.deepEqual(r.uso, { entrada: 2, cacheCreada: 50, cacheLeida: 100, salida: 10 });
  assert.equal(r.modelo, 'claude-haiku-5-5');
});

test('ejecutarClaude: reached cap gives ok=false with a readable reason', async () => {
  process.env.SEKI_CLAUDE = falsoClaude({ type: 'result', is_error: true, subtype: 'error_max_budget_usd', total_cost_usd: 0.5 }, 1);
  const r = await ejecutarClaude(['-p', 'x'], { cwd: tmpdir() });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'The job reached its cost cap');
  assert.equal(r.costo, 0.5);
});

test('ejecutarClaude: turn limit gives a readable reason', async () => {
  process.env.SEKI_CLAUDE = falsoClaude({ type: 'result', is_error: true, subtype: 'error_max_turns' }, 1);
  assert.equal((await ejecutarClaude(['-p', 'x'], { cwd: tmpdir() })).motivo, 'The job reached its turn limit');
});

test('ejecutarClaude: schema without structured_output gives ok=false', async () => {
  process.env.SEKI_CLAUDE = falsoClaude({ type: 'result', is_error: false, subtype: 'success', result: 'texto libre' });
  const r = await ejecutarClaude(['-p', 'x', '--json-schema', '{}'], { cwd: tmpdir() });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'The response did not arrive in the expected format');
});

test('costosDelDia sums only the requested day', () => {
  const p = { salida: mkdtempSync(join(tmpdir(), 'seki-costo-')) };
  registrarCosto(p, { tipo: 'responder', prId: 'r#1', modelo: 'haiku', costo: 0.1, ok: true, fecha: '2026-10-27T10:00:00Z' });
  registrarCosto(p, { tipo: 'responder', prId: 'r#1', modelo: 'haiku', costo: 0.2, ok: true, fecha: '2026-10-27T15:00:00Z' });
  registrarCosto(p, { tipo: 'responder', prId: 'r#1', modelo: 'haiku', costo: 5, ok: true, fecha: '2026-10-26T10:00:00Z' });
  const d = costosDelDia(p, '2026-10-27');
  assert.equal(d.trabajos, 2);
  assert.ok(Math.abs(d.total - 0.3) < 1e-9);
});

test('argsClaude: editing only inside the cwd with acceptEdits, without Edit or Write in allowedTools', () => {
  const a = argsClaude({ modelo: 'sonnet', sistema: 'S', prompt: 'P', tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'], tope: 1, turnos: 4, persistir: true });
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.doesNotMatch(a[a.indexOf('--allowedTools') + 1], /Edit|Write/);
  assert.equal(a[a.indexOf('--tools') + 1], 'Read,Grep,Glob,Edit,Write');
});

test('argsClaude: extra directories and rules that deny secret files', () => {
  const a = argsClaude({ modelo: 'sonnet', sistema: 'S', prompt: 'P', tools: ['Read', 'Grep', 'Glob'], tope: 1, turnos: 4, dirs: ['/a/b'], prohibidas: reglasSecretos(['/a/b'], ['claves.txt']) });
  assert.equal(a[a.indexOf('--add-dir') + 1], '/a/b');
  const negadas = a.slice(a.indexOf('--disallowedTools') + 1);
  assert.ok(negadas.includes('Read(//a/b/**/*.env)'));
  assert.ok(negadas.includes('Read(//a/b/**/.env*)'));
  assert.ok(negadas.includes('Read(//a/b/**/credentials*)'));
  assert.ok(negadas.includes('Read(//a/b/**/claves.txt)'));
});

test('resumenCostos compares cost per model with what was marked useful and counts retries', () => {
  const p = { salida: mkdtempSync(join(tmpdir(), 'seki-res-')) };
  const f = (d) => `2026-10-${d}T10:00:00.000Z`;
  registrarCosto(p, { fecha: f('01'), tipo: 'explicar', prId: 'a#1', modelo: 'claude-opus-5-5', costo: 9, ok: true });
  registrarCosto(p, { fecha: f('20'), tipo: 'explicar', prId: 'a#1', modelo: 'claude-sonnet-5-5', costo: 1, ok: true });
  registrarCosto(p, { fecha: f('20'), tipo: 'explicar', prId: 'a#1', modelo: 'claude-sonnet-5-5', costo: 1, ok: false });
  registrarCosto(p, { fecha: f('21'), tipo: 'responder', prId: 'a#1', modelo: 'claude-haiku-5-5', costo: 0.1, ok: true });
  registrarCosto(p, { fecha: f('21'), tipo: 'valoracion', comentario: 'c-1', modelo: 'claude-haiku-5-5', util: false, costo: 0 });
  registrarCosto(p, { fecha: f('22'), tipo: 'valoracion', comentario: 'c-1', modelo: 'claude-haiku-5-5', util: true, costo: 0 });
  registrarCosto(p, { fecha: f('22'), tipo: 'valoracion', comentario: 'c-2', modelo: 'claude-sonnet-5-5', util: null, costo: 0 });
  const r = resumenCostos(p, { dias: 10, ahora: Date.parse('2026-10-28T00:00:00Z') });
  assert.deepEqual(r.modelos, {
    sonnet: { trabajos: 2, fallidos: 1, costo: 2, utiles: 0, noUtiles: 0, costoPorUtil: null },
    haiku: { trabajos: 1, fallidos: 0, costo: 0.1, utiles: 1, noUtiles: 0, costoPorUtil: 0.1 },
  });
  assert.equal(r.reintentos, 1);
  assert.equal(costosDelDia(p, '2026-10-22').trabajos, 0);
});

test('herramientasUsadas reads the calls from a stream-json output without counting the structured response', () => {
  const salida = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'tool_use' }, { type: 'tool_use', name: 'Grep', input: { pattern: 'x' } }] } }),
    'no es json "tool_use"',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: { texto: 'y' } }] } }),
    JSON.stringify({ type: 'result', is_error: false }),
  ].join('\n');
  assert.deepEqual(herramientasUsadas(salida), [{ nombre: 'Grep', entrada: { pattern: 'x' } }]);
  assert.ok(argsClaude({ modelo: 'haiku', sistema: 's', prompt: 'p', tope: 1, turnos: 1, traza: true }).join(' ').includes('--output-format stream-json --verbose'));
});
