import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { comprobar } from '../mcp/lib/calidad.mjs';
import { crearCopia, diffCopia } from '../mcp/lib/copias.mjs';
import { repoConPr, sh } from './util/repo.mjs';

const temporales = [];
const temporal = (prefijo) => {
  const d = mkdtempSync(join(tmpdir(), prefijo));
  temporales.push(d);
  return d;
};
after(() => { for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true }); });

// Resolves when `archivo` appears; rejects if `pendiente` settles first, so a missing baseline fails instead of hanging.
// It polls with setInterval because the test mocks setTimeout only.
function cuandoExista(archivo, pendiente) {
  return new Promise((ok, falla) => {
    const sondeo = setInterval(() => { if (existsSync(archivo)) { clearInterval(sondeo); ok(); } }, 10);
    pendiente.then(
      () => { clearInterval(sondeo); falla(new Error('comprobar finished before the baseline started')); },
      (e) => { clearInterval(sondeo); falla(e); },
    );
  });
}

// Fake "tsc": always reports an old error in b.ts; reports a new one if a.ts contains "malo";
// if a.ts contains "lento" but not "malo" (the baseline of that test) it writes SEKI_MARCA and never exits.
const TSC = `const f=require('fs');const t=f.readFileSync('a.ts','utf8');
console.log('b.ts(1,1): error TS1000: viejo');
if(t.includes('malo'))console.log('a.ts(3,5): error TS2322: tipo incorrecto');
if(t.includes('lento')&&!t.includes('malo')){f.writeFileSync(process.env.SEKI_MARCA,'');setInterval(()=>{},1000);}
else process.exit(1);`;

async function preparar(antes = 'export const a = 1;\n', comandos = {}) {
  const r = repoConPr({ antes: 'x\n', despues: antes });
  const p = {
    salida: temporal('seki-cal-'),
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

// The time limit runs on mocked timers: the change's run cannot expire however slow the machine is, and the
// baseline expires exactly when the test advances the clock, once it is known to be running. The test timeout turns a
// baseline that never ends into a failure.
test('comprobar sets sinBaseline if the baseline times out', { timeout: 60_000 }, async (t) => {
  const marca = join(temporal('seki-cal-marca-'), 'baseline');
  const { r, p, dir } = await preparar('export const a = 1; // lento\n', { env: { SEKI_MARCA: marca } });
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1; // lento malo\n');
  const patch = await diffCopia(dir);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pendiente = comprobar(p, 'api', dir, patch, r.head, { limiteMs: 1000 });
  await cuandoExista(marca, pendiente);
  t.mock.timers.tick(1000);
  const c = await pendiente;
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
