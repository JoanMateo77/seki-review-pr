import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGOTADO, compilarPatron, coincidencias, probarSeguro } from '../mcp/lib/patrones.mjs';
import { reglasDeConfig } from '../mcp/lib/reglas.mjs';
import { verificar } from '../mcp/lib/verificar.mjs';
import { distintas, ejecuciones } from './util/ejecuciones.mjs';

test('compilarPatron rejects nested quantifiers, long and malformed patterns', () => {
  assert.throws(() => compilarPatron('(a+)+$'), /Invalid pattern/);
  assert.throws(() => compilarPatron('(.*)*'), /Invalid pattern/);
  assert.throws(() => compilarPatron('a'.repeat(301)), /Invalid pattern/);
  assert.throws(() => compilarPatron('('), /Invalid pattern/);
  assert.ok(compilarPatron('\\b[A-Z]-\\d+\\b') instanceof RegExp);
});

test('coincidencias scans only maxLargo of a 2 MB string', () => {
  const r = coincidencias(/x+/, 'x'.repeat(2 * 1024 * 1024));
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

const silenciar = (fn) => {
  const original = console.error;
  const llamadas = [];
  console.error = (...a) => llamadas.push(a.join(' '));
  try { return [fn(), llamadas]; } finally { console.error = original; }
};
const parche = (...lineas) => `@@ -0,0 +1,${lineas.length} @@\n${lineas.map((l) => `+${l}`).join('\n')}`;

test('reglasDeConfig drops rules with invalid archivos or excluir', () => {
  const [r, avisos] = silenciar(() => reglasDeConfig([
    { id: 'a', patron: 'x', archivos: '(' },
    { id: 'b', patron: 'x', excluir: '(a+)+' },
    { id: 'c', patron: 'x' },
  ]));
  assert.deepEqual(r.map((x) => x.id), ['c']);
  assert.equal(avisos.length, 2);
});

test('reglasDeConfig keeps a 295-char soloEnTexto pattern and caps warning text', () => {
  const [r] = silenciar(() => reglasDeConfig([{ id: 'l', patron: 'a'.repeat(295), soloEnTexto: true }]));
  assert.equal(r.length, 1);
  const [, avisos] = silenciar(() => reglasDeConfig([{ id: 'i'.repeat(200), patron: 'a)|(b' }]));
  assert.ok(avisos[0].length < 250);
});

test('soloEnTexto matches inside a string literal only', () => {
  const [r] = reglasDeConfig([{ id: 't', patron: 'comercio', soloEnTexto: true }]);
  assert.ok(r.cuando('x = "el comercio"', 'a.js'));
  assert.ok(!r.cuando('const comercio = 1', 'a.js'));
  assert.ok(r.cuando('const comercio = 1', 'a.ejs'));
});

test('verificar: a g-flag config rule does not alternate across lines', () => {
  const [reglas] = [reglasDeConfig([{ id: 'g', titulo: 't', patron: 'foo', flags: 'g', archivos: '\\.js$', mensaje: 'm' }])];
  const { hallazgos: h } = verificar({ repo: 'r', archivos: [{ filename: 'a.js', status: 'modified', patch: parche('foo', 'foo', 'foo') }], extra: reglas });
  assert.equal(h.filter((x) => x.regla === 'g').length, 3);
});

test('verificar: a backtracking config rule over a 2 MB line runs over 4096 characters only and is cut off', () => {
  const reglas = reglasDeConfig([{ id: 'bt', titulo: 't', patron: '(a|aa)+$', archivos: '\\.js$', mensaje: 'm' }]);
  const linea = `${'a'.repeat(4000)}b${'c'.repeat(2 * 1024 * 1024)}`;
  const [[, avisos], entradas] = ejecuciones('(a|aa)+$', () => silenciar(() => verificar({ repo: 'r', archivos: [{ filename: 'a.js', status: 'modified', patch: parche(linea) }], extra: reglas })));
  assert.deepEqual(distintas(entradas), [linea.slice(0, 4096)]);
  assert.equal(avisos.length, 1);
});

// Three distinct heavy lines: a disabled rule never runs on the second or third one.
const lineaPesada = `${'a'.repeat(4000)}b${'c'.repeat(1000)}`;
const pesadas = (prefijo) => [1, 2, 3].map((i) => `x${i} ${prefijo}${lineaPesada}`);

test('verificar: a catastrophic excluir disables the rule after one warning', () => {
  const reglas = reglasDeConfig([{ id: 'ex', titulo: 't', patron: 'x', excluir: '(a|aa)+$', archivos: '\\.js$', mensaje: 'm' }]);
  const lineas = pesadas('');
  const [[, avisos], entradas] = ejecuciones('(a|aa)+$', () => silenciar(() => verificar({ repo: 'r', archivos: [{ filename: 'a.js', status: 'modified', patch: parche(...lineas) }], extra: reglas })));
  // The file name is tested first.
  assert.deepEqual(distintas(entradas), ['a.js', lineas[0].slice(0, 4096)]);
  assert.equal(avisos.length, 1);
});

test('verificar: a catastrophic soloEnTexto (cuando) disables the rule after one warning', () => {
  const reglas = reglasDeConfig([{ id: 'cu', titulo: 't', patron: '(a|aa)+$', soloEnTexto: true, archivos: '\\.js$', mensaje: 'm' }]);
  reglas[0].patron = /x/;
  const lineas = pesadas('"');
  const [[, avisos], entradas] = ejecuciones('(a|aa)+$', () => silenciar(() => verificar({ repo: 'r', archivos: [{ filename: 'a.js', status: 'modified', patch: parche(...lineas) }], extra: reglas })));
  assert.deepEqual(distintas(entradas), [lineas[0].slice(0, 4096)]);
  assert.equal(avisos.length, 1);
});

test('coincidencias returns AGOTADO on a catastrophic pattern, cut off at 4096 characters', () => {
  const [r, entradas] = ejecuciones('(a|aa)+b', () => coincidencias(/(a|aa)+b/, 'a'.repeat(5000)));
  assert.equal(r, AGOTADO);
  assert.deepEqual(distintas(entradas), ['a'.repeat(4096)]);
});

test('verificar: a catastrophic archivos pattern disables the rule after one warning', () => {
  const reglas = reglasDeConfig([{ id: 'ar', titulo: 't', patron: 'x', archivos: '(a|aa)+b', mensaje: 'm' }]);
  const nombres = [1, 2, 3].map((i) => `${i}${'a'.repeat(4096)}.js`);
  const [[{ hallazgos }, avisos], entradas] = ejecuciones('(a|aa)+b', () => silenciar(() => verificar({ repo: 'r', archivos: nombres.map((filename) => ({ filename, status: 'modified', patch: parche('x') })), extra: reglas })));
  assert.deepEqual(distintas(entradas), [nombres[0].slice(0, 4096)]);
  assert.equal(hallazgos.filter((h) => h.regla === 'ar').length, 0);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /^\[seki-review\/reglas\] rule ar disabled/);
});

// The guard's limit is wall time; the injected CPU meter stands in for a machine where the run was descheduled.
class PrimeraLenta extends RegExp {
  constructor(...a) { super(...a); this.ejecuciones = 0; }
  exec(texto) {
    if (this.ejecuciones++ === 0) for (;;);
    return super.exec(texto);
  }
}

test('probarSeguro repeats a timed-out run that used little CPU instead of reporting AGOTADO', () => {
  const re = new PrimeraLenta('b');
  assert.equal(probarSeguro(re, 'abc', { timeoutMs: 20, cpu: () => 0 }), true);
  assert.equal(re.ejecuciones, 2);
});

test('a timed-out run counts for the CPU it used: AGOTADO once the runs used half the limit, or before 10 x the limit of wall time', () => {
  const lecturas = [0, 0, 0, 0, 0, 10];
  const [r, entradas] = ejecuciones('(a|aa)+b', () => coincidencias(/(a|aa)+b/, 'a'.repeat(4096), { timeoutMs: 20, cpu: () => lecturas.shift() }));
  assert.equal(r, AGOTADO);
  assert.equal(entradas.length, 3);
  // Each run takes 50 ms of fake wall time and no CPU: an eleventh run would end past 500 ms.
  let lectura = 0;
  const [r2, entradas2] = ejecuciones('(a|aa)+b', () => probarSeguro(/(a|aa)+b/, 'a'.repeat(4096), { timeoutMs: 50, cpu: () => 0, ahora: () => 50 * lectura++ }));
  assert.equal(r2, AGOTADO);
  assert.equal(entradas2.length, 10);
});

test('verificar: a config archivos and excluir still select files', () => {
  const reglas = reglasDeConfig([{ id: 'sel', titulo: 't', patron: 'x', archivos: '\\.js$', excluir: '^vendor/', mensaje: 'm' }]);
  const archivos = ['a.js', 'vendor/b.js', 'c.css'].map((filename) => ({ filename, status: 'modified', patch: parche('x') }));
  assert.deepEqual(verificar({ repo: 'r', archivos, extra: reglas }).hallazgos.filter((h) => h.regla === 'sel').map((h) => h.archivo), ['a.js']);
});
