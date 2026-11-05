import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rutaCopia } from '../mcp/lib/cache.mjs';
import { revisarUltra } from '../mcp/lib/ultra.mjs';
import { repoConPr, sh } from './util/repo.mjs';

// Fake "tsc": fails with an error only when a.ts contains "malo" (the PR), or always when SIEMPRE is set in the script.
const SOLO_PR = `const t=require('fs').readFileSync('a.ts','utf8');if(t.includes('malo')){console.log('a.ts(3,5): error TS2322: tipo incorrecto');process.exit(1);}`;
const SIEMPRE = `console.log('a.ts(3,5): error TS2322: tipo incorrecto');process.exit(1);`;

function preparar(script, { base = 'main' } = {}) {
  const r = repoConPr({ antes: 'x\n', despues: 'malo\n' });
  const p = {
    salida: mkdtempSync(join(tmpdir(), 'seki-ultra-int-')),
    repos: { api: { checkout: r.checkout, comprobar: { node: process.execPath, tipos: ['-e', script], tests: null } } },
  };
  p.copias = join(p.salida, 'copias');
  const patch = sh(r.checkout, 'diff', r.base, r.head, '--', 'a.ts');
  const archivos = [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 1, patch: patch.slice(patch.indexOf('@@')) }];
  const pr = { id: 'api#7', repo: 'api', numero: 7, titulo: 'T', base, headSha: r.head };
  const deps = {
    ejecutar: async () => ({ ok: true, costo: 0, modelo: 'm', salida: { hallazgos: [] } }),
    otras: async () => ({ ambiente: 'pruebas', lista: [] }), diff: async () => archivos, guias: () => null,
  };
  return { r, p, pr, deps };
}

test('checks run on a dedicated copy at the merge-base with the patch applied, and a failure only in the PR is new', async () => {
  const { r, p, pr, deps } = preparar(SOLO_PR);
  const res = await revisarUltra(p, pr, deps);
  const c = res.resultado.comprobacion;
  assert.equal(c.sinBaseline, undefined);
  assert.equal(c.tipos.ok, false);
  assert.equal(c.tipos.nuevosFallos.length, 1);
  assert.equal(sh(rutaCopia(p, 'api', 7, '-lectura'), 'rev-parse', 'HEAD'), r.head);
  assert.equal(sh(rutaCopia(p, 'api', 7, '-ultra'), 'rev-parse', 'HEAD'), r.base);
});

test('a failure that also exists at the merge-base is pre-existing, not attributed to the PR', async () => {
  const { p, pr, deps } = preparar(SIEMPRE);
  const c = (await revisarUltra(p, pr, deps)).resultado.comprobacion;
  assert.deepEqual([c.tipos.nuevosFallos, c.tipos.ok], [[], true]);
});

test('without a merge-base the checks run on the PR commit and are marked as not compared with the base', async () => {
  const { r, p, pr, deps } = preparar(SOLO_PR, { base: 'no-existe' });
  const c = (await revisarUltra(p, pr, deps)).resultado.comprobacion;
  assert.equal(c.sinBaseline, true);
  assert.equal(c.tipos.sinBaseline, true);
  assert.equal(c.tipos.nuevosFallos.length, 1);
  assert.equal(sh(rutaCopia(p, 'api', 7, '-ultra'), 'rev-parse', 'HEAD'), r.head);
  assert.equal(sh(rutaCopia(p, 'api', 7, '-lectura'), 'rev-parse', 'HEAD'), r.head);
});

test('a second run with repetir resets the dedicated copy and still compares with the base', async () => {
  const { p, pr, deps } = preparar(SOLO_PR);
  for (let i = 0; i < 3; i++) {
    const c = (await revisarUltra(p, pr, { ...deps, repetir: true })).resultado.comprobacion;
    assert.equal(c.sinBaseline, undefined, `run ${i + 1}`);
    assert.equal(c.tipos.nuevosFallos.length, 1, `run ${i + 1}`);
  }
});

test('the patch comes from git: binary files of the PR are applied on the dedicated copy', async () => {
  const { r, p, pr, deps } = preparar(SOLO_PR);
  const trabajo = join(r.raiz, 'trabajo');
  writeFileSync(join(trabajo, 'b.bin'), Buffer.from([0, 1, 2, 255, 254, 0, 7]));
  sh(trabajo, 'add', 'b.bin');
  sh(trabajo, 'commit', '-qm', 'binary');
  sh(trabajo, 'push', '-q', '-f', 'origin', `${r.rama}:refs/pull/7/head`);
  pr.headSha = sh(trabajo, 'rev-parse', 'HEAD');
  const c = (await revisarUltra(p, pr, deps)).resultado.comprobacion;
  assert.equal(c.sinBaseline, undefined);
  assert.deepEqual([...readFileSync(join(rutaCopia(p, 'api', 7, '-ultra'), 'b.bin'))], [0, 1, 2, 255, 254, 0, 7]);
});
