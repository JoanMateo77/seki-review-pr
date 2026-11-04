import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agrupar, claveRama, idsDe, relacionadasDe } from '../mcp/lib/entregas.mjs';

const pr = (repo, numero, extra = {}) => ({ id: `${repo}#${numero}`, repo, numero, titulo: `t${numero}`, rama: `x${numero}`, portal: 'p', ambiente: 'prod', descripcion: '', ...extra });
const cfg = { sufijosRama: ['-pruebas', '-admin'], patronId: null, bases: [] };
const sin = { unir: [], separar: [], titulo: {} };

test('claveRama strips prefix and suffixes, rejects short and base keys', () => {
  assert.equal(claveRama('Fix/QA-X-Y-pruebas', ['-pruebas']), 'qa-x-y');
  assert.equal(claveRama('feat/caja-admin-pruebas', ['-pruebas', '-admin']), 'caja');
  assert.equal(claveRama('feat/caja-pruebas', ['-pruebas', '-admin']), 'caja');
  assert.equal(claveRama('fix/x-pruebas', ['-pruebas']), '');
  assert.equal(claveRama('main', [], { bases: ['main'] }), '');
  assert.equal(claveRama('develop', [], { bases: ['develop'] }), '');
  assert.equal(claveRama('release/develop', [], { bases: ['develop'] }), '');
  assert.equal(claveRama('main', []), 'main');
});

test('back and front with a suffixed branch form one delivery by branch', () => {
  const r = agrupar([pr('back', 1, { rama: 'fix/qa-x-y' }), pr('front', 2, { rama: 'fix/qa-x-y-pruebas', ambiente: 'pruebas' })], cfg, sin);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].prs, ['back#1', 'front#2']);
  assert.ok(r[0].señales.includes('rama'));
  assert.equal(r[0].clave, 'qa-x-y');
});

test('branches with different suffix sets reduce to the same key', () => {
  const r = agrupar([pr('front', 1, { rama: 'feat/caja-admin-pruebas' }), pr('back', 2, { rama: 'feat/caja-pruebas' })], cfg, sin);
  assert.equal(r.length, 1);
});

test('shared finding id joins; invalid pattern warns once and groups without ids', () => {
  const a = pr('back', 1, { titulo: 'QA-7 fix' });
  const b = pr('front', 2, { descripcion: 'covers qa-7' });
  const r = agrupar([a, b], { ...cfg, patronId: '\\bQA-\\d+\\b' }, sin);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].ids, ['QA-7']);
  assert.deepEqual(r[0].señales, ['id']);
  const orig = console.error;
  const avisos = [];
  console.error = (m) => avisos.push(m);
  try {
    assert.equal(agrupar([a, b], { ...cfg, patronId: '(a+)+$' }, sin).length, 2);
  } finally {
    console.error = orig;
  }
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /^\[seki-review\/entregas\]/);
});

test('Related reference joins, with repo-key mapping and unknown ids ignored', () => {
  assert.deepEqual(relacionadasDe('x\nRelated: o/front#5\nRelacionada: o/zz#9'), ['front#5', 'zz#9']);
  assert.deepEqual(relacionadasDe('Related: o/front#5', { front: 'fe' }), ['fe#5']);
  const r = agrupar([pr('front', 5), pr('back', 1, { descripcion: 'Related: o/front#5\nRelated: o/nope#1' })], cfg, sin);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].señales, ['relacionada']);
  assert.equal(relacionadasDe('Related: o/front#5'.padStart(5000, ' ')).length, 0);
});

test('base and generic branches join nothing', () => {
  const c = { ...cfg, bases: ['develop', 'main'] };
  const r = agrupar([pr('a', 1, { rama: 'develop' }), pr('b', 2, { rama: 'develop' }), pr('a', 3, { rama: 'main' }), pr('b', 4, { rama: 'main' }), pr('a', 5, { rama: 'fix/x-pruebas' }), pr('b', 6, { rama: 'fix/x-pruebas' })], c, sin);
  assert.equal(r.length, 6);
});

