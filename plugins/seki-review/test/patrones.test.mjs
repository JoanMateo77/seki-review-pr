import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilarPatron, coincidencias } from '../mcp/lib/patrones.mjs';
import { reglasDeConfig } from '../mcp/lib/reglas.mjs';

test('compilarPatron rejects nested quantifiers, long and malformed patterns', () => {
  assert.throws(() => compilarPatron('(a+)+$'), /Invalid pattern/);
  assert.throws(() => compilarPatron('(.*)*'), /Invalid pattern/);
  assert.throws(() => compilarPatron('a'.repeat(301)), /Invalid pattern/);
  assert.throws(() => compilarPatron('('), /Invalid pattern/);
  assert.ok(compilarPatron('\\b[A-Z]-\\d+\\b') instanceof RegExp);
});

test('coincidencias scans only maxLargo of a 2 MB string quickly', () => {
  const texto = 'x'.repeat(2 * 1024 * 1024);
  const t0 = performance.now();
  const r = coincidencias(/x+/, texto);
  assert.ok(performance.now() - t0 < 200);
  assert.equal(r[0].length, 4096);
});

test('coincidencias collapses duplicates, caps results, keeps the caller regex intact', () => {
  assert.deepEqual(coincidencias(/A-\d/, 'A-1 A-2 A-1'), ['A-1', 'A-2']);
  assert.equal(coincidencias(/\d/g, '0123456789', { maxCoincidencias: 3 }).length, 3);
  const re = /a/g;
  re.lastIndex = 5;
  coincidencias(re, 'aaa');
  assert.equal(re.lastIndex, 5);
});

test('coincidencias terminates on zero-length matches', () => {
  assert.ok(Array.isArray(coincidencias(/x*/, 'abc')));
});

test('reglasDeConfig drops an invalid rule with a warning and keeps valid ones', () => {
  const original = console.error;
  const llamadas = [];
  console.error = (...a) => llamadas.push(a.join(' '));
  try {
    const r = reglasDeConfig([
      { id: 'mala', patron: '(a+)+' },
      { id: 'buena', patron: 'foo' },
    ]);
    assert.deepEqual(r.map((x) => x.id), ['buena']);
    assert.equal(llamadas.length, 1);
    assert.match(llamadas[0], /^\[seki-review\/reglas\].*mala.*nested quantifiers/);
  } finally {
    console.error = original;
  }
});
