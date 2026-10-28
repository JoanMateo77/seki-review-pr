import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearCola } from '../mcp/lib/trabajos.mjs';

const esperar = (cola) => new Promise((ok) => { const v = setInterval(() => { if (cola.lista().every((t) => !['en_cola', 'en_curso'].includes(t.estado))) { clearInterval(v); ok(); } }, 5); });

test('cola: ejecuta, guarda costo y modelo, y no duplica un trabajo activo', async () => {
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

test('cola: resultado ok=false o excepción quedan en error con mensaje', async () => {
  const cola = crearCola();
  cola.encolar([
    { id: 'a', tipo: 'explicar', prId: 'a', ejecutar: async () => ({ ok: false, motivo: 'Se alcanzó el tope de costo del trabajo' }) },
    { id: 'b', tipo: 'explicar', prId: 'b', ejecutar: async () => { throw new Error('falló git'); } },
  ]);
  await esperar(cola);
  const [a, b] = cola.lista();
  assert.equal(a.estado, 'error');
  assert.equal(a.mensaje, 'Se alcanzó el tope de costo del trabajo');
  assert.equal(b.mensaje, 'falló git');
});

test('cola: vaciar avisa a cada trabajo cancelado', async () => {
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
