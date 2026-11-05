import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODOS, PERFILES, modoDe, perfil } from '../mcp/lib/perfiles.mjs';
import { TOPES, TURNOS, costosDelDia, registrarCosto, resumenCostos } from '../mcp/lib/ia.mjs';
import { requiereSegundaPasada } from '../mcp/lib/explicar.mjs';
import { filtrarPrs } from '../mcp/lib/filtrar.mjs';
import { responderPreguntas } from '../mcp/lib/preguntas.mjs';
import { guardarComentarios, leerComentarios } from '../mcp/lib/comentarios.mjs';
import { falsoClaude } from './util/claude.mjs';

const chica = { seguridad: false, adiciones: 20, eliminaciones: 5, esfuerzoTamano: 1 };
const sensible = { ...chica, seguridad: true };

beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('SEKI_IA_MODELO') || k.startsWith('SEKI_IA_TOPE')) delete process.env[k];
});

test('modes are the three known values', () => {
  assert.deepEqual(MODOS, ['ahorro', 'normal', 'ultra']);
});

test('TOPES and TURNOS keep their historical values (normal row)', () => {
  assert.deepEqual(TOPES, { responder: 0.5, explicar: 2, cambiar: 1.5, investigar: 1, filtrar: 0.5 });
  assert.deepEqual(TURNOS, { responder: 4, explicar: 30, cambiar: 40, investigar: 25, filtrar: 3 });
});

test('ahorro: responder and filtrar use haiku, everything else sonnet even for security PRs', () => {
  assert.equal(perfil({ tipo: 'responder', modo: 'ahorro', pr: chica, lineasSeleccionadas: 500 }).modelo, 'haiku');
  assert.equal(perfil({ tipo: 'filtrar', modo: 'ahorro' }).modelo, 'haiku');
  for (const tipo of ['explicar', 'cambiar', 'investigar']) assert.equal(perfil({ tipo, modo: 'ahorro', pr: sensible }).modelo, 'sonnet', tipo);
});

test('ahorro skips the explanation second pass; normal and ultra keep it', () => {
  assert.equal(perfil({ tipo: 'explicar', modo: 'ahorro' }).segundaPasada, false);
  assert.equal(perfil({ tipo: 'explicar', modo: 'normal' }).segundaPasada, true);
  assert.equal(perfil({ tipo: 'explicar', modo: 'ultra' }).segundaPasada, true);
  assert.equal(requiereSegundaPasada({ ok: true, segundaPasada: false, completar: false, cobertura: { sinDiff: ['src/a.ts'] } }), false);
  assert.equal(requiereSegundaPasada({ ok: true, segundaPasada: true, completar: false, cobertura: { sinDiff: ['src/a.ts'] } }), true);
});

test('normal keeps the difficulty rule and filtrar on sonnet', () => {
  assert.equal(perfil({ tipo: 'explicar', modo: 'normal', pr: sensible }).modelo, 'opus');
  assert.equal(perfil({ tipo: 'responder', modo: 'normal', pr: chica, lineasSeleccionadas: 3 }).modelo, 'haiku');
  assert.equal(perfil({ tipo: 'filtrar', modo: 'normal' }).modelo, 'sonnet');
});

test('ultra equals normal for regular jobs; lens and verification have their own rows', () => {
  for (const tipo of ['responder', 'explicar', 'cambiar', 'investigar', 'filtrar']) assert.deepEqual(PERFILES.ultra[tipo], PERFILES.normal[tipo]);
  assert.deepEqual(perfil({ tipo: 'ultra_lente', modo: 'ahorro' }), { modo: 'ahorro', modelo: 'sonnet', topeUsd: 1.5, turnos: 25, segundaPasada: false });
  assert.deepEqual(perfil({ tipo: 'ultra_verificar', modo: 'normal' }), { modo: 'normal', modelo: 'sonnet', topeUsd: 1, turnos: 30, segundaPasada: false });
});

test('cambiar never runs on haiku, whatever the source', () => {
  for (const modo of MODOS) assert.notEqual(perfil({ tipo: 'cambiar', modo, pr: chica }).modelo, 'haiku');
  process.env.SEKI_IA_MODELO = 'haiku';
  assert.equal(perfil({ tipo: 'cambiar', modo: 'normal', pr: chica }).modelo, 'sonnet');
});

test('precedence: per-type env > general env > mode row > default', () => {
  assert.equal(perfil({ tipo: 'explicar', modo: 'ahorro', pr: chica }).modelo, 'sonnet');
  process.env.SEKI_IA_MODELO = 'opus';
  assert.equal(perfil({ tipo: 'explicar', modo: 'ahorro', pr: chica }).modelo, 'opus');
  process.env.SEKI_IA_MODELO_EXPLICAR = 'haiku';
  assert.equal(perfil({ tipo: 'explicar', modo: 'ahorro', pr: chica }).modelo, 'haiku');
});

test('cap env override applies per type', () => {
  process.env.SEKI_IA_TOPE_EXPLICAR = '3.5';
  assert.equal(perfil({ tipo: 'explicar', modo: 'normal' }).topeUsd, 3.5);
  assert.equal(perfil({ tipo: 'responder', modo: 'normal' }).topeUsd, 0.5);
});

