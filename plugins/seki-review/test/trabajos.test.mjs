import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearCola } from '../mcp/lib/trabajos.mjs';

const esperar = (cola) => new Promise((ok) => { const v = setInterval(() => { if (cola.lista().every((t) => !['en_cola', 'en_curso'].includes(t.estado))) { clearInterval(v); ok(); } }, 5); });

test('queue: runs, stores cost and model, and does not duplicate an active job', async () => {
  let n = 0;
  const cola = crearCola();
  const item = { id: 'r#1', tipo: 'explicar', prId: 'r#1', ejecutar: async () => { n++; return { ok: true, costo: 0.1, modelo: 'sonnet' } } };
  assert.equal(cola.encolar([item, item]), 1);
  await esperar(cola);
  const [t] = cola.lista();
  assert.equal(n, 1);
  assert.equal(t.estado, 'terminado');
  assert.equal(t.costo, 0.1);
  assert.equal(t.modelo, 'sonnet');
  assert.equal(t.ejecutar, undefined);
});

test('queue: an ok=false result or an exception ends in error with a message', async () => {
  const cola = crearCola();
  cola.encolar([
    { id: 'a', tipo: 'explicar', prId: 'a', ejecutar: async () => ({ ok: false, motivo: 'The job cost cap was reached' }) },
    { id: 'b', tipo: 'explicar', prId: 'b', ejecutar: async () => { throw new Error('git failed'); } },
  ]);
  await esperar(cola);
  const [a, b] = cola.lista();
  assert.equal(a.estado, 'error');
  assert.equal(a.mensaje, 'The job cost cap was reached');
  assert.equal(b.mensaje, 'git failed');
});

test('queue: emptying notifies each cancelled job', async () => {
  const cancelados = [];
  const cola = crearCola();
  let soltar;
  const bloqueo = new Promise((ok) => { soltar = ok; });
  cola.encolar([
    { id: 'a', tipo: 'x', prId: 'a', ejecutar: () => bloqueo },
    { id: 'b', tipo: 'x', prId: 'b', ejecutar: async () => ({ ok: true }), alCancelar: () => cancelados.push('b') },
  ]);
  assert.equal(cola.vaciar(), 1);
  assert.deepEqual(cancelados, ['b']);
  soltar({ ok: true });
});

test('queue: detener cancels the queued jobs and resolves only after the running one finished', async () => {
  let soltar;
  const retenido = new Promise((ok) => { soltar = ok; });
  const orden = [];
  const cola = crearCola();
  cola.encolar([
    { id: 'a', tipo: 'explicar', prId: 'a', ejecutar: async () => { await retenido; orden.push('a terminado'); return { ok: true }; } },
    { id: 'b', tipo: 'explicar', prId: 'b', ejecutar: async () => { orden.push('b'); return { ok: true }; }, alCancelar: () => orden.push('b cancelado') },
  ]);
  const parada = cola.detener().then(() => orden.push('detenida'));
  assert.deepEqual(cola.lista().map((t) => t.estado), ['en_curso', 'cancelado']);
  soltar();
  await parada;
  assert.deepEqual(orden, ['b cancelado', 'a terminado', 'detenida']);
  assert.equal(cola.lista()[0].estado, 'terminado');
});

import { crearPresupuesto } from '../mcp/lib/presupuesto.mjs';

const hasta = async (cond) => { for (let i = 0; i < 400 && !cond(); i++) await new Promise((ok) => setTimeout(ok, 5)); assert.ok(cond(), 'condition not reached'); };

