import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { comprobar } from '../mcp/lib/calidad.mjs';
import { crearCopia, diffCopia } from '../mcp/lib/copias.mjs';
import { repoConPr, sh } from './util/repo.mjs';

// Fake "tsc": always reports an old error in b.ts; reports a new one if a.ts contains "malo";
// takes 2 s if a.ts does not contain "malo" (used to force the baseline to time out).
const TSC = `const f=require('fs');const t=f.readFileSync('a.ts','utf8');
console.log('b.ts(1,1): error TS1000: viejo');
if(t.includes('malo'))console.log('a.ts(3,5): error TS2322: tipo incorrecto');
const fin=Date.now()+(t.includes('malo')||!t.includes('lento')?0:2000);while(Date.now()<fin);
process.exit(1);`;

async function preparar(antes = 'export const a = 1;\n', comandos = {}) {
  const r = repoConPr({ antes: 'x\n', despues: antes });
  const p = {
    salida: mkdtempSync(join(tmpdir(), 'seki-cal-')),
    repos: { 'api': { checkout: r.checkout, comprobar: { node: process.execPath, tipos: ['-e', TSC], tests: null, ...comandos } } },
  };
  const dir = await crearCopia(p, 'api', 7, r.head);
  return { r, p, dir };
}

test('comprobar detects a blocking rule in the patch', async () => {
  const { r, p, dir } = await preparar('export const a = 1;\n', { tipos: null });
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\nqb.where(`M.apikey = \'${x}\'`);\n');
  const c = await comprobar(p, 'api', dir, await diffCopia(dir), r.head);
  assert.ok(c.reglas.bloqueantes > 0);
  assert.equal(c.tipos, null);
});

test('comprobar does not attribute failures that were already in the baseline', async () => {
  const { r, p, dir } = await preparar();
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n// malo\n');
  const c = await comprobar(p, 'api', dir, await diffCopia(dir), r.head);
  assert.equal(c.tipos.ok, false);
  assert.deepEqual(c.tipos.nuevosFallos, ['a.ts: TS2322: tipo incorrecto']);
  assert.equal(c.tipos.sinBaseline, undefined);
});

test('comprobar with no new failures stays ok even if the command fails on old failures', async () => {
  const { r, p, dir } = await preparar();
  writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
  const c = await comprobar(p, 'api', dir, await diffCopia(dir), r.head);
  assert.equal(c.tipos.ok, true);
  assert.deepEqual(c.tipos.nuevosFallos, []);
});

test('comprobar sets sinBaseline if the baseline times out', async () => {
  const { r, p, dir } = await preparar('export const a = 1; // lento\n');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1; // lento malo\n');
  const c = await comprobar(p, 'api', dir, await diffCopia(dir), r.head, { limiteMs: 800 });
  assert.equal(c.tipos.sinBaseline, true);
  assert.ok(c.tipos.nuevosFallos.includes('a.ts: TS2322: tipo incorrecto'));
});

test('comprobar leaves the copy with the change applied', async () => {
  const { r, p, dir } = await preparar();
  writeFileSync(join(dir, 'a.ts'), 'export const a = 3;\n');
  const patch = await diffCopia(dir);
  await comprobar(p, 'api', dir, patch, r.head);
  assert.equal(await diffCopia(dir), patch);
});

test('the baseline does not touch the checkout stash even if the proposal is empty', async () => {
  const { r, p, dir } = await preparar();
  writeFileSync(join(r.checkout, 'a.ts'), 'trabajo sin guardar del usuario\n');
  sh(r.checkout, 'stash', 'push', '-q', '-m', 'del usuario');
  await comprobar(p, 'api', dir, await diffCopia(dir), r.head);
  assert.match(sh(r.checkout, 'stash', 'list'), /del usuario/);
  assert.equal(sh(dir, 'status', '--porcelain'), '');
});
