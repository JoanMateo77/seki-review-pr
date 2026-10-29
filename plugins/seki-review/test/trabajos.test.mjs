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
