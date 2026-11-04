import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { eventosDe, leerEventos, registrarEventos } from '../mcp/lib/eventos.mjs';
import { rutaEventos } from '../mcp/lib/cache.mjs';

const ejecutar = promisify(execFile);
const EVENTOS = pathToFileURL(join(import.meta.dirname, '../mcp/lib/eventos.mjs')).href;

async function conProyecto(fn) {
  const salida = mkdtempSync(join(tmpdir(), 'seki-eventos-'));
  try {
    return await fn({ salida });
  } finally {
    rmSync(salida, { recursive: true, force: true });
  }
}
const foto = (mergeada = '2026-11-02T10:00:00Z') => ({
  prs: [{ id: 'back#1', ambiente: 'pruebas', estadoPr: 'OPEN' }],
  recientes: [
    { id: 'back#2', ambiente: 'prod', estadoPr: 'MERGED', mergeada },
    { id: 'front#3', ambiente: 'pruebas', estadoPr: 'CLOSED', cerrada: '2026-11-03T10:00:00Z', mergeada: null },
  ],
});
const ids = (p) => readFileSync(rutaEventos(p.salida), 'utf8').trim().split('\n').map((l) => JSON.parse(l).id);

test('eventosDe emits merges and closures with a stable sha256 id and the delivery key', () => {
  const ev = eventosDe(foto(), [{ clave: 'k', prs: ['back#2'] }]);
  assert.deepEqual(ev.map((e) => e.tipo), ['pr_mergeada', 'pr_cerrada']);
  assert.match(ev[0].id, /^[0-9a-f]{64}$/);
  assert.equal(ev[0].entrega, 'k');
  assert.equal(ev[0].ts, '2026-11-02T10:00:00Z');
  assert.deepEqual(eventosDe(foto()).map((e) => e.id), ev.map((e) => e.id));
});

test('registrarEventos returns N then 0 on the same snapshot; a changed mergedAt yields exactly one new event', async () => {
  await conProyecto(async (p) => {
    assert.equal(await registrarEventos(p, eventosDe(foto())), 2);
    assert.equal(await registrarEventos(p, eventosDe(foto())), 0);
    assert.equal(await registrarEventos(p, eventosDe(foto('2026-11-05T10:00:00Z'))), 1);
    assert.equal(await registrarEventos(p, eventosDe(foto('2026-11-05T10:00:00Z'))), 0);
    assert.equal(leerEventos(p).length, 3);
  });
});

test('concurrent registrarEventos from two promises leaves no duplicate ids', async () => {
  await conProyecto(async (p) => {
    const ev = eventosDe(foto());
    const cuentas = await Promise.all([registrarEventos(p, ev), registrarEventos(p, ev)]);
    assert.equal(cuentas[0] + cuentas[1], ev.length);
    assert.equal(new Set(ids(p)).size, ids(p).length);
  });
});

test('concurrent registrarEventos from two processes leaves no duplicate ids', async () => {
  await conProyecto(async (p) => {
    const codigo = `import { registrarEventos } from ${JSON.stringify(EVENTOS)};
      const ev = Array.from({ length: 40 }, (_, i) => ({ id: 'id' + i, ts: '2026-11-01T00:00:00Z', tipo: 'pr_mergeada', pr: 'back#' + i }));
      console.log(await registrarEventos({ salida: process.argv[1] }, ev));`;
    const salidas = await Promise.all([1, 2].map(() => ejecutar(process.execPath, ['--input-type=module', '-e', codigo, p.salida])));
    assert.equal(salidas.reduce((s, r) => s + Number(r.stdout), 0), 40);
    assert.equal(new Set(ids(p)).size, 40);
    assert.equal(ids(p).length, 40);
  });
});

test('leerEventos skips a truncated last line, warns once, and registrarEventos recovers on a fresh line', async () => {
  await conProyecto(async (p) => {
    await registrarEventos(p, eventosDe(foto()));
    appendFileSync(rutaEventos(p.salida), '{"id":"abc","ts":"2026');
    const avisos = [];
    const original = console.error;
    console.error = (m) => avisos.push(m);
    try {
      assert.equal(leerEventos(p).length, 2);
    } finally {
      console.error = original;
    }
    assert.equal(avisos.filter((m) => m.includes('[seki-review/eventos]')).length, 1);
    assert.equal(await registrarEventos(p, eventosDe(foto('2026-11-09T00:00:00Z'))), 1);
    assert.equal(leerEventos(p).length, 3);
  });
});

test('leerEventos filters by desde and returns [] without a file', async () => {
  await conProyecto(async (p) => {
    assert.deepEqual(leerEventos(p), []);
    await registrarEventos(p, eventosDe(foto()));
    assert.equal(leerEventos(p, { desde: '2026-11-02T12:00:00Z' }).length, 1);
  });
});
