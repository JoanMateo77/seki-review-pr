import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argsClaude, costosDelDia, ejecutarClaude, elegirModelo, registrarCosto } from '../mcp/lib/ia.mjs';

// Falso `claude`: imprime el JSON indicado y sale con el código indicado.
export function falsoClaude(json, codigo = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'pw-claude-'));
  const ruta = join(dir, 'claude');
  writeFileSync(join(dir, 'salida.json'), JSON.stringify(json));
  writeFileSync(ruta, `#!/bin/sh\ncat "${join(dir, 'salida.json')}"\nexit ${codigo}\n`);
  chmodSync(ruta, 0o755);
  return ruta;
}

const chica = { seguridad: false, adiciones: 20, eliminaciones: 5, esfuerzoTamano: 1 };

beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('PW_IA_MODELO')) delete process.env[k];
});

test('elegirModelo: pregunta chica en PR chica usa haiku', () => {
  assert.equal(elegirModelo({ tipo: 'responder', pr: chica, lineasSeleccionadas: 3 }), 'haiku');
});

test('elegirModelo: pregunta sobre muchas líneas usa sonnet', () => {
  assert.equal(elegirModelo({ tipo: 'responder', pr: chica, lineasSeleccionadas: 80 }), 'sonnet');
});

test('elegirModelo: cambiar nunca usa haiku aunque PW_IA_MODELO=haiku', () => {
  process.env.PW_IA_MODELO = 'haiku';
  assert.equal(elegirModelo({ tipo: 'cambiar', pr: chica }), 'sonnet');
});

test('elegirModelo: override por tipo gana al general', () => {
  process.env.PW_IA_MODELO = 'opus';
  process.env.PW_IA_MODELO_RESPONDER = 'sonnet';
  assert.equal(elegirModelo({ tipo: 'responder', pr: chica }), 'sonnet');
});

test('elegirModelo: PR de seguridad usa opus al explicar', () => {
  assert.equal(elegirModelo({ tipo: 'explicar', pr: { ...chica, seguridad: true } }), 'opus');
});

test('elegirModelo: PR grande usa opus al cambiar', () => {
  assert.equal(elegirModelo({ tipo: 'cambiar', pr: { ...chica, adiciones: 1400, eliminaciones: 200 } }), 'opus');
});

test('argsClaude: modo mínimo incluye strict-mcp, tools y disable-slash-commands, sin CLAUDE.md', () => {
  const a = argsClaude({ tipo: 'explicar', modelo: 'sonnet', sistema: 'S', prompt: 'P', tools: ['Read'], mcp: true, tope: 2, turnos: 30, persistir: false });
  for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--system-prompt']) assert.ok(a.includes(f), f);
  assert.equal(a[a.indexOf('--tools') + 1], 'Read');
  assert.equal(a[a.indexOf('--setting-sources') + 1], 'project');
  assert.equal(a[a.indexOf('--max-budget-usd') + 1], '2');
  assert.ok(!a.includes('--add-dir'));
  const mcp = JSON.parse(a[a.indexOf('--mcp-config') + 1]);
  assert.deepEqual(Object.keys(mcp.mcpServers), ['pw-revision']);
  assert.match(a[a.indexOf('--allowedTools') + 1], /mcp__pw-revision/);
});

test('argsClaude: sin herramientas pasa --tools vacío y no carga MCP', () => {
  const a = argsClaude({ tipo: 'responder', modelo: 'haiku', sistema: 'S', prompt: 'P', tools: [], mcp: false, tope: 0.5, turnos: 4, persistir: false, schema: { type: 'object' } });
  assert.equal(a[a.indexOf('--tools') + 1], '');
  assert.ok(!a.includes('--mcp-config'));
  assert.equal(a[a.indexOf('--json-schema') + 1], '{"type":"object"}');
});

test('argsClaude: reanudar sesión', () => {
  const a = argsClaude({ tipo: 'cambiar', modelo: 'sonnet', sistema: 'S', prompt: 'P', tools: [], mcp: false, tope: 1, turnos: 4, persistir: true, sesion: 'abc' });
  assert.equal(a[a.indexOf('--resume') + 1], 'abc');
  assert.ok(!a.includes('--no-session-persistence'));
});

test('ejecutarClaude: éxito devuelve salida estructurada, uso y costo', async () => {
  process.env.PW_CLAUDE = falsoClaude({ type: 'result', is_error: false, subtype: 'success', result: '{}', structured_output: { respuestas: [] }, session_id: 's1', total_cost_usd: 0.01, modelUsage: { 'claude-haiku-5-5': { inputTokens: 2, outputTokens: 10, cacheReadInputTokens: 100, cacheCreationInputTokens: 50 } } });
  const r = await ejecutarClaude(['-p', 'x', '--json-schema', '{}'], { cwd: tmpdir() });
  assert.equal(r.ok, true);
  assert.deepEqual(r.salida, { respuestas: [] });
  assert.equal(r.sesion, 's1');
  assert.equal(r.costo, 0.01);
  assert.deepEqual(r.uso, { entrada: 2, cacheCreada: 50, cacheLeida: 100, salida: 10 });
  assert.equal(r.modelo, 'claude-haiku-5-5');
});

test('ejecutarClaude: tope alcanzado da ok=false con motivo legible', async () => {
  process.env.PW_CLAUDE = falsoClaude({ type: 'result', is_error: true, subtype: 'error_max_budget_usd', total_cost_usd: 0.5 }, 1);
  const r = await ejecutarClaude(['-p', 'x'], { cwd: tmpdir() });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'Se alcanzó el tope de costo del trabajo');
  assert.equal(r.costo, 0.5);
});

test('ejecutarClaude: límite de turnos da motivo legible', async () => {
  process.env.PW_CLAUDE = falsoClaude({ type: 'result', is_error: true, subtype: 'error_max_turns' }, 1);
  assert.equal((await ejecutarClaude(['-p', 'x'], { cwd: tmpdir() })).motivo, 'Se alcanzó el límite de turnos del trabajo');
});

test('ejecutarClaude: schema sin structured_output da ok=false', async () => {
  process.env.PW_CLAUDE = falsoClaude({ type: 'result', is_error: false, subtype: 'success', result: 'texto libre' });
  const r = await ejecutarClaude(['-p', 'x', '--json-schema', '{}'], { cwd: tmpdir() });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'La respuesta no llegó con el formato esperado');
});

test('costosDelDia suma solo el día pedido', () => {
  const p = { salida: mkdtempSync(join(tmpdir(), 'pw-costo-')) };
  registrarCosto(p, { tipo: 'responder', prId: 'r#1', modelo: 'haiku', costo: 0.1, ok: true, fecha: '2026-10-27T10:00:00Z' });
  registrarCosto(p, { tipo: 'responder', prId: 'r#1', modelo: 'haiku', costo: 0.2, ok: true, fecha: '2026-10-27T15:00:00Z' });
  registrarCosto(p, { tipo: 'responder', prId: 'r#1', modelo: 'haiku', costo: 5, ok: true, fecha: '2026-10-26T10:00:00Z' });
  const d = costosDelDia(p, '2026-10-27');
  assert.equal(d.trabajos, 2);
  assert.ok(Math.abs(d.total - 0.3) < 1e-9);
});
