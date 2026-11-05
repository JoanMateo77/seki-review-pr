import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { crearPresupuesto, gastoMaquina, mensajeBloqueo } from '../mcp/lib/presupuesto.mjs';
import { diaLocal, registrarCosto } from '../mcp/lib/ia.mjs';
import { fijarTz } from './util/tz.mjs';

test('gastoMaquina sums today across every project, failed jobs included and ratings excluded', () => {
  const a = { salida: mkdtempSync(join(tmpdir(), 'seki-pres-')) };
  const b = { salida: mkdtempSync(join(tmpdir(), 'seki-pres-')) };
  const ahora = Date.parse('2026-10-27T17:00:00Z');
  registrarCosto(a, { tipo: 'explicar', costo: 1, ok: true, fecha: '2026-10-27T17:00:00Z' });
  registrarCosto(a, { tipo: 'explicar', costo: 0.5, ok: false, fecha: '2026-10-27T17:00:00Z' });
  registrarCosto(a, { tipo: 'valoracion', costo: 9, fecha: '2026-10-27T17:00:00Z' });
  registrarCosto(b, { tipo: 'responder', costo: 0.25, ok: true, fecha: '2026-10-27T18:00:00Z' });
  registrarCosto(b, { tipo: 'responder', costo: 7, ok: true, fecha: '2026-10-20T18:00:00Z' });
  appendFileSync(join(b.salida, 'datos', 'costos.jsonl'), 'not json\n');
  assert.equal(gastoMaquina({ proyectos: { a, b, sinSalida: {} }, ahora }), 1.75);
  assert.equal(gastoMaquina({ proyectos: [a], ahora }), 1.5);
  assert.equal(gastoMaquina({ proyectos: { x: { salida: join(tmpdir(), 'seki-no-existe-xyz') } }, ahora }), 0);
});

test('gate: two jobs with room for one: the second is blocked until the first releases less than reserved', () => {
  const p = crearPresupuesto({ limite: () => 1, gasto: () => 0, ahora: () => 1000 });
  assert.equal(p.cabe(0.6), true);
  const r1 = p.reservar(0.6);
  assert.equal(p.cabe(0.6), false);
  r1.liberar(0.1);
  assert.equal(p.cabe(0.6), true);
  assert.deepEqual(p.estado(), { limite: 1, gastado: 0.1, reservado: 0 });
  r1.liberar(5);
  assert.equal(p.estado().gastado, 0.1);
});

test('gate: no limit never blocks', () => {
  const p = crearPresupuesto({ limite: () => null, gasto: () => 999 });
  assert.equal(p.cabe(1000), true);
});

test('gate: spend is cached for 30 s and re-read afterwards', () => {
  let t = Date.parse('2026-10-27T15:00:00Z');
  let gasto = 0;
  let lecturas = 0;
  const p = crearPresupuesto({ limite: () => 10, gasto: () => { lecturas++; return gasto; }, ahora: () => t });
  p.cabe(1);
  gasto = 5;
  t += 10000;
  assert.equal(p.estado().gastado, 0);
  t += 25000;
  assert.equal(p.estado().gastado, 5);
  assert.equal(lecturas, 2);
});

test('gate: at local midnight yesterday spend stops counting', (t) => {
  fijarTz(t, 'America/Bogota');
  let ahora = Date.parse('2026-10-27T04:59:50Z'); // 23:59:50 local on the 26th
  const p = { salida: mkdtempSync(join(tmpdir(), 'seki-pres-')) };
  registrarCosto(p, { tipo: 'explicar', costo: 9.5, ok: true, fecha: '2026-10-27T04:00:00Z' });
  registrarCosto(p, { tipo: 'explicar', costo: 0.25, ok: true, fecha: '2026-10-27T05:00:05Z' });
  const presupuesto = crearPresupuesto({ limite: () => 10, gasto: () => gastoMaquina({ proyectos: [p], ahora }), ahora: () => ahora });
  assert.equal(diaLocal(ahora), '2026-10-26');
  assert.equal(presupuesto.cabe(1), false);
  ahora += 15000; // 00:00:05 local on the 27th, inside the 30 s cache
  assert.equal(diaLocal(ahora), '2026-10-27');
  assert.equal(presupuesto.cabe(1), true);
  assert.equal(presupuesto.estado().gastado, 0.25);
});

test('gate: a release after a spend re-read does not count the job cost twice', () => {
  let t = 1000;
  let enDisco = 0;
  const p = crearPresupuesto({ limite: () => 10, gasto: () => enDisco, ahora: () => t });
  const r = p.reservar(2);
  enDisco = 0.5; // the job already wrote part of its cost
  t += 31000;
  assert.equal(p.estado().gastado, 0.5);
  enDisco = 0.8; // and the rest before releasing
  r.liberar(0.8);
  assert.equal(p.estado().gastado, 0.8);
});

test('gate: a release without a re-read adds the cost to the cached spend', () => {
  let enDisco = 0;
  const p = crearPresupuesto({ limite: () => 10, gasto: () => enDisco, ahora: () => 1000 });
  const r = p.reservar(2);
  enDisco = 0.8;
  r.liberar(0.8);
  assert.equal(p.estado().gastado, 0.8);
});

test('blocked message names the spent amount and the limit', () => {
  assert.equal(mensajeBloqueo({ limite: 5, gastado: 4.2, reservado: 0.3 }, 0.6), 'Blocked by the daily budget ($4.50 of $5.00 spent)');
  assert.match(mensajeBloqueo({ limite: 1, gastado: 0, reservado: 0 }, 4), /exceeds the daily limit of \$1\.00 on its own/);
});
