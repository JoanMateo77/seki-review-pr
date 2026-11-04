import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QA_DEFECTO } from '../mcp/lib/config.mjs';
import { tieneCuantificadoresAnidados } from '../mcp/lib/patrones.mjs';
import { secretoQa } from '../mcp/lib/acceso.mjs';
import { PATRONES_QA, entregasDesdeCorte, filasDeGuia, firmaFila, fusionesDe, leerGuias, limpiarParaQa, registrarGuia } from '../mcp/lib/qa-guia.mjs';

const pr = (id, portal, extra = {}) => ({ id, repo: id.split('#')[0], portal, ambiente: 'pruebas', estadoPr: 'MERGED', mergeada: '2026-11-01T10:00:00Z', descripcion: '', ...extra });
const mapa = (...prs) => new Map(prs.map((x) => [x.id, x]));
const pista = (portal, prs, etapa = 'esperando_qa') => ({ portal, prs, etapa, alertas: [] });
const PROHIBIDO = /#\d|fix\/|feat\/|\.mjs|\.ts\b|github\.com|\/pull\/|origin\//;

test('limpiarParaQa strips each token kind and keeps normal text', () => {
  assert.equal(limpiarParaQa('Fix login (#123)'), 'Fix login');
  assert.equal(limpiarParaQa('See owner/repo#45 now'), 'See now');
  assert.equal(limpiarParaQa('Open https://github.com/o/r/pull/9 please'), 'Open please');
  assert.equal(limpiarParaQa('Branch feat/new-thing and fix/old-bug done'), 'Branch and done');
  assert.equal(limpiarParaQa('Edit src/lib/util.mjs and app.js'), 'Edit and');
  assert.equal(limpiarParaQa('Open the payment screen. Version 1.2 works'), 'Open the payment screen. Version 1.2 works');
  assert.equal(limpiarParaQa('1. Step one\n2. Step two'), '1. Step one\n2. Step two');
});

function base({ ids = ['X-001', 'X-002'], portales = ['p1', 'p2'] } = {}) {
  const prs = portales.map((po, i) => pr(`r#${i + 1}`, po));
  const e = { clave: 'k1', titulo: 'Fix login (#12) in src/a.mjs', ids, prs: prs.map((x) => x.id), pistas: prs.map((x) => pista(x.portal, [x.id])) };
  return { prs, e, prsPorId: mapa(...prs) };
}
const filas = (o) => filasDeGuia({ cfgRepos: {}, explicaciones: new Map(), rastreador: null, columnas: QA_DEFECTO.columnas, ...o });

test('two IDs x two portals give four rows with unique (etiqueta, portal)', () => {
  const { e, prsPorId } = base();
  const r = filas({ entregas: [e], prsPorId });
  assert.equal(r.length, 4);
  assert.equal(new Set(r.map((x) => `${x.etiqueta}|${x.portal}`)).size, 4);
  assert.equal(r[0].celdas[0], 'X-001');
  assert.equal(r[0].celdas[1], 'p1');
});

test('delivery without IDs gets E<position>', () => {
  const { e, prsPorId } = base({ ids: [], portales: ['p1'] });
  const r = filas({ entregas: [{ ...e, ids: [] }, { ...e, clave: 'k2', ids: [] }], prsPorId });
  assert.deepEqual(r.map((x) => x.etiqueta), ['E1', 'E2']);
});

test('only esperando_qa and qa_fallo tracks produce rows', () => {
  const { e, prsPorId } = base({ ids: [], portales: ['p1', 'p2'] });
  e.pistas[0].etapa = 'listo_produccion';
  e.pistas[1].etapa = 'qa_fallo';
  assert.deepEqual(filas({ entregas: [e], prsPorId }).map((x) => x.portal), ['p2']);
});

