import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODOS, PERFILES, estimarCosto, modoDe, perfil, sugerirUltra, topeDeTrabajo, topeRevisarPlantillas, topeRevisarUltra } from '../mcp/lib/perfiles.mjs';
import { TOPES, TURNOS, costosDelDia, registrarCosto, resumenCostos } from '../mcp/lib/ia.mjs';
import { requiereSegundaPasada } from '../mcp/lib/explicar.mjs';
import { filtrarPrs } from '../mcp/lib/filtrar.mjs';
import { responderPreguntas } from '../mcp/lib/preguntas.mjs';
import { guardarComentarios, leerComentarios } from '../mcp/lib/comentarios.mjs';
import { falsoClaude } from './util/claude.mjs';
import { fijarEnv, fijarTz } from './util/tz.mjs';

const ahora = Date.parse('2026-11-05T12:00:00Z');
const chica = { seguridad: false, adiciones: 20, eliminaciones: 5, esfuerzoTamano: 1 };
const sensible = { ...chica, seguridad: true };

const limpiarEnv = () => { for (const k of Object.keys(process.env)) if (k.startsWith('SEKI_IA_MODELO') || k.startsWith('SEKI_IA_TOPE')) delete process.env[k]; };
beforeEach(limpiarEnv);
afterEach(limpiarEnv);

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

test('cambiar never runs on haiku, whatever the source', (t) => {
  for (const modo of MODOS) assert.notEqual(perfil({ tipo: 'cambiar', modo, pr: chica }).modelo, 'haiku');
  fijarEnv(t, 'SEKI_IA_MODELO', 'haiku');
  assert.equal(perfil({ tipo: 'cambiar', modo: 'normal', pr: chica }).modelo, 'sonnet');
});

test('precedence: per-type env > general env > mode row > default', (t) => {
  assert.equal(perfil({ tipo: 'explicar', modo: 'ahorro', pr: chica }).modelo, 'sonnet');
  fijarEnv(t, 'SEKI_IA_MODELO', 'opus');
  assert.equal(perfil({ tipo: 'explicar', modo: 'ahorro', pr: chica }).modelo, 'opus');
  fijarEnv(t, 'SEKI_IA_MODELO_EXPLICAR', 'haiku');
  assert.equal(perfil({ tipo: 'explicar', modo: 'ahorro', pr: chica }).modelo, 'haiku');
});

