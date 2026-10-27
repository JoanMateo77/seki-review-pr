import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../mcp/tablero/anclaje.js'), 'utf8');
const ctx = {};
vm.runInNewContext(src, ctx);
const A = ctx.PWAnclaje;

const PATCH = '@@ -10,3 +10,4 @@\n a\n-b\n+c\n+d\n e';
const sinHunk = (ls) => JSON.parse(JSON.stringify(ls)).filter((l) => l.tipo !== 'hunk').map((l) => [l.tipo, l.viejo, l.nuevo, l.texto]);

test('lineasDePatch: numera viejo y nuevo como GitHub', () => {
  assert.deepEqual(sinHunk(A.lineasDePatch(PATCH)), [
    ['ctx', 10, 10, 'a'],
    ['del', 11, null, 'b'],
    ['add', null, 11, 'c'],
    ['add', null, 12, 'd'],
    ['ctx', 12, 13, 'e'],
  ]);
});

test('lineasDePatch: ignora el aviso de fin de archivo sin salto', () => {
  assert.equal(A.lineasDePatch('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b').filter((l) => l.tipo !== 'hunk').length, 2);
});

test('normalizarRango: ordena y une texto', () => {
  const r = A.normalizarRango(A.lineasDePatch(PATCH), 'n12', 'n11');
  assert.equal(r.lado, 'nuevo');
  assert.equal(r.desde, 11);
  assert.equal(r.hasta, 12);
  assert.equal(r.texto, 'c\nd');
  assert.deepEqual([...r.claves], ['n11', 'n12']);
});

test('normalizarRango: rango mixto', () => {
  assert.equal(A.normalizarRango(A.lineasDePatch(PATCH), 'v11', 'n11').lado, 'mixto');
});

test('normalizarRango: solo líneas borradas es lado viejo', () => {
  const r = A.normalizarRango(A.lineasDePatch(PATCH), 'v11', 'v11');
  assert.equal(r.lado, 'viejo');
  assert.equal(r.desde, 11);
});

test('normalizarRango: clave inexistente', () => {
  assert.equal(A.normalizarRango(A.lineasDePatch(PATCH), 'n99', 'n11'), null);
});

test('anclar: mismo texto ancla en la última línea', () => {
  const r = A.anclar({ lado: 'nuevo', desde: 11, hasta: 12, textoOriginal: 'c\nd' }, A.lineasDePatch(PATCH));
  assert.equal(r.claveFinal, 'n12');
});

test('anclar: texto cambiado queda desactualizado', () => {
  const otro = '@@ -10,3 +10,4 @@\n a\n-b\n+c\n+x\n e';
  assert.equal(A.anclar({ lado: 'nuevo', desde: 11, hasta: 12, textoOriginal: 'c\nd' }, A.lineasDePatch(otro)).desactualizado, true);
});

test('anclar: línea que ya no está en el patch queda desactualizado', () => {
  assert.equal(A.anclar({ lado: 'nuevo', desde: 40, hasta: 41, textoOriginal: 'c\nd' }, A.lineasDePatch(PATCH)).desactualizado, true);
});

test('anclar: rango mixto ancla con su texto completo', () => {
  const l = A.lineasDePatch(PATCH);
  const r = A.normalizarRango(l, 'v11', 'n12');
  assert.equal(A.anclar({ lado: r.lado, desde: r.desde, hasta: r.hasta, claves: r.claves, textoOriginal: r.texto }, l).claveFinal, 'n12');
});