test('tracker content wins over explanation, explanation over body, then Steps pending', () => {
  const { e, prsPorId } = base({ ids: ['X-001'], portales: ['p1'] });
  prsPorId.get('r#1').descripcion = '## How to test\n- Body step one\n* Body step two\n1. Body step three\n## Other\n- ignored';
  const explicaciones = new Map([['r#1', { como_probar: ['Explain step one', 'Explain step two (#9)'] }]]);
  const rastreador = new Map([['X-001', { hallazgo: 'h', pasos: 'Tracker steps', esperado: 'Tracker expected', pantalla: 'Screen A', prioridad: 'High' }]]);
  const celda = (r, nombre) => r.celdas[QA_DEFECTO.columnas.indexOf(nombre)];
  let r = filas({ entregas: [e], prsPorId, explicaciones, rastreador })[0];
  assert.equal(celda(r, 'Steps'), 'Tracker steps');
  assert.equal(celda(r, 'Expected result'), 'Tracker expected');
  assert.equal(celda(r, 'Screen and access'), 'Screen A');
  assert.equal(celda(r, 'Priority'), 'High');
  r = filas({ entregas: [e], prsPorId, explicaciones })[0];
  assert.equal(celda(r, 'Steps'), '1. Explain step one\n2. Explain step two');
  assert.equal(celda(r, 'Expected result'), 'Fix login in');
  assert.equal(r.pendiente, false);
  r = filas({ entregas: [e], prsPorId })[0];
  assert.equal(celda(r, 'Steps'), '1. Body step one\n2. Body step two\n3. Body step three');
  prsPorId.get('r#1').descripcion = 'nothing useful';
  r = filas({ entregas: [e], prsPorId })[0];
  assert.equal(celda(r, 'Steps'), 'Steps pending');
  assert.equal(r.pendiente, true);
});

test('body list is capped at 20 items and no cell leaks PR numbers, branches or files', () => {
  const { e, prsPorId } = base({ ids: ['X-001'], portales: ['p1'] });
  prsPorId.get('r#1').descripcion = '### Cómo probar\n' + Array.from({ length: 30 }, (_, i) => `- do ${i} (#12) on fix/abc in x.mjs`).join('\n');
  const r = filas({ entregas: [e], prsPorId })[0];
  assert.equal(r.celdas[4].split('\n').length, 20);
  for (const c of r.celdas) assert.doesNotMatch(c, PROHIBIDO);
});

test('entregasDesdeCorte excludes a covered track and includes it again after a newer merge', () => {
  const { e, prsPorId } = base({ ids: ['X-001'], portales: ['p1', 'p2'] });
  const guias = [{ id: 'g1', filas: filas({ entregas: [e], prsPorId }), fusiones: fusionesDe([e], prsPorId) }];
  assert.equal(entregasDesdeCorte({ entregas: [e], guias: [], prsPorId }).length, 1);
  assert.equal(entregasDesdeCorte({ entregas: [e], guias, prsPorId }).length, 0);
  prsPorId.get('r#2').mergeada = '2026-11-03T10:00:00Z';
  const r = entregasDesdeCorte({ entregas: [e], guias, prsPorId });
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].pistas.map((x) => x.portal), ['p2']);
});

test('entregasDesdeCorte ignores a guide merge recorded for another portal that shares a PR', () => {
  const a = pr('r#1', 'A', { mergeada: '2026-11-03T10:00:00Z' });
  const eA = { clave: 'ka', titulo: 't', ids: ['X-001'], prs: [a.id], pistas: [pista('A', [a.id])] };
  const eB = { clave: 'kb', titulo: 't', ids: ['X-001'], prs: [a.id], pistas: [pista('B', [a.id])] };
  const prsPorId = mapa(a);
  const guias = [{ id: 'g1', filas: filas({ entregas: [eA], prsPorId }), fusiones: fusionesDe([eA], prsPorId) }];
  assert.deepEqual(entregasDesdeCorte({ entregas: [eA, eB], guias, prsPorId }).map((x) => x.clave), ['kb']);
});

test('firmaFila changes with any key field and not with PR order', () => {
  const s = Buffer.alloc(32, 1);
  const k = { guia: 'g', etiqueta: 'X-001', portal: 'p1', prs: ['a#1', 'b#2'], entrega: 'k' };
  const f = firmaFila(s, k);
  assert.match(f, /^[0-9a-f]{64}$/);
  assert.equal(firmaFila(s, { ...k, prs: ['b#2', 'a#1'] }), f);
  for (const c of [{ guia: 'h' }, { etiqueta: 'X-002' }, { portal: 'p2' }, { prs: ['a#1'] }, { entrega: 'z' }]) assert.notEqual(firmaFila(s, { ...k, ...c }), f);
  assert.notEqual(firmaFila(Buffer.alloc(32, 2), k), f);
});

