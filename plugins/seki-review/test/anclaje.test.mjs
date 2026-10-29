import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../mcp/tablero/anclaje.js'), 'utf8');
const ctx = {};
vm.runInNewContext(src, ctx);
const A = ctx.SekiAnclaje;

const PATCH = '@@ -10,3 +10,4 @@\n a\n-b\n+c\n+d\n e';
const sinHunk = (ls) => JSON.parse(JSON.stringify(ls)).filter((l) => l.tipo !== 'hunk').map((l) => [l.tipo, l.viejo, l.nuevo, l.texto]);

test('lineasDePatch: numbers old and new lines like GitHub', () => {
  assert.deepEqual(sinHunk(A.lineasDePatch(PATCH)), [
    ['ctx', 10, 10, 'a'],
    ['del', 11, null, 'b'],
    ['add', null, 11, 'c'],
    ['add', null, 12, 'd'],
    ['ctx', 12, 13, 'e'],
  ]);
});

test('lineasDePatch: ignores the no-newline-at-end-of-file marker', () => {
  assert.equal(A.lineasDePatch('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b').filter((l) => l.tipo !== 'hunk').length, 2);
});

test('normalizarRango: sorts and joins text', () => {
  const r = A.normalizarRango(A.lineasDePatch(PATCH), 'n12', 'n11');
  assert.equal(r.lado, 'nuevo');
  assert.equal(r.desde, 11);
  assert.equal(r.hasta, 12);
  assert.equal(r.texto, 'c\nd');
  assert.deepEqual([...r.claves], ['n11', 'n12']);
});

test('normalizarRango: mixed range', () => {
  assert.equal(A.normalizarRango(A.lineasDePatch(PATCH), 'v11', 'n11').lado, 'mixto');
});

test('normalizarRango: only deleted lines means old side', () => {
  const r = A.normalizarRango(A.lineasDePatch(PATCH), 'v11', 'v11');
  assert.equal(r.lado, 'viejo');
  assert.equal(r.desde, 11);
});

test('normalizarRango: missing key', () => {
  assert.equal(A.normalizarRango(A.lineasDePatch(PATCH), 'n99', 'n11'), null);
});

test('anclar: same text anchors on the last line', () => {
  const r = A.anclar({ lado: 'nuevo', desde: 11, hasta: 12, textoOriginal: 'c\nd' }, A.lineasDePatch(PATCH));
  assert.equal(r.claveFinal, 'n12');
});

test('anclar: changed text becomes outdated', () => {
  const otro = '@@ -10,3 +10,4 @@\n a\n-b\n+c\n+x\n e';
  assert.equal(A.anclar({ lado: 'nuevo', desde: 11, hasta: 12, textoOriginal: 'c\nd' }, A.lineasDePatch(otro)).desactualizado, true);
});

test('anclar: line no longer in the patch becomes outdated', () => {
  assert.equal(A.anclar({ lado: 'nuevo', desde: 40, hasta: 41, textoOriginal: 'c\nd' }, A.lineasDePatch(PATCH)).desactualizado, true);
});

test('anclar: mixed range anchors with its full text', () => {
  const l = A.lineasDePatch(PATCH);
  const r = A.normalizarRango(l, 'v11', 'n12');
  assert.equal(A.anclar({ lado: r.lado, desde: r.desde, hasta: r.hasta, claves: r.claves, textoOriginal: r.texto }, l).claveFinal, 'n12');
});

test('textoSugerido: normalizes line breaks', () => {
  assert.equal(A.textoSugerido('a\r\nb\n'), 'a\nb');
});