test('modoDe: valid override, then project mode, then normal', () => {
  assert.equal(modoDe({ ia: { modo: 'ahorro' } }, 'ultra'), 'ultra');
  assert.equal(modoDe({ ia: { modo: 'ahorro' } }, 'otro'), 'ahorro');
  assert.equal(modoDe({ ia: { modo: 'ahorro' } }), 'ahorro');
  assert.equal(modoDe({}, undefined), 'normal');
  assert.equal(modoDe(null, 'x'), 'normal');
});

test('perfil rejects unknown job types and falls back to normal for an invalid mode', () => {
  assert.throws(() => perfil({ tipo: 'nada', modo: 'normal' }), /Unknown AI job type/);
  assert.equal(perfil({ tipo: 'explicar', modo: 'raro' }).modo, 'normal');
});

test('cost records carry the mode and, when failed, a reason capped at 200 characters', () => {
  const p = { salida: mkdtempSync(join(tmpdir(), 'seki-perf-')) };
  registrarCosto(p, { tipo: 'filtrar', modo: 'ahorro', costo: 0.1, ok: true, motivo: 'ignored when ok' });
  registrarCosto(p, { tipo: 'filtrar', modo: 'ahorro', costo: 0.1, ok: false, motivo: 'x'.repeat(500) });
  const lineas = readFileSync(join(p.salida, 'datos', 'costos.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lineas[0].modo, 'ahorro');
  assert.equal(lineas[0].motivo, undefined);
  assert.equal(lineas[1].motivo.length, 200);
});

test('filtrar and responder run with the mode profile and record mode and reason', async () => {
  const p = { salida: mkdtempSync(join(tmpdir(), 'seki-perf-')), ia: { modo: 'ahorro' } };
  const dirClaude = (ruta) => join(ruta, '..');
  const salida = { type: 'result', is_error: false, subtype: 'success', structured_output: { coincidencias: [] }, total_cost_usd: 0.01, modelUsage: { 'claude-haiku-5-5': {} } };
  process.env.SEKI_CLAUDE = falsoClaude(salida, 0, 'echo "$@" > "$(dirname "$0")/args"');
  await filtrarPrs(p, [{ id: 'a#1', repo: 'a', numero: 1, titulo: 'T', rama: 'r', headSha: 'h' }], 'algo');
  const args = readFileSync(join(dirClaude(process.env.SEKI_CLAUDE), 'args'), 'utf8');
  assert.match(args, /--model haiku/);
  const reg = JSON.parse(readFileSync(join(p.salida, 'datos', 'costos.jsonl'), 'utf8').trim());
  assert.equal(reg.modo, 'ahorro');

  const q = { salida: mkdtempSync(join(tmpdir(), 'seki-perf-')) };
  guardarComentarios(q, 'r', 1, [{ id: 'c-0001', tipo: 'pregunta', estado: 'borrador', archivo: 'a.ts', lado: 'nuevo', desde: 1, hasta: 2, textoOriginal: 'x', texto: '¿Qué?', headSha: 'abc' }]);
  process.env.SEKI_CLAUDE = falsoClaude({ type: 'result', is_error: true, subtype: 'error_max_turns', total_cost_usd: 0.02, modelUsage: { 'claude-sonnet-5-5': {} } }, 1);
  await responderPreguntas(q, { id: 'r#1', repo: 'r', numero: 1, titulo: 'T', headSha: 'abc', adiciones: 500, eliminaciones: 0 }, ['c-0001'], { contexto: async () => 'C', detalle: async () => null, modo: 'normal' });
  const f = JSON.parse(readFileSync(join(q.salida, 'datos', 'costos.jsonl'), 'utf8').trim());
  assert.equal(f.modo, 'normal');
  assert.equal(f.ok, false);
  assert.equal(f.motivo, 'The job reached its turn limit');
  assert.ok(leerComentarios(q, 'r', 1)[0]);
});

test('costosDelDia uses the local day: 03:00Z in Bogota belongs to the previous day', () => {
  const previo = process.env.TZ;
  process.env.TZ = 'America/Bogota';
  try {
    const p = { salida: mkdtempSync(join(tmpdir(), 'seki-perf-')) };
    registrarCosto(p, { tipo: 'responder', costo: 1, ok: true, fecha: '2026-10-27T03:00:00Z' });
    registrarCosto(p, { tipo: 'responder', costo: 2, ok: true, fecha: '2026-10-27T15:00:00Z' });
    assert.equal(costosDelDia(p, '2026-10-26').total, 1);
    assert.equal(costosDelDia(p, '2026-10-27').total, 2);
  } finally {
    previo === undefined ? delete process.env.TZ : (process.env.TZ = previo);
  }
});

test('resumenCostos still groups by model with the mode data present', () => {
  const p = { salida: mkdtempSync(join(tmpdir(), 'seki-perf-')) };
  registrarCosto(p, { tipo: 'explicar', prId: 'a#1', modelo: 'claude-sonnet-5-5', costo: 1, ok: true, modo: 'ahorro' });
  assert.equal(resumenCostos(p).modelos.sonnet.trabajos, 1);
});