test('title similarity joins only lone same-repo same-portal opposite-environment PRs', () => {
  const t = 'Corrige fecha de corte en reporte mensual';
  const r = agrupar([pr('a', 1, { titulo: t }), pr('a', 2, { titulo: t, ambiente: 'pruebas' }), pr('a', 3, { titulo: t }), pr('b', 4, { titulo: t, ambiente: 'pruebas' }), pr('a', 5, { titulo: t, ambiente: 'pruebas', portal: 'q' })], cfg, sin);
  const par = r.find((e) => e.señales.includes('titulo'));
  assert.deepEqual(par.prs, ['a#1', 'a#2']);
  assert.equal(r.length, 4);
  assert.equal(agrupar([pr('a', 1, { titulo: t }), pr('a', 2, { titulo: t })], cfg, sin).length, 2);
});

test('title step picks the best candidate deterministically', () => {
  const ps = [pr('a', 1, { titulo: 'Corrige fecha corte reporte mensual' }), pr('a', 2, { titulo: 'Corrige fecha corte reporte mensual', ambiente: 'pruebas' }), pr('a', 3, { titulo: 'Corrige fecha corte reporte mensual extra', ambiente: 'pruebas' })];
  const r = agrupar(ps, cfg, sin);
  assert.deepEqual(r.find((e) => e.prs.length === 2).prs, ['a#1', 'a#2']);
});

test('ajustes: unir, separar, titulo', () => {
  const ps = [pr('a', 1, { rama: 'feat/same' }), pr('b', 2, { rama: 'feat/same' }), pr('a', 3), pr('b', 4)];
  const u = agrupar(ps, cfg, { unir: [['a#3', 'b#4', 'zz#9']], separar: [], titulo: {} });
  assert.equal(u.length, 2);
  assert.ok(u.find((e) => e.prs.includes('a#3')).señales.includes('manual'));
  const s = agrupar(ps, cfg, { unir: [], separar: ['b#2'], titulo: { same: 'Custom' } });
  assert.equal(s.length, 4);
  const g = s.find((e) => e.prs.length === 1 && e.prs[0] === 'a#1');
  assert.equal(g.titulo, 'Custom');
  assert.equal(new Set(s.map((e) => e.clave)).size, 4);
  assert.equal(s.find((e) => e.prs[0] === 'b#2').señales.length, 0);
  assert.equal(agrupar(ps, cfg, { unir: [['a#3', 'b#2']], separar: ['b#2'], titulo: {} }).length, 4);
});

test('default title is the earliest-numbered PR; señales in fixed order', () => {
  const r = agrupar([pr('a', 9, { rama: 'feat/same', titulo: 'late' }), pr('b', 3, { rama: 'feat/same', titulo: 'early', titulo2: 1, descripcion: 'QA-1' }), pr('a', 4, { titulo: 'QA-1' })], { ...cfg, patronId: 'QA-\\d+' }, { unir: [['a#9', 'a#4']], separar: [], titulo: {} });
  assert.equal(r.length, 1);
  assert.equal(r[0].titulo, 'early');
  assert.deepEqual(r[0].señales, ['rama', 'id', 'manual']);
});

test('idsDe uppercases, tolerates null regex and body field', () => {
  assert.deepEqual(idsDe({ titulo: 'qa-2', rama: 'fix/qa-1', body: 'qa-2' }, /qa-\d+/i), ['QA-1', 'QA-2']);
  assert.deepEqual(idsDe({ titulo: 'qa-2' }, null), []);
});

test('output is stable for shuffled input', () => {
  const ps = [pr('back', 1, { rama: 'fix/aaa' }), pr('front', 2, { rama: 'fix/aaa-pruebas' }), pr('back', 3, { titulo: 'QA-5' }), pr('front', 4, { titulo: 'QA-5' }), pr('x', 5)];
  const base = JSON.stringify(agrupar(ps, { ...cfg, patronId: 'QA-\\d+' }, sin));
  for (const orden of [[4, 2, 0, 1, 3], [3, 4, 1, 0, 2], [2, 0, 4, 3, 1]]) {
    assert.equal(JSON.stringify(agrupar(orden.map((i) => ps[i]), { ...cfg, patronId: 'QA-\\d+' }, sin)), base);
  }
});

test('2000 PRs group in under 500 ms', () => {
  const ps = [];
  for (let i = 1; i <= 2000; i++) ps.push(pr(`r${i % 5}`, i, { titulo: `titulo unico${i} palabra${i}`, rama: `feat/rama-${i % 700}`, ambiente: i % 2 ? 'prod' : 'pruebas' }));
  const t = performance.now();
  const r = agrupar(ps, cfg, sin);
  assert.ok(performance.now() - t < 500);
  assert.ok(r.length > 0);
});
