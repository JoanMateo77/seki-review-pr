import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { falsoGhRutas } from './util/gh-rutas.mjs';
import { recolectar } from '../mcp/lib/recolectar.mjs';
import { leerJson, rutaInstantanea } from '../mcp/lib/cache.mjs';
import { proyecto } from '../mcp/lib/config.mjs';

const previo = { config: process.env.SEKI_REVIEW_CONFIG, gh: process.env.SEKI_GH };
afterEach(() => {
  for (const [k, v] of [['SEKI_REVIEW_CONFIG', previo.config], ['SEKI_GH', previo.gh]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

const hace = (dias) => new Date(Date.now() - dias * 86400000).toISOString();
const linea = { portal: 'P', prod: 'main', pruebas: 'testing' };

function entorno(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'seki-rec-'));
  const salida = join(dir, 'salida');
  mkdirSync(join(salida, 'datos'), { recursive: true });
  const ruta = join(dir, 'proyectos.json');
  writeFileSync(ruta, JSON.stringify({ t: { owner: 'o', autor: 'yo', salida, ...extra, repos: { a: { lineas: [linea] }, b: { lineas: [linea] } } } }));
  process.env.SEKI_REVIEW_CONFIG = ruta;
  return salida;
}

const pulls = (repo, base, lista, pagina = 1) => ({ patron: `^api repos/o/${repo}/pulls\\?base=${base}&state=all&sort=created&direction=desc&per_page=100&page=${pagina}$`, json: lista });
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

test('pagination continues past page 3 only while the window reaches the oldest entry, up to 10 pages', async () => {
  entorno();
  const pagina = (n, dias) => Array.from({ length: 100 }, (_, i) => rest(n * 1000 + i, `t${n}-${i}`, 'yo', { created_at: hace(dias) }));
  const f = falsoGhRutas([
    { patron: '^api user$', json: { login: 'yo' } }, { patron: '^pr list ', json: [] },
    pulls('a', 'main', pagina(1, 3), 1), pulls('a', 'main', pagina(2, 3), 2), pulls('a', 'main', pagina(3, 3), 3),
    ...Array.from({ length: 7 }, (_, i) => pulls('a', 'main', pagina(i + 4, 3), i + 4)),
    pulls('a', 'testing', []), pulls('b', 'main', []), pulls('b', 'testing', []),
  ]);
  process.env.SEKI_GH = f.ruta;
  await recolectar({ proyecto: 't' });
  const paginas = (b) => f.llamadas().filter((c) => c[0] === 'api' && c[1]?.startsWith(`repos/o/a/pulls?base=${b}&`)).length;
  assert.equal(paginas('main'), 10);

  const g = falsoGhRutas([
    { patron: '^api user$', json: { login: 'yo' } }, { patron: '^pr list ', json: [] },
    pulls('a', 'main', pagina(1, 3), 1), pulls('a', 'main', pagina(2, 3), 2), pulls('a', 'main', pagina(3, 90), 3),
    pulls('a', 'testing', []), pulls('b', 'main', []), pulls('b', 'testing', []),
  ]);
  process.env.SEKI_GH = g.ruta;
  await recolectar({ proyecto: 't' });
  assert.equal(g.llamadas().filter((c) => c[1]?.startsWith('repos/o/a/pulls?base=main&')).length, 3);
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