test('budget: a job that does not fit is blocked, then starts by itself when the first ends cheaper', async () => {
  process.env.SEKI_IA_PARALELO = '2';
  let soltar;
  const primero = new Promise((ok) => { soltar = ok; });
  const corridos = [];
  const cola = crearCola({ presupuesto: crearPresupuesto({ limite: () => 1, gasto: () => 0 }) });
  cola.encolar([
    { id: 'a', tipo: 'explicar', prId: 'a', topeUsd: 0.6, ejecutar: async () => { corridos.push('a'); await primero; return { ok: true, costo: 0.1 }; } },
    { id: 'b', tipo: 'explicar', prId: 'b', topeUsd: 0.6, ejecutar: async () => { corridos.push('b'); return { ok: true, costo: 0.1 }; } },
  ]);
  await hasta(() => cola.lista().find((t) => t.id === 'b').estado === 'bloqueado_presupuesto');
  const b = cola.lista().find((t) => t.id === 'b');
  assert.match(b.mensaje, /^Blocked by the daily budget \(\$0\.60 of \$1\.00 spent\)$/);
  assert.deepEqual(corridos, ['a']);
  soltar();
  await hasta(() => cola.lista().every((t) => t.estado === 'terminado'));
  assert.deepEqual(corridos, ['a', 'b']);
  assert.equal(cola.lista().find((t) => t.id === 'b').mensaje, null);
  delete process.env.SEKI_IA_PARALELO;
});

test('budget: failed jobs release their reservation and count their cost', async () => {
  const cola = crearCola({ presupuesto: crearPresupuesto({ limite: () => 1, gasto: () => 0 }) });
  cola.encolar([{ id: 'a', tipo: 'x', prId: 'a', topeUsd: 0.9, ejecutar: async () => ({ ok: false, motivo: 'boom', costo: 0.9 }) }]);
  await esperar(cola);
  cola.encolar([{ id: 'b', tipo: 'x', prId: 'b', topeUsd: 0.2, ejecutar: async () => ({ ok: true }) }]);
  await hasta(() => cola.lista().find((t) => t.id === 'b').estado === 'bloqueado_presupuesto');
});

test('budget: forcing runs that job once and the next one is gated again', async () => {
  const corridos = [];
  const cola = crearCola({ presupuesto: crearPresupuesto({ limite: () => 1, gasto: () => 5 }) });
  const item = (id) => ({ id, tipo: 'x', prId: id, topeUsd: 0.5, ejecutar: async () => { corridos.push(id); return { ok: true, costo: 0 }; } });
  cola.encolar([item('a'), item('b')]);
  await hasta(() => cola.lista().every((t) => t.estado === 'bloqueado_presupuesto'));
  assert.equal(cola.forzar('a'), true);
  assert.equal(cola.forzar('nada'), false);
  await hasta(() => cola.lista().find((t) => t.id === 'a').estado === 'terminado');
  assert.deepEqual(corridos, ['a']);
  assert.equal(cola.lista().find((t) => t.id === 'b').estado, 'bloqueado_presupuesto');
  assert.equal(cola.forzar('a'), false);
});

test('budget: without a limit nothing is blocked; emptying cancels blocked jobs', async () => {
  const libre = crearCola({ presupuesto: crearPresupuesto({ limite: () => null, gasto: () => 99 }) });
  libre.encolar([{ id: 'a', tipo: 'x', prId: 'a', topeUsd: 50, ejecutar: async () => ({ ok: true }) }]);
  await esperar(libre);
  assert.equal(libre.lista()[0].estado, 'terminado');

  const cancelados = [];
  const cola = crearCola({ presupuesto: crearPresupuesto({ limite: () => 1, gasto: () => 5 }) });
  cola.encolar([{ id: 'a', tipo: 'x', prId: 'a', topeUsd: 0.5, alCancelar: () => cancelados.push('a'), ejecutar: async () => ({ ok: true }) }]);
  await hasta(() => cola.lista()[0].estado === 'bloqueado_presupuesto');
  assert.equal(cola.encolar([{ id: 'a', tipo: 'x', prId: 'a', topeUsd: 0.5, ejecutar: async () => ({ ok: true }) }]), 0);
  assert.equal(cola.vaciar(), 1);
  assert.equal(cola.lista()[0].estado, 'cancelado');
  assert.deepEqual(cancelados, ['a']);
});
