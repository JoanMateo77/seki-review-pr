import test from 'node:test';
import assert from 'node:assert/strict';
import { archivosPr } from '../mcp/lib/estado.mjs';

const contador = (lista) => {
  const f = async () => { f.llamadas++; return lista(f.llamadas); };
  f.llamadas = 0;
  return f;
};

test('archivosPr reuses the list for the same commit and asks again after a push', async () => {
  const pedir = contador((n) => [{ filename: `v${n}.ts` }]);
  const a = await archivosPr('acme', 'api-memo', 1, 'a'.repeat(40), pedir);
  const b = await archivosPr('acme', 'api-memo', 1, 'a'.repeat(40), pedir);
  assert.equal(pedir.llamadas, 1);
  assert.deepEqual(b, a);
  const c = await archivosPr('acme', 'api-memo', 1, 'b'.repeat(40), pedir);
  assert.equal(pedir.llamadas, 2);
  assert.equal(c[0].filename, 'v2.ts');
});

test('archivosPr drops the entry of the previous commit of the same PR', async () => {
  const pedir = contador(() => []);
  await archivosPr('acme', 'api-viejo', 2, 'a'.repeat(40), pedir);
  await archivosPr('acme', 'api-viejo', 2, 'b'.repeat(40), pedir);
  await archivosPr('acme', 'api-viejo', 2, 'a'.repeat(40), pedir);
  assert.equal(pedir.llamadas, 3);
});

test('archivosPr does not memoize without a commit', async () => {
  const pedir = contador(() => []);
  await archivosPr('acme', 'api-sin', 3, undefined, pedir);
  await archivosPr('acme', 'api-sin', 3, undefined, pedir);
  assert.equal(pedir.llamadas, 2);
});

test('archivosPr does not memoize a rejected request', async () => {
  let llamadas = 0;
  const pedir = async () => { llamadas++; if (llamadas === 1) throw new Error('gh failed'); return [{ filename: 'ok.ts' }]; };
  await assert.rejects(() => archivosPr('acme', 'api-falla', 4, 'a'.repeat(40), pedir), /gh failed/);
  const lista = await archivosPr('acme', 'api-falla', 4, 'a'.repeat(40), pedir);
  assert.equal(llamadas, 2);
  assert.equal(lista[0].filename, 'ok.ts');
});
