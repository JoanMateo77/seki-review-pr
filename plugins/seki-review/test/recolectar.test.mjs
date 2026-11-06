import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { falsoGhRutas, limpiarGhRutas } from './util/gh-rutas.mjs';
import { recolectar } from '../mcp/lib/recolectar.mjs';
import { leerJson, rutaEntregas, rutaEventos, rutaInstantanea } from '../mcp/lib/cache.mjs';
import { proyecto } from '../mcp/lib/config.mjs';

after(limpiarGhRutas);
const temporales = [];
const temporal = (prefijo) => {
  const dir = mkdtempSync(join(tmpdir(), prefijo));
  temporales.push(dir);
  return dir;
};
after(() => { for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true }); });

const previo = { config: process.env.SEKI_REVIEW_CONFIG, gh: process.env.SEKI_GH };
afterEach(() => {
  for (const [k, v] of [['SEKI_REVIEW_CONFIG', previo.config], ['SEKI_GH', previo.gh]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

const hace = (dias) => new Date(Date.now() - dias * 86400000).toISOString();
const linea = { portal: 'P', prod: 'main', pruebas: 'testing' };

function entorno(extra = {}) {
  const dir = temporal('seki-rec-');
  const salida = join(dir, 'salida');
  mkdirSync(join(salida, 'datos'), { recursive: true });
  const ruta = join(dir, 'proyectos.json');
  writeFileSync(ruta, JSON.stringify({ t: { owner: 'o', autor: 'yo', salida, ...extra, repos: { a: { lineas: [linea] }, b: { lineas: [linea] } } } }));
  process.env.SEKI_REVIEW_CONFIG = ruta;
  return salida;
}

// One list answers both the twin listing (by creation) and the recent listing (by update).
const pulls = (repo, base, lista, pagina = 1) => ({ patron: `^api repos/o/${repo}/pulls\\?base=${base}&state=(all&sort=created|closed&sort=updated)&direction=desc&per_page=100&page=${pagina}$`, json: lista });
const rest = (n, titulo, usuario, extra) => ({
  number: n, title: titulo, state: 'closed', user: { login: usuario }, html_url: `u/${n}`, created_at: hace(40),
  merged_at: null, closed_at: null, base: { sha: 'b' }, head: { sha: 'h', ref: `rama-${n}` }, body: null, ...extra,
});
test('a PR merged on the production base within the window appears in recientes, older ones do not', async () => {
  entorno();
  const f = falsoGhRutas([
    { patron: '^api user$', json: { login: 'yo' } },
    { patron: '^pr list ', json: [] },
    pulls('a', 'main', [
      rest(1, 'fresh', 'yo', { merged_at: hace(2), closed_at: hace(2), body: 'x'.repeat(5000) }),
      rest(2, 'old', 'yo', { merged_at: hace(45), closed_at: hace(45) }),
      rest(3, 'other author', 'otro', { merged_at: hace(2), closed_at: hace(2) }),
      rest(4, 'dropped', 'yo', { closed_at: hace(1) }),
    ]),
    pulls('a', 'testing', []), pulls('b', 'main', []), pulls('b', 'testing', []),
  ]);
  process.env.SEKI_GH = f.ruta;
  const foto = await recolectar({ proyecto: 't' });
  const derivadas = leerJson(rutaEntregas(proyecto('t').salida));
  assert.deepEqual(derivadas.entregas.flatMap((e) => e.prs).sort(), ['a#1', 'a#4']);
  assert.equal(readFileSync(rutaEventos(proyecto('t').salida), 'utf8').trim().split('\n').length, 2);
  assert.deepEqual(foto.recientes.map((x) => x.id), ['a#4', 'a#1']);
  const r = foto.recientes.find((x) => x.id === 'a#1');
  assert.equal(r.ambiente, 'prod');
  assert.equal(r.estadoPr, 'MERGED');
  assert.equal(r.base, 'main');
  assert.equal(r.descripcion.length, 4096);
  const c = foto.recientes.find((x) => x.id === 'a#4');
  assert.equal(c.estadoPr, 'CLOSED');
  assert.equal(c.mergeada, null);
  assert.ok(c.cerrada);
  assert.equal(foto.recientes.find((x) => x.numero === 2), undefined);
  assert.deepEqual(foto.prs.filter((x) => x.estadoPr === 'OPEN'), []);
});

test('a null body becomes an empty description', async () => {
  entorno();
  process.env.SEKI_GH = falsoGhRutas([
    { patron: '^api user$', json: { login: 'yo' } }, { patron: '^pr list ', json: [] },
    pulls('a', 'main', [rest(1, 't', 'yo', { merged_at: hace(1), closed_at: hace(1) })]),
    pulls('a', 'testing', []), pulls('b', 'main', []), pulls('b', 'testing', []),
  ]).ruta;
  assert.equal((await recolectar({ proyecto: 't' })).recientes[0].descripcion, '');
});

test('partial refresh keeps the other repo and computes cambios', async () => {
  const salida = entorno();
  const abierta = (repo, n) => ({ id: `${repo}#${n}`, repo, numero: n, titulo: 't', base: 'main', portal: 'P', estadoPr: 'OPEN', accion: 'otra' });
  const reciente = { id: 'a#9', repo: 'a', numero: 9, estadoPr: 'MERGED' };
  writeFileSync(rutaInstantanea(salida), JSON.stringify({ generado: hace(1), prs: [abierta('a', 8), abierta('b', 5)], recientes: [reciente] }));
  const f = falsoGhRutas([
    { patron: '^api user$', json: { login: 'yo' } },
    { patron: '^pr list -R o/b ', json: [] },
    { patron: '^api repos/o/b/pulls/5$', json: { state: 'closed', merged_at: hace(0), closed_at: hace(0) } },
    pulls('b', 'main', []), pulls('b', 'testing', []),
  ]);
  process.env.SEKI_GH = f.ruta;
  const foto = await recolectar({ proyecto: 't', repos: ['b'] });
  assert.deepEqual(foto.prs.map((x) => x.id), ['a#8']);
  assert.deepEqual(foto.recientes.map((x) => x.id), ['a#9']);
  assert.equal(foto.cambios.mergeadas.length, 1);
  assert.equal(foto.cambios.mergeadas[0].id, 'b#5');
  assert.deepEqual(leerJson(rutaInstantanea(salida)).prs.map((x) => x.id), ['a#8']);
  assert.ok(!f.llamadas().some((c) => c.join(' ').includes('o/a')));
});

test('partial refresh without a readable previous snapshot behaves as a full refresh of the given repos', async () => {
  const salida = entorno();
  writeFileSync(rutaInstantanea(salida), '{ not json');
  process.env.SEKI_GH = falsoGhRutas([
    { patron: '^api user$', json: { login: 'yo' } }, { patron: '^pr list -R o/b ', json: [] },
    pulls('b', 'main', [rest(1, 't', 'yo', { merged_at: hace(1), closed_at: hace(1) })]), pulls('b', 'testing', []),
  ]).ruta;
  const foto = await recolectar({ proyecto: 't', repos: ['b'] });
  assert.deepEqual(foto.recientes.map((x) => x.id), ['b#1']);
  assert.equal(foto.cambios, null);
});

test('the twin listing stops at 3 pages; the recent listing stops when a page ends outside the window', async () => {
  entorno();
  const pagina = (n, dias) => Array.from({ length: 100 }, (_, i) => rest(n * 1000 + i, `t${n}-${i}`, 'yo', { updated_at: hace(dias) }));
  const f = falsoGhRutas([
    { patron: '^api user$', json: { login: 'yo' } }, { patron: '^pr list ', json: [] },
    ...Array.from({ length: 10 }, (_, i) => pulls('a', 'main', pagina(i + 1, 3), i + 1)),
    pulls('a', 'testing', []), pulls('b', 'main', []), pulls('b', 'testing', []),
  ]);
  process.env.SEKI_GH = f.ruta;
  await recolectar({ proyecto: 't' });
  const contar = (f2, tipo) => f2.llamadas().filter((c) => c[1]?.startsWith('repos/o/a/pulls?base=main&') && c[1].includes(tipo)).length;
  assert.equal(contar(f, 'state=all'), 3);
  assert.equal(contar(f, 'state=closed'), 10);

  entorno();
  const g = falsoGhRutas([
    { patron: '^api user$', json: { login: 'yo' } }, { patron: '^pr list ', json: [] },
    pulls('a', 'main', pagina(1, 90), 1), pulls('a', 'main', pagina(2, 3), 2), pulls('a', 'main', pagina(3, 3), 3),
    pulls('a', 'testing', []), pulls('b', 'main', []), pulls('b', 'testing', []),
  ]);
  process.env.SEKI_GH = g.ruta;
  await recolectar({ proyecto: 't' });
  assert.equal(contar(g, 'state=closed'), 1);
  assert.ok(!g.llamadas().some((c) => c[1]?.includes('state=closed') && c[1].includes('page=2')));
});

test('a PR created long ago and merged recently appears in recientes', async () => {
  entorno();
  process.env.SEKI_GH = falsoGhRutas([
    { patron: '^api user$', json: { login: 'yo' } }, { patron: '^pr list ', json: [] },
    pulls('a', 'main', [rest(7, 'slow', 'yo', { created_at: hace(200), merged_at: hace(2), closed_at: hace(2), updated_at: hace(2) })]),
    pulls('a', 'testing', []), pulls('b', 'main', []), pulls('b', 'testing', []),
  ]).ruta;
  assert.deepEqual((await recolectar({ proyecto: 't' })).recientes.map((x) => x.id), ['a#7']);
});

test('a line with a single base does not request base=undefined', async () => {
  const dir = temporal('seki-rec-');
  const salida = join(dir, 'salida');
  mkdirSync(join(salida, 'datos'), { recursive: true });
  const ruta = join(dir, 'proyectos.json');
  writeFileSync(ruta, JSON.stringify({ t: { owner: 'o', autor: 'yo', salida, repos: { a: { lineas: [{ portal: 'P', prod: 'main' }] } } } }));
  process.env.SEKI_REVIEW_CONFIG = ruta;
  const f = falsoGhRutas([
    { patron: '^api user$', json: { login: 'yo' } }, { patron: '^pr list ', json: [] },
    pulls('a', 'main', [rest(1, 't', 'yo', { merged_at: hace(1), closed_at: hace(1) })]),
  ]);
  process.env.SEKI_GH = f.ruta;
  const foto = await recolectar({ proyecto: 't' });
  assert.deepEqual(foto.recientes.map((x) => x.id), ['a#1']);
  assert.ok(!f.llamadas().some((c) => c.join(' ').includes('undefined')));
});

test('proyecto() merges entregas and vigia defaults under user values and clamps the interval', () => {
  entorno({ entregas: { ventanaDias: 10 }, vigia: { intervaloSeg: 5 } });
  let p = proyecto('t');
  assert.equal(p.entregas.ventanaDias, 10);
  assert.equal(p.entregas.alertaDias, 5);
  assert.deepEqual(p.entregas.sufijosRama, ['-pruebas', '-testing', '-staging']);
  assert.equal(p.entregas.patronId, null);
  assert.equal(p.vigia.intervaloSeg, 120);
  entorno();
  p = proyecto('t');
  assert.equal(p.entregas.cerrarTrasDias, 7);
  assert.equal(p.vigia.intervaloSeg, 300);
});

// Review intake: PRs requested from the owner and PRs added by link.
function entornoRevisar() {
  const dir = temporal('seki-rec-');
  const salida = join(dir, 'salida');
  mkdirSync(join(salida, 'datos'), { recursive: true });
  const ruta = join(dir, 'proyectos.json');
  writeFileSync(ruta, JSON.stringify({ t: { owner: 'o', autor: 'yo', salida, repos: { a: { lineas: [linea], inactivas: { viejo: 'retired' } }, b: { lineas: [linea] } } } }));
  process.env.SEKI_REVIEW_CONFIG = ruta;
  return salida;
}
const ghPr = (n, autor, extra) => ({
  number: n, title: `pr ${n}`, url: `u/${n}`, baseRefName: 'viejo', headRefName: `rama-${n}`, createdAt: hace(3), updatedAt: hace(1),
  additions: 1, deletions: 1, changedFiles: 1, isDraft: false, headRefOid: `sha${n}`, author: { login: autor }, reviewDecision: '', body: 'b', state: 'OPEN', ...extra,
});
const baseRutas = (...mas) => [
  { patron: '^api user$', json: { login: 'yo' } },
  ...mas,
  pulls('a', 'main', []), pulls('a', 'testing', []), pulls('b', 'main', []), pulls('b', 'testing', []),
];
const pedida = (repo, lista) => ({ patron: `^pr list -R o/${repo} .*--search review-requested:@me`, json: lista });
const propias = (repo, lista) => ({ patron: `^pr list -R o/${repo} .*--author yo`, json: lista });
const vista = (repo, n, json) => ({ patron: `^pr view ${n} -R o/${repo} `, json });

test('a requested PR enters the snapshot without the author filter and is remembered after it leaves the search', async () => {
  const salida = entornoRevisar();
  const f = falsoGhRutas(baseRutas(pedida('a', [ghPr(50, 'otro')]), propias('a', [ghPr(1, 'yo')]), { patron: '^pr list ', json: [] }));
  process.env.SEKI_GH = f.ruta;
  const foto = await recolectar({ proyecto: 't' });
  assert.deepEqual(foto.prs.map((x) => x.id).sort(), ['a#1', 'a#50']);
  const ajena = foto.prs.find((x) => x.id === 'a#50');
  assert.equal(ajena.paraRevisar, 'solicitada');
  assert.equal(ajena.soloRevision, true);
  assert.equal(ajena.autor, 'otro');
  const propia = foto.prs.find((x) => x.id === 'a#1');
  assert.equal(propia.paraRevisar, undefined);
  assert.ok(!propia.soloRevision);
  const busqueda = f.llamadas().find((c) => c.includes('review-requested:@me') && c.includes('o/a'));
  assert.ok(!busqueda.includes('--author'));
  assert.deepEqual(leerJson(join(salida, 'datos', 'revisar.json')).prs.map((e) => [e.repo, e.numero, e.origen]), [['a', 50, 'solicitada']]);

  // The owner reviewed it on GitHub: the search no longer returns it, but the list still does.
  f.fijar(baseRutas(pedida('a', []), propias('a', [ghPr(1, 'yo')]), vista('a', 50, ghPr(50, 'otro')), { patron: '^pr list ', json: [] }));
  const otra = await recolectar({ proyecto: 't' });
  assert.equal(otra.prs.find((x) => x.id === 'a#50')?.paraRevisar, 'solicitada');
  assert.ok(f.llamadas().some((c) => c[0] === 'pr' && c[1] === 'view' && c[2] === '50'));
});

test('a listed PR that GitHub reports closed or merged leaves the list and the snapshot', async () => {
  const salida = entornoRevisar();
  writeFileSync(join(salida, 'datos', 'revisar.json'), JSON.stringify({ version: 1, prs: [
    { repo: 'a', numero: 60, origen: 'enlace', agregada: hace(2) }, { repo: 'a', numero: 61, origen: 'solicitada', agregada: hace(2) }, { repo: 'a', numero: 62, origen: 'enlace', agregada: hace(2) },
  ] }));
  process.env.SEKI_GH = falsoGhRutas(baseRutas(
    vista('a', 60, ghPr(60, 'otro', { state: 'MERGED' })), vista('a', 61, ghPr(61, 'otro', { state: 'CLOSED' })), vista('a', 62, ghPr(62, 'otro')),
    { patron: '^pr list ', json: [] },
  )).ruta;
  const foto = await recolectar({ proyecto: 't' });
  assert.deepEqual(foto.prs.map((x) => x.id), ['a#62']);
  assert.equal(foto.prs[0].paraRevisar, 'enlace');
  assert.deepEqual(leerJson(join(salida, 'datos', 'revisar.json')).prs.map((e) => e.numero), [62]);
});

test('listed PRs stay out of deliveries and out of the merge and new-PR changes', async () => {
  const salida = entornoRevisar();
  const enPruebas = (n, autor, extra) => ghPr(n, autor, { baseRefName: 'testing', title: `solo pruebas ${n}`, ...extra });
  const archivos = { patron: '^api --paginate --slurp repos/o/a/pulls/\\d+/(files|commits)', json: [[]] };
  writeFileSync(join(salida, 'datos', 'revisar.json'), JSON.stringify({ version: 1, prs: [{ repo: 'a', numero: 70, origen: 'enlace', agregada: hace(1) }] }));
  const f = falsoGhRutas(baseRutas(archivos, vista('a', 70, enPruebas(70, 'otro')), propias('a', [enPruebas(1, 'yo')]), { patron: '^pr list ', json: [] }));
  process.env.SEKI_GH = f.ruta;
  await recolectar({ proyecto: 't' });
  const entregas = leerJson(rutaEntregas(proyecto('t').salida)).entregas.flatMap((e) => e.prs);
  assert.ok(entregas.includes('a#1'));
  assert.ok(!entregas.includes('a#70'));

  f.fijar(baseRutas(archivos, vista('a', 70, enPruebas(70, 'otro', { state: 'MERGED' })), propias('a', [enPruebas(1, 'yo')]), { patron: '^pr list ', json: [] }));
  const foto = await recolectar({ proyecto: 't' });
  assert.ok(!(foto.cambios?.mergeadas ?? []).some((x) => x.id === 'a#70'));
  assert.ok(!(foto.cambios?.nuevas ?? []).some((x) => x.id === 'a#70'));
  assert.ok(!f.llamadas().some((c) => c[1] === 'repos/o/a/pulls/70'));
  assert.ok(!existsSync(rutaEventos(salida)) || !readFileSync(rutaEventos(salida), 'utf8').includes('a#70'));
});

test('the owner PR that is also listed keeps its grouping and shows the mark; the author filter still applies to the rest', async () => {
  const salida = entornoRevisar();
  writeFileSync(join(salida, 'datos', 'revisar.json'), JSON.stringify({ version: 1, prs: [{ repo: 'a', numero: 1, origen: 'enlace', agregada: hace(1) }] }));
  const f = falsoGhRutas(baseRutas(propias('a', [ghPr(1, 'yo')]), { patron: '^pr list ', json: [] }));
  process.env.SEKI_GH = f.ruta;
  const foto = await recolectar({ proyecto: 't' });
  assert.equal(foto.prs.length, 1);
  assert.equal(foto.prs[0].paraRevisar, 'enlace');
  assert.ok(!foto.prs[0].soloRevision);
  assert.ok(!f.llamadas().some((c) => c[1] === 'view'));
  const generales = f.llamadas().filter((c) => c[0] === 'pr' && c[1] === 'list' && !c.includes('--search'));
  assert.ok(generales.length > 0 && generales.every((c) => c.includes('--author')));
});

test('with no requested PRs and an empty list nothing is added and no list file is written', async () => {
  const salida = entornoRevisar();
  process.env.SEKI_GH = falsoGhRutas(baseRutas({ patron: '^pr list ', json: [] })).ruta;
  const foto = await recolectar({ proyecto: 't' });
  assert.deepEqual(foto.prs, []);
  assert.equal(existsSync(join(salida, 'datos', 'revisar.json')), false);
});

test('a partial refresh only touches the listed PRs of the given repos', async () => {
  const salida = entornoRevisar();
  writeFileSync(join(salida, 'datos', 'revisar.json'), JSON.stringify({ version: 1, prs: [
    { repo: 'a', numero: 80, origen: 'enlace', agregada: hace(1) }, { repo: 'b', numero: 81, origen: 'enlace', agregada: hace(1) },
  ] }));
  const f = falsoGhRutas(baseRutas(vista('b', 81, ghPr(81, 'otro', { state: 'CLOSED' })), { patron: '^pr list ', json: [] }));
  process.env.SEKI_GH = f.ruta;
  await recolectar({ proyecto: 't', repos: ['b'] });
  assert.ok(!f.llamadas().some((c) => c.join(' ').includes('o/a')));
  assert.deepEqual(leerJson(join(salida, 'datos', 'revisar.json')).prs.map((e) => e.numero), [80]);
});

test('a failing gh view keeps the listed PR in the list and out of the snapshot', async () => {
  const salida = entornoRevisar();
  writeFileSync(join(salida, 'datos', 'revisar.json'), JSON.stringify({ version: 1, prs: [{ repo: 'a', numero: 90, origen: 'enlace', agregada: hace(1) }] }));
  process.env.SEKI_GH = falsoGhRutas(baseRutas({ patron: '^pr view 90 ', salida: 1, stderr: 'boom' }, { patron: '^pr list ', json: [] })).ruta;
  const foto = await recolectar({ proyecto: 't' });
  assert.deepEqual(foto.prs, []);
  assert.deepEqual(leerJson(join(salida, 'datos', 'revisar.json')).prs.map((e) => e.numero), [90]);
});

test('a dismissed requested PR stays hidden while requested and its entry goes once the search stops returning it', async () => {
  const salida = entornoRevisar();
  writeFileSync(join(salida, 'datos', 'revisar.json'), JSON.stringify({ version: 1, prs: [{ repo: 'a', numero: 55, origen: 'solicitada', agregada: hace(1), descartada: true }] }));
  const f = falsoGhRutas(baseRutas(pedida('a', [ghPr(55, 'otro')]), { patron: '^pr list ', json: [] }));
  process.env.SEKI_GH = f.ruta;
  assert.deepEqual((await recolectar({ proyecto: 't' })).prs, []);
  assert.equal(leerJson(join(salida, 'datos', 'revisar.json')).prs.length, 1);
  f.fijar(baseRutas(pedida('a', []), { patron: '^pr list ', json: [] }));
  await recolectar({ proyecto: 't' });
  assert.deepEqual(leerJson(join(salida, 'datos', 'revisar.json')).prs, []);
});

const sinAutor = () => {
  const dir = temporal('seki-rec-');
  const salida = join(dir, 'salida');
  mkdirSync(join(salida, 'datos'), { recursive: true });
  const ruta = join(dir, 'proyectos.json');
  writeFileSync(ruta, JSON.stringify({ t: { owner: 'o', salida, repos: { a: { lineas: [linea], inactivas: { viejo: 'retired' } } } } }));
  process.env.SEKI_REVIEW_CONFIG = ruta;
  return salida;
};

test('without an author filter the listed and requested PRs are still marked', async () => {
  const salida = sinAutor();
  writeFileSync(join(salida, 'datos', 'revisar.json'), JSON.stringify({ version: 1, prs: [{ repo: 'a', numero: 2, origen: 'enlace', agregada: hace(1) }] }));
  const f = falsoGhRutas([
    { patron: '^api repos/o/a/pulls\\?base=', json: [] },
    { patron: '^pr list -R o/a .*--search review-requested:@me', json: [ghPr(1, 'otro')] },
    { patron: '^pr list -R o/a ', json: [ghPr(1, 'otro'), ghPr(2, 'otro'), ghPr(3, 'yo')] },
  ]);
  process.env.SEKI_GH = f.ruta;
  const foto = await recolectar({ proyecto: 't' });
  assert.deepEqual(Object.fromEntries(foto.prs.map((x) => [x.id, x.paraRevisar])), { 'a#1': 'solicitada', 'a#2': 'enlace', 'a#3': undefined });
  assert.ok(foto.prs.every((x) => !x.soloRevision));
});

test('20 listed PRs are processed with at most 6 gh calls at once', async () => {
  const salida = entornoRevisar();
  const numeros = Array.from({ length: 20 }, (_, i) => 300 + i);
  writeFileSync(join(salida, 'datos', 'revisar.json'), JSON.stringify({ version: 1, prs: numeros.map((numero) => ({ repo: 'a', numero, origen: 'enlace', agregada: hace(1) })) }));
  const f = falsoGhRutas([]);
  // One route per number so each view answers its own PR.
  f.fijar(baseRutas(
    ...numeros.map((n) => ({ patron: `^pr view ${n} -R o/a `, esperaMs: 40, json: ghPr(n, 'otro', { baseRefName: 'zzz' }) })),
    { patron: '^api --paginate --slurp repos/o/a/pulls/\\d+/(files|commits)', esperaMs: 40, json: [[]] },
    { patron: '^pr list ', json: [] },
  ));
  process.env.SEKI_GH = f.ruta;
  const foto = await recolectar({ proyecto: 't' });
  assert.equal(foto.prs.length, 20);
  assert.ok(f.maxSimultaneas() <= 6, `at most 6 at once, saw ${f.maxSimultaneas()}`);
  assert.ok(f.maxSimultaneas() >= 2, 'the work does run in parallel');
});

test('a failing requested search does not prune dismissed entries and the failure is logged', async () => {
  const salida = entornoRevisar();
  writeFileSync(join(salida, 'datos', 'revisar.json'), JSON.stringify({ version: 1, prs: [{ repo: 'a', numero: 55, origen: 'solicitada', agregada: hace(1), descartada: true }] }));
  process.env.SEKI_GH = falsoGhRutas(baseRutas({ patron: '^pr list -R o/a .*--search', salida: 1, stderr: 'boom' }, { patron: '^pr list ', json: [] })).ruta;
  const original = console.error;
  const lineas = [];
  console.error = (...a) => lineas.push(a.join(' '));
  try { await recolectar({ proyecto: 't' }); } finally { console.error = original; }
  assert.equal(leerJson(join(salida, 'datos', 'revisar.json')).prs.length, 1);
  assert.ok(lineas.some((l) => l.includes('[seki-review/revisar] Requested PRs of a were not read')));
});

test('a requested search that reaches its limit is logged', async () => {
  entornoRevisar();
  process.env.SEKI_GH = falsoGhRutas(baseRutas(pedida('a', Array.from({ length: 100 }, (_, i) => ghPr(400 + i, 'otro'))), { patron: '^pr list ', json: [] })).ruta;
  const original = console.error;
  const lineas = [];
  console.error = (...a) => lineas.push(a.join(' '));
  try { await recolectar({ proyecto: 't' }); } finally { console.error = original; }
  assert.ok(lineas.some((l) => l.includes('reached its limit of 100')));
});

test('listed PRs add no rows to the QA guide', async () => {
  const salida = entornoRevisar();
  writeFileSync(join(salida, 'datos', 'revisar.json'), JSON.stringify({ version: 1, prs: [{ repo: 'a', numero: 70, origen: 'enlace', agregada: hace(1) }] }));
  const enPruebas = (n, autor) => ghPr(n, autor, { baseRefName: 'testing', title: `solo pruebas ${n}` });
  process.env.SEKI_GH = falsoGhRutas(baseRutas(
    { patron: '^api --paginate --slurp repos/o/a/pulls/\\d+/(files|commits)', json: [[]] },
    vista('a', 70, enPruebas(70, 'otro')), propias('a', [enPruebas(1, 'yo')]), { patron: '^pr list ', json: [] },
  )).ruta;
  const foto = await recolectar({ proyecto: 't' });
  const { filasDeGuia } = await import('../mcp/lib/qa-guia.mjs');
  const entregas = leerJson(rutaEntregas(salida)).entregas;
  const filas = filasDeGuia({ entregas, prsPorId: new Map(foto.prs.map((x) => [x.id, x])) });
  assert.ok(!filas.some((f) => f.prs.includes('a#70')));
  assert.ok(!JSON.stringify(entregas).includes('a#70'));
});

test('the item built for an owner PR keeps its fields exactly (no behaviour change from the extraction)', async () => {
  entornoRevisar();
  const f = falsoGhRutas(baseRutas(propias('a', [ghPr(1, 'yo', { baseRefName: 'viejo', body: null, reviewDecision: 'APPROVED' })]), { patron: '^pr list ', json: [] }));
  process.env.SEKI_GH = f.ruta;
  const [item] = (await recolectar({ proyecto: 't' })).prs;
  const { creada, actualizada, ...resto } = item;
  assert.ok(creada && actualizada);
  assert.deepEqual(resto, {
    id: 'a#1', repo: 'a', repoEtiqueta: 'a', numero: 1, titulo: 'pr 1', url: 'u/1', base: 'viejo', rama: 'rama-1', portal: 'viejo', ambiente: 'inactiva',
    motivoInactiva: 'retired', estadoPr: 'OPEN', autor: 'yo', borrador: false, dias: 3, adiciones: 1, eliminaciones: 1, archivos: 1, headSha: 'sha1', descripcion: '',
    revisionGithub: 'APPROVED', seguridad: false, esfuerzoTamano: item.esfuerzoTamano, accion: 'inactiva',
  });
});
