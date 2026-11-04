import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The dashboard poll loop, run in a vm with fake timers and a fake API.
const fuente = readFileSync(new URL('../mcp/tablero/partes/08-script-5.js', import.meta.url), 'utf8');
const inicio = fuente.indexOf('// One poll at a time');
const fin = fuente.indexOf('  otraVez = false;\n}\n', inicio) + '  otraVez = false;\n}\n'.length;
assert.ok(inicio >= 0 && fin > inicio, 'poll loop not found in 08-script-5.js');

function armar() {
  const timers = new Map();
  let siguiente = 1;
  const pedidos = [];
  const ctx = {
    estado: { trabajos: new Map(), marcasComentarios: {}, comentariosCargados: new Set() },
    FOTO: { prs: [] },
    document: { visibilityState: 'visible', activeElement: null },
    $: () => ({ contains: () => false }),
    pintarTodo() {},
    pintarBarra() {},
    recargarEntregas() {},
    sincronizarComentarios() {},
    api(ruta) {
      if (ruta !== '/api/estado') return Promise.resolve({});
      let resolver;
      const p = new Promise((r) => { resolver = r; });
      pedidos.push(() => resolver({ trabajos: [], refrescando: false, ultimoRefresco: null, costoHoy: null }));
      return p;
    },
    setTimeout(fn, ms) { const id = siguiente++; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.createContext(ctx);
  vm.runInContext(`${fuente.slice(inicio, fin)}\nglobalThis.sondear = sondear;\nglobalThis.timer = () => sondeo;`, ctx);
  return { ctx, timers, pedidos };
}

const vaciar = () => new Promise((r) => setImmediate(r));

test('concurrent polls run one request at a time and leave a single timer', async () => {
  const { ctx, timers, pedidos } = armar();
  const a = ctx.sondear();
  ctx.sondear();
  ctx.sondear();
  assert.equal(pedidos.length, 1);
  pedidos[0]();
  await a;
  // The calls made during the poll collapse into one immediate re-run.
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].ms, 0);
  assert.equal(ctx.timer(), [...timers.keys()][0]);
  const p = [...timers.values()][0].fn();
  assert.equal(pedidos.length, 2);
  pedidos[1]();
  await p;
  await vaciar();
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].ms, 60000);
});

test('an external poll while a timer is armed replaces that timer instead of adding a loop', async () => {
  const { ctx, timers, pedidos } = armar();
  const a = ctx.sondear();
  pedidos[0]();
  await a;
  assert.equal(timers.size, 1);
  const b = ctx.sondear();
  assert.equal(timers.size, 0);
  pedidos[1]();
  await b;
  assert.equal(timers.size, 1);
});