test('secretoQa is stable and mode 0600; registrarGuia round-trips', async () => {
  const p = { salida: mkdtempSync(join(tmpdir(), 'seki-qa-')) };
  const a = secretoQa(p);
  assert.equal(a.length, 32);
  assert.deepEqual(secretoQa(p), a);
  assert.equal(statSync(join(p.salida, 'datos', 'secreto-qa')).mode & 0o777, 0o600);
  assert.deepEqual(leerGuias(p), { guias: [] });
  await registrarGuia(p, { id: 'g1', fecha: '2026-11-04', entregas: ['k'], filas: [{ etiqueta: 'X-001', portal: 'p1', entrega: 'k', prs: ['a#1'], celdas: ['x'] }], fusiones: { 'a#1': '2026-11-01T10:00:00Z' } });
  const { guias } = leerGuias(p);
  assert.equal(guias.length, 1);
  assert.deepEqual(guias[0].filas[0], { etiqueta: 'X-001', portal: 'p1', entrega: 'k', prs: ['a#1'] });
});

test('registrarGuia refuses a duplicate id and guide ids never repeat after files are deleted', async () => {
  const p = { salida: mkdtempSync(join(tmpdir(), 'seki-qa-')) };
  const guia = { id: 'g1', fecha: '2026-11-04', entregas: ['k'], filas: [], fusiones: {} };
  await registrarGuia(p, guia);
  await assert.rejects(registrarGuia(p, guia), (e) => e.codigo === 'QA_GUIA_DUPLICADA');
  assert.equal(leerGuias(p).guias.length, 1);
});

test('limpiarParaQa strips dotted names, absolute paths, schemeless URLs, origin and case-variant branches', () => {
  assert.equal(limpiarParaQa('Edit user.service.ts and app.config.js now'), 'Edit and now');
  assert.equal(limpiarParaQa('Copy .env and .env.local first'), 'Copy and first');
  assert.equal(limpiarParaQa('Open /Users/x/app/a.mjs and ~/x/b.json'), 'Open and');
  assert.equal(limpiarParaQa('See github.com/o/r/pull/9 and gitlab.example.com/o/r/pull/12 ok'), 'See and ok');
  assert.equal(limpiarParaQa('Merge origin/fix/abc, Bugfix/x and feature/y'), 'Merge, and');
  assert.equal(limpiarParaQa('Commit https://github.com/o/r/commit/abc123 done'), 'Commit done');
});

test('limpiarParaQa keeps product names such as Node.js and Vue.js', () => {
  assert.equal(limpiarParaQa('Upgrade Node.js and Vue.js today'), 'Upgrade Node.js and Vue.js today');
});

test('QA regexes have no nested quantifiers', () => {
  for (const re of PATRONES_QA) assert.equal(tieneCuantificadoresAnidados(re.source), false, re.source);
});

test('firmaFila has no separator collisions', () => {
  const s = Buffer.alloc(32, 1);
  const a = firmaFila(s, { guia: 'g', etiqueta: 'X\np1', portal: 'p2', prs: ['a#1'], entrega: 'k' });
  const b = firmaFila(s, { guia: 'g', etiqueta: 'X', portal: 'p1\np2', prs: ['a#1'], entrega: 'k' });
  assert.notEqual(a, b);
  const c = firmaFila(s, { guia: 'g', etiqueta: 'X', portal: 'p', prs: ['a#1', 'b#2'], entrega: 'k' });
  assert.notEqual(c, firmaFila(s, { guia: 'g', etiqueta: 'X', portal: 'p', prs: ['a#1,b#2'], entrega: 'k' }));
});

test('ID and Portal cells are keys and are not cleaned; Finding is shown only when the column exists', () => {
  const { e, prsPorId } = base({ ids: ['#45'], portales: ['p.ts'] });
  const rastreador = new Map([['#45', { hallazgo: 'Finding text', pasos: 'Do it' }]]);
  const r = filas({ entregas: [e], prsPorId, rastreador })[0];
  assert.equal(r.celdas[0], '#45');
  assert.equal(r.celdas[1], 'p.ts');
  assert.ok(!r.celdas.includes('Finding text'));
  const cols = [...QA_DEFECTO.columnas, 'Finding'];
  const r2 = filas({ entregas: [e], prsPorId, rastreador, columnas: cols })[0];
  assert.equal(r2.celdas.at(-1), 'Finding text');
});

test('duplicate IDs and repeated keys across deliveries stay unique', () => {
  const { e, prsPorId } = base({ ids: ['X-001', 'X-001'], portales: ['p1'] });
  const e2 = { ...e, clave: 'k2', ids: ['X-001'] };
  const r = filas({ entregas: [e, e2], prsPorId });
  assert.deepEqual(r.map((x) => x.etiqueta), ['X-001', 'X-001-E2']);
  const choque = { ...e, clave: 'k3', ids: ['X-001-E2', 'X-001'] };
  assert.throws(() => filas({ entregas: [e, choque], prsPorId }), /\[seki-review\/qa\] Duplicate/);
});

