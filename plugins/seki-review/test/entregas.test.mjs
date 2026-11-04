import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agrupar, claveRama, idsDe, relacionadasDe, tituloLimpio } from '../mcp/lib/entregas.mjs';
import { distintas, ejecuciones } from './util/ejecuciones.mjs';

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
  assert.deepEqual(relacionadasDe('Related: o/front#5', 'o'), ['front#5']);
  assert.deepEqual(relacionadasDe('Related: otro/front#5', 'o'), []);
  assert.deepEqual(relacionadasDe('Related: otro/front#5'), ['front#5']);
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

test('2000 PRs group without a super-linear blow-up', () => {
  const ps = [];
  for (let i = 1; i <= 2000; i++) ps.push(pr(`r${i % 5}`, i, { titulo: `titulo unico${i} palabra${i}`, rama: `feat/rama-${i % 700}`, ambiente: i % 2 ? 'prod' : 'pruebas' }));
  // Generous bound: it separates the linear work from the super-linear blow-up this test guards against, not a fast
  // machine from a loaded one.
  const t = performance.now();
  const r = agrupar(ps, cfg, sin);
  assert.ok(performance.now() - t < 5000);
  assert.ok(r.length > 0);
});

test('separating the first holder of a key keeps the rest joined', () => {
  const ps = [pr('a', 1, { rama: 'feat/zeta' }), pr('b', 2, { rama: 'feat/zeta' }), pr('c', 3, { rama: 'feat/zeta' })];
  const r = agrupar(ps, cfg, { unir: [], separar: ['a#1'], titulo: {} });
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((e) => e.prs).sort(), [['a#1'], ['b#2', 'c#3']]);
  assert.ok(r.find((e) => e.prs.length === 2).clave === 'zeta');
  assert.ok(r.find((e) => e.prs.length === 1).clave.startsWith('zeta~'));
});

test('a separated PR does not consume the best title partner of a single', () => {
  const t = 'Corrige fecha corte reporte mensual';
  const ps = [pr('a', 1, { titulo: t }), pr('a', 2, { titulo: t, ambiente: 'pruebas' }), pr('a', 3, { titulo: `${t} extra`, ambiente: 'pruebas' })];
  const r = agrupar(ps, cfg, { unir: [], separar: ['a#2'], titulo: {} });
  assert.deepEqual(r.map((e) => e.prs).sort(), [['a#1', 'a#3'], ['a#2']]);
});

test('values shared by more than maxPorSenal PRs are not join signals, with one warning', () => {
  const muchos = Array.from({ length: 300 }, (_, i) => pr('r', i + 1, { titulo: 'QA-1', rama: `feat/rama-${i}` }));
  const pocos = [10001, 10002, 10003].map((n) => pr('s', n, { titulo: 'QA-2', rama: `feat/otra-${n}` }));
  const orig = console.error;
  const avisos = [];
  console.error = (m) => avisos.push(m);
  let r;
  try {
    r = agrupar([...muchos, ...pocos], { ...cfg, patronId: 'QA-\\d+' }, sin);
  } finally {
    console.error = orig;
  }
  assert.equal(r.length, 301);
  assert.equal(r.find((e) => e.ids.includes('QA-2')).prs.length, 3);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /^\[seki-review\/entregas\].*id:QA-1/);
  assert.equal(agrupar(muchos.slice(0, 12), { ...cfg, patronId: 'QA-\\d+' }, sin).length, 1);
});

test('a capped branch key still yields unique delivery keys', () => {
  const ps = Array.from({ length: 13 }, (_, i) => pr('r', i + 1, { rama: 'feat/comun' }));
  const orig = console.error;
  console.error = () => {};
  let r;
  try {
    r = agrupar(ps, cfg, sin);
  } finally {
    console.error = orig;
  }
  assert.equal(r.length, 13);
  assert.equal(new Set(r.map((e) => e.clave)).size, 13);
  assert.ok(r.some((e) => e.clave === 'comun'));
});

test('a catastrophic patronId is disabled for the run with one warning', () => {
  const ps = [pr('a', 1, { rama: 'feat/uno', descripcion: 'a'.repeat(4096) }), pr('b', 2, { rama: 'feat/uno', descripcion: `b${'a'.repeat(4095)}` }), pr('c', 3)];
  const avisos = [];
  const orig = console.error;
  console.error = (m) => avisos.push(m);
  let r;
  let entradas;
  try {
    [r, entradas] = ejecuciones('(a|aa)+b', () => agrupar(ps, { ...cfg, patronId: '(a|aa)+b' }, sin));
  } finally {
    console.error = orig;
  }
  // Only the first long description runs (and is cut off); the second one is never tried.
  assert.equal(distintas(entradas.filter((e) => e.length === 4096)).length, 1);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /^\[seki-review\/entregas\] entregas\.patronId disabled/);
  assert.equal(r.length, 2);
  assert.ok(r.every((e) => e.ids.length === 0));
});

test('tituloLimpio strips a conventional prefix and environment markers from the configured suffixes', () => {
  const suf = ['-pruebas', '-testing'];
  assert.equal(tituloLimpio('feat(api)!: Add export (pruebas)', suf), 'Add export');
  assert.equal(tituloLimpio('fix: Login [Testing]', suf), 'Login');
  assert.equal(tituloLimpio('Report totals - pruebas', suf), 'Report totals');
  assert.equal(tituloLimpio('Report totals \u2013 Testing', suf), 'Report totals');
  assert.equal(tituloLimpio('Staging area cleanup (staging)', suf), 'Staging area cleanup (staging)');
  assert.equal(tituloLimpio('Pruebas unitarias del lote', suf), 'Pruebas unitarias del lote');
  assert.equal(tituloLimpio('chore: (pruebas)', suf), 'chore: (pruebas)');
  assert.equal(tituloLimpio('a.b (x.y)', ['-x.y']), 'a.b');
});

test('the delivery title prefers the testing PR, cleaned; without one, the lowest-numbered PR', () => {
  const c = { ...cfg, sufijosRama: ['-pruebas'] };
  const r = agrupar([
    pr('a', 2, { rama: 'feat/caja', titulo: 'feat: Cash box', ambiente: 'prod' }),
    pr('a', 7, { rama: 'feat/caja-pruebas', titulo: 'feat: Cash box closing (pruebas)', ambiente: 'pruebas' }),
    pr('b', 9, { rama: 'feat/caja-pruebas', titulo: 'Cash box API - pruebas', ambiente: 'pruebas' }),
  ], c, sin);
  assert.equal(r[0].titulo, 'Cash box closing');
  const s = agrupar([pr('a', 5, { rama: 'feat/otra', titulo: 'fix(ui): Other' }), pr('b', 3, { rama: 'feat/otra', titulo: 'Late' })], c, sin);
  assert.equal(s[0].titulo, 'Late');
});

test('lineaEvento names qa_resultado events and the blocked case has its own next action', async () => {
  const { lineaEvento } = await import('../mcp/tools/entregas.mjs');
  assert.match(lineaEvento({ ts: '2026-11-05T10:00:00Z', tipo: 'qa_resultado', entrega: 'k' }, { prs: {} }), /QA result: k$/);
  const { siguienteAccion } = await import('../mcp/lib/tablero-entregas.mjs');
  const e = { etapa: 'esperando_qa', prs: [], pistas: [{ alertas: [{ tipo: 'qa_bloqueada' }] }] };
  assert.equal(siguienteAccion(e, new Map()), 'Resolve the blocked QA case and import the results again');
  assert.equal(siguienteAccion({ etapa: 'esperando_qa', prs: [], pistas: [] }, new Map()), 'QA pending');
});