test('cap env override applies per type', (t) => {
  fijarEnv(t, 'SEKI_IA_TOPE_EXPLICAR', '3.5');
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

test('cost records carry the mode and, when failed, only a classified reason', () => {
  const p = { salida: mkdtempSync(join(tmpdir(), 'seki-perf-')) };
  registrarCosto(p, { tipo: 'filtrar', modo: 'ahorro', costo: 0.1, ok: true, motivo: 'ignored when ok' });
  registrarCosto(p, { tipo: 'filtrar', modo: 'ahorro', costo: 0.1, ok: false, motivo: 'x'.repeat(500) });
  const lineas = readFileSync(join(p.salida, 'datos', 'costos.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lineas[0].modo, 'ahorro');
  assert.equal(lineas[0].motivo, undefined);
  assert.equal(lineas[1].motivo, 'The job failed');
});

test('filtrar and responder run with the mode profile and record mode and reason', async (t) => {
  const p = { salida: mkdtempSync(join(tmpdir(), 'seki-perf-')), ia: { modo: 'ahorro' } };
  const dirClaude = (ruta) => join(ruta, '..');
  const salida = { type: 'result', is_error: false, subtype: 'success', structured_output: { coincidencias: [] }, total_cost_usd: 0.01, modelUsage: { 'claude-haiku-5-5': {} } };
  fijarEnv(t, 'SEKI_CLAUDE', falsoClaude(salida, 0, 'echo "$@" > "$(dirname "$0")/args"'));
  await filtrarPrs(p, [{ id: 'a#1', repo: 'a', numero: 1, titulo: 'T', rama: 'r', headSha: 'h' }], 'algo');
  const args = readFileSync(join(dirClaude(process.env.SEKI_CLAUDE), 'args'), 'utf8');
  assert.match(args, /--model haiku/);
  const reg = JSON.parse(readFileSync(join(p.salida, 'datos', 'costos.jsonl'), 'utf8').trim());
  assert.equal(reg.modo, 'ahorro');

  const q = { salida: mkdtempSync(join(tmpdir(), 'seki-perf-')) };
  guardarComentarios(q, 'r', 1, [{ id: 'c-0001', tipo: 'pregunta', estado: 'borrador', archivo: 'a.ts', lado: 'nuevo', desde: 1, hasta: 2, textoOriginal: 'x', texto: '¿Qué?', headSha: 'abc' }]);
  fijarEnv(t, 'SEKI_CLAUDE', falsoClaude({ type: 'result', is_error: true, subtype: 'error_max_turns', total_cost_usd: 0.02, modelUsage: { 'claude-sonnet-5-5': {} } }, 1));
  await responderPreguntas(q, { id: 'r#1', repo: 'r', numero: 1, titulo: 'T', headSha: 'abc', adiciones: 500, eliminaciones: 0 }, ['c-0001'], { contexto: async () => 'C', detalle: async () => null, modo: 'normal' });
  const f = JSON.parse(readFileSync(join(q.salida, 'datos', 'costos.jsonl'), 'utf8').trim());
  assert.equal(f.modo, 'normal');
  assert.equal(f.ok, false);
  assert.equal(f.motivo, 'The job reached its turn limit');
  assert.ok(leerComentarios(q, 'r', 1)[0]);
});

test('costosDelDia uses the local day: 03:00Z in Bogota belongs to the previous day', (t) => {
  fijarTz(t, 'America/Bogota');
  const p = { salida: mkdtempSync(join(tmpdir(), 'seki-perf-')) };
  registrarCosto(p, { tipo: 'responder', costo: 1, ok: true, fecha: '2026-10-27T03:00:00Z' });
  registrarCosto(p, { tipo: 'responder', costo: 2, ok: true, fecha: '2026-10-27T15:00:00Z' });
  assert.equal(costosDelDia(p, '2026-10-26').total, 1);
  assert.equal(costosDelDia(p, '2026-10-27').total, 2);
});

test('resumenCostos still groups by model with the mode data present', () => {
  const p = { salida: mkdtempSync(join(tmpdir(), 'seki-perf-')) };
  registrarCosto(p, { tipo: 'explicar', prId: 'a#1', modelo: 'claude-sonnet-5-5', costo: 1, ok: true, modo: 'ahorro' });
  assert.equal(resumenCostos(p).modelos.sonnet.trabajos, 1);
});

const reg = (costo, extra = {}) => ({ tipo: 'explicar', modo: 'normal', costo, fecha: '2026-11-01T10:00:00Z', ok: true, ...extra });

test('estimarCosto: median of the last 30 days for the same type and mode, times the multiplier', () => {
  const r = estimarCosto([reg(1), reg(9), reg(3), reg(100, { modo: 'ahorro' }), reg(100, { tipo: 'responder' }), reg(100, { fecha: '2026-09-01T00:00:00Z' })], { tipo: 'explicar', modo: 'normal', multiplicador: 2, topeUsd: 4, ahora });
  assert.deepEqual(r, { usd: 6, base: 'historial', muestras: 3 });
  assert.equal(estimarCosto([reg(1), reg(2), reg(3), reg(10)], { tipo: 'explicar', modo: 'normal', topeUsd: 4, ahora }).usd, 2.5);
});

test('estimarCosto: records without mode count as normal; fewer than 3 samples fall back to the cap', () => {
  const sinModo = { tipo: 'explicar', costo: 1, fecha: '2026-11-01T10:00:00Z' };
  assert.equal(estimarCosto([sinModo, sinModo, sinModo], { tipo: 'explicar', modo: 'normal', topeUsd: 4, ahora }).base, 'historial');
  assert.deepEqual(estimarCosto([reg(1), reg(2)], { tipo: 'explicar', modo: 'normal', multiplicador: 3, topeUsd: 4, ahora }), { usd: 4, base: 'topes', muestras: 2 });
  assert.deepEqual(estimarCosto([], { tipo: 'revisar_ultra', modo: 'ultra', topeUsd: topeRevisarUltra(), ahora }), { usd: 5.5, base: 'topes', muestras: 0 });
});

test('estimarCosto: Ultra uses revisar_ultra records', () => {
  const u = (c) => reg(c, { tipo: 'revisar_ultra', modo: 'ultra' });
  assert.deepEqual(estimarCosto([u(2), u(3), u(4), reg(50)], { tipo: 'revisar_ultra', modo: 'ultra', topeUsd: 5.5, ahora }), { usd: 3, base: 'historial', muestras: 3 });
});

test('sugerirUltra: sensitive path or security flag, reasons name the pattern and never the file', () => {
  const p = { ia: { patronesSensibles: [/(^|\/)auth\//, /pagos?\.ts$/] } };
  const r = sugerirUltra(p, { seguridad: false }, ['src/auth/login.ts', { filename: 'docs/a.md' }, 'x/pago.ts']);
  assert.equal(r.sugerida, true);
  assert.equal(r.motivos.length, 2);
  assert.ok(r.motivos.every((m) => !m.includes('login.ts') && !m.includes('pago.ts')));
  assert.ok(r.motivos[0].includes('auth'));
  assert.deepEqual(sugerirUltra(p, { seguridad: false }, ['docs/a.md']), { sugerida: false, motivos: [] });
  assert.equal(sugerirUltra({}, { seguridad: true }, []).sugerida, true);
  assert.equal(sugerirUltra(null, {}, undefined).sugerida, false);
});

test('resumenCostos: per-mode table, no mode counts as normal, ratings follow the rated mode', () => {
  const p = { salida: mkdtempSync(join(tmpdir(), 'seki-perf-')) };
  const f = '2026-11-01T10:00:00.000Z';
  registrarCosto(p, { fecha: f, tipo: 'responder', prId: 'a#1', modelo: 'claude-haiku-5-5', costo: 0.1, ok: true, modo: 'ahorro' });
  registrarCosto(p, { fecha: f, tipo: 'responder', prId: 'a#1', modelo: 'claude-haiku-5-5', costo: 0.3, ok: false, modo: 'ahorro' });
  registrarCosto(p, { fecha: f, tipo: 'explicar', prId: 'a#1', modelo: 'claude-sonnet-5-5', costo: 1, ok: true });
  registrarCosto(p, { fecha: f, tipo: 'valoracion', comentario: 'c-1', modelo: 'claude-haiku-5-5', modo: 'ahorro', util: true, costo: 0 });
  registrarCosto(p, { fecha: f, tipo: 'valoracion', comentario: 'c-2', modelo: 'claude-sonnet-5-5', util: false, costo: 0 });
  const { modos } = resumenCostos(p, { ahora });
  assert.deepEqual(modos.ahorro, { trabajos: 2, fallidos: 1, costo: 0.4, utiles: 1, noUtiles: 0, costoPorUtil: 0.4 });
  assert.equal(modos.normal.trabajos, 1);
  assert.equal(modos.normal.noUtiles, 1);
  assert.equal(modos.normal.costoPorUtil, null);
});

test('topeDeTrabajo: explicar adds its second pass only when the mode has one and not when completing', () => {
  assert.equal(topeDeTrabajo({ tipo: 'explicar', modo: 'normal' }), 4);
  assert.equal(topeDeTrabajo({ tipo: 'explicar', modo: 'normal', completar: true }), 2);
  assert.equal(topeDeTrabajo({ tipo: 'explicar', modo: 'ahorro' }), 2);
});

test('topeDeTrabajo: cambiar counts its retry, responder one cap per question, investigar one cap', () => {
  assert.equal(topeDeTrabajo({ tipo: 'cambiar', modo: 'ahorro' }), 3);
  assert.equal(topeDeTrabajo({ tipo: 'responder', modo: 'normal', n: 3 }), 1.5);
  assert.equal(topeDeTrabajo({ tipo: 'investigar', modo: 'ahorro' }), 1);
});

test('estimarCosto without a cap falls back to zero', () => {
  assert.deepEqual(estimarCosto([], { tipo: 'explicar', modo: 'normal', ahora }), { usd: 0, base: 'topes', muestras: 0 });
});

test('answered, investigated and proposed items store the mode the rating will carry', async (t) => {
  const prId = { id: 'r#1', repo: 'r', numero: 1, titulo: 'T', headSha: 'abc', adiciones: 5, eliminaciones: 0, estadoPr: 'OPEN' };
  const q = { salida: mkdtempSync(join(tmpdir(), 'seki-perf-')) };
  const pregunta = (id) => ({ id, tipo: 'pregunta', estado: 'borrador', archivo: 'a.ts', lado: 'nuevo', desde: 1, hasta: 2, textoOriginal: 'x', texto: '¿Qué?', headSha: 'abc' });
  guardarComentarios(q, 'r', 1, [pregunta('c-0001')]);
  fijarEnv(t, 'SEKI_CLAUDE', falsoClaude({ type: 'result', is_error: false, subtype: 'success', structured_output: { respuestas: [{ id: 'c-0001', texto: 'A.' }] }, total_cost_usd: 0.01, modelUsage: { 'claude-haiku-5-5': {} } }));
  await responderPreguntas(q, prId, ['c-0001'], { contexto: async () => 'C', detalle: async () => null, modo: 'ahorro' });
  assert.equal(leerComentarios(q, 'r', 1)[0].modo, 'ahorro');
});

test('topeDeTrabajo: cambiar reserves two calls for each change request of the job', () => {
  assert.equal(topeDeTrabajo({ tipo: 'cambiar', modo: 'normal', n: 3 }), 9);
  assert.equal(topeDeTrabajo({ tipo: 'cambiar', modo: 'normal', n: 1 }), 3);
  assert.equal(topeDeTrabajo({ tipo: 'cambiar', modo: 'normal' }), 3);
});

test('topeRevisarUltra(n) counts n lenses and the verification', () => {
  assert.equal(topeRevisarUltra(2), 4);
  assert.equal(topeRevisarUltra(3), topeRevisarUltra());
  assert.equal(topeRevisarUltra(0), 1);
});

test('topeRevisarUltra honours the cap variables of the Ultra steps', () => {
  const antes = [process.env.SEKI_IA_TOPE_ULTRA_LENTE, process.env.SEKI_IA_TOPE_ULTRA_VERIFICAR];
  try {
    process.env.SEKI_IA_TOPE_ULTRA_LENTE = '2';
    process.env.SEKI_IA_TOPE_ULTRA_VERIFICAR = '0.5';
    assert.equal(topeRevisarUltra(), 6.5);
  } finally {
    for (const [k, v] of [['SEKI_IA_TOPE_ULTRA_LENTE', antes[0]], ['SEKI_IA_TOPE_ULTRA_VERIFICAR', antes[1]]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  assert.equal(topeRevisarUltra(), 5.5);
});

test('sugerirUltra matches under a time limit: a catastrophic pattern cannot hang it', () => {
  const p = { ia: { patronesSensibles: [/(a+)+$/] } };
  const t0 = Date.now();
  assert.equal(sugerirUltra(p, {}, [`${'a'.repeat(40)}!`]).sugerida, false);
  assert.ok(Date.now() - t0 < 2000);
});

test('topeRevisarPlantillas(2) equals 2 * plantilla cap + ultra_verificar cap', () => {
  for (const modo of MODOS) assert.deepEqual(perfil({ tipo: 'plantilla', modo }), { modo, modelo: 'sonnet', topeUsd: 1, turnos: 25, segundaPasada: false });
  assert.equal(topeRevisarPlantillas(2), 2 * perfil({ tipo: 'plantilla', modo: 'normal' }).topeUsd + perfil({ tipo: 'ultra_verificar', modo: 'normal' }).topeUsd);
  assert.equal(topeRevisarPlantillas(2), 3);
  assert.equal(topeRevisarPlantillas(0), 0);
});

test('triar_checks is a regular job: sonnet in ahorro, difficulty rule in normal, cap 1', () => {
  assert.equal(perfil({ tipo: 'triar_checks', modo: 'ahorro' }).modelo, 'sonnet');
  assert.deepEqual(PERFILES.normal.triar_checks, { modelo: null, topeUsd: 1, turnos: 25, segundaPasada: false });
  assert.equal(topeDeTrabajo({ tipo: 'triar_checks', modo: 'normal' }), 1);
});