test('cells derived from the tracker and from the title do not leak PR numbers, branches or files', () => {
  const { e, prsPorId } = base({ ids: ['X-001'], portales: ['p1'] });
  e.titulo = 'Update user.service.ts (#12) from feat/abc, see github.com/o/r/pull/3';
  const rastreador = new Map([['X-001', { hallazgo: 'h #4', pasos: 'Open src/a.mjs\nSee owner/repo#5', esperado: 'Works per origin/fix/z', pantalla: 'Screen /Users/x/a.ts', prioridad: 'High #1' }]]);
  for (const o of [{ rastreador }, {}]) {
    for (const c of filas({ entregas: [e], prsPorId, ...o })[0].celdas) assert.doesNotMatch(c, PROHIBIDO);
  }
});

test('fusionesDe records the newest testing merge of each multi-PR track', () => {
  const a = pr('r#1', 'p1'); const b = pr('s#2', 'p1', { mergeada: '2026-11-02T10:00:00Z' });
  const e = { clave: 'k', titulo: 't', ids: [], prs: ['r#1', 's#2'], pistas: [pista('p1', ['s#2', 'r#1'])] };
  assert.deepEqual(fusionesDe([e], mapa(a, b)), { '["r#1","s#2"]': '2026-11-02T10:00:00Z' });
});

test('registrarGuia tolerates an empty guias.json object and refuses corrupt JSON', async () => {
  const p = { salida: mkdtempSync(join(tmpdir(), 'seki-qa-')) };
  mkdirSync(join(p.salida, 'datos'));
  writeFileSync(join(p.salida, 'datos', 'guias.json'), '{}');
  assert.deepEqual(leerGuias(p).guias, []);
  await registrarGuia(p, { id: 'g', fecha: 'd', entregas: [], filas: [], fusiones: {} });
  assert.equal(leerGuias(p).guias.length, 1);
  writeFileSync(join(p.salida, 'datos', 'guias.json'), '{bad');
  await assert.rejects(registrarGuia(p, { id: 'h', fecha: 'd', entregas: [], filas: [], fusiones: {} }));
});

test('two concurrent first creations of the secret agree', () => {
  const salida = mkdtempSync(join(tmpdir(), 'seki-qa-'));
  const url = new URL('../mcp/lib/acceso.mjs', import.meta.url).href;
  const codigo = `import('${url}').then((m) => process.stdout.write(m.secretoQa({ salida: ${JSON.stringify(salida)} }).toString('hex')))`;
  const lanzar = () => new Promise((ok, no) => {
    import('node:child_process').then(({ execFile }) => execFile(process.execPath, ['-e', codigo], (e, out) => (e ? no(e) : ok(out))));
  });
  return Promise.all([lanzar(), lanzar(), lanzar()]).then(([a, b, c]) => {
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(a.length, 64);
    assert.equal(secretoQa({ salida }).toString('hex'), a);
  });
});

test('an invalid existing secret file is replaced', () => {
  const p = { salida: mkdtempSync(join(tmpdir(), 'seki-qa-')) };
  mkdirSync(join(p.salida, 'datos'));
  writeFileSync(join(p.salida, 'datos', 'secreto-qa'), 'short');
  const s = secretoQa(p);
  assert.equal(s.length, 32);
  assert.deepEqual(secretoQa(p), s);
  assert.equal(statSync(join(p.salida, 'datos', 'secreto-qa')).mode & 0o777, 0o600);
});

test('track keys survive ids that contain commas', () => {
  const a = pr('r,x#1', 'p1', { mergeada: '2026-11-01T10:00:00Z' }); const b = pr('s#2', 'p1', { mergeada: '2026-11-01T10:00:00Z' });
  const e = { clave: 'k', titulo: 't', ids: [], prs: [a.id, b.id], pistas: [{ ...pista('p1', [a.id, b.id]), etapa: 'esperando_qa' }] };
  const prsPorId = mapa(a, b);
  const guias = [{ id: 'g', filas: [{ etiqueta: 'E1', portal: 'p1', prs: [a.id, b.id] }], fusiones: fusionesDe([e], prsPorId) }];
  assert.deepEqual(entregasDesdeCorte({ entregas: [e], guias, prsPorId }), []);
  const solo = { ...e, pistas: [{ ...pista('p1', ['r']), etapa: 'esperando_qa' }] };
  assert.equal(entregasDesdeCorte({ entregas: [solo], guias, prsPorId }).length, 1);
});
