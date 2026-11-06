import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { falsoGhRutas, limpiarGhRutas } from './util/gh-rutas.mjs';
import { leerJson, rutaRevisar } from '../mcp/lib/cache.mjs';
import herramienta from '../mcp/tools/pr_revisar.mjs';
import pendientes from '../mcp/tools/prs_pendientes.mjs';

after(limpiarGhRutas);
const temporales = [];
after(() => { for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true }); });
const previo = { config: process.env.SEKI_REVIEW_CONFIG, gh: process.env.SEKI_GH };
afterEach(() => { for (const [k, v] of [['SEKI_REVIEW_CONFIG', previo.config], ['SEKI_GH', previo.gh]]) v === undefined ? delete process.env[k] : (process.env[k] = v); });

let n = 0;
function entorno(rutas) {
  const clave = `pv${++n}`;
  const dir = mkdtempSync(join(tmpdir(), 'seki-pr-revisar-'));
  temporales.push(dir);
  const salida = join(dir, 'salida');
  mkdirSync(join(salida, 'datos'), { recursive: true });
  writeFileSync(join(dir, 'proyectos.json'), JSON.stringify({ [clave]: { owner: 'o', autor: 'yo', salida, repos: { r: { lineas: [{ portal: 'P', prod: 'main', pruebas: 'develop' }], inactivas: { viejo: 'retired' } } } } }));
  process.env.SEKI_REVIEW_CONFIG = join(dir, 'proyectos.json');
  const gh = falsoGhRutas(rutas);
  process.env.SEKI_GH = gh.ruta;
  return { clave, salida, gh };
}
const vista = (num, state = 'OPEN') => ({ patron: `^pr view ${num} -R o/r --json state,number$`, json: { state, number: num } });
const ghPr = (num, autor, extra = {}) => ({
  number: num, title: `pr ${num}`, url: `u/${num}`, baseRefName: 'viejo', headRefName: `rama-${num}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  additions: 1, deletions: 1, changedFiles: 1, isDraft: false, headRefOid: `sha${num}`, author: { login: autor }, reviewDecision: '', body: 'b', state: 'OPEN', ...extra,
});

test('pr_revisar declares its inputs and appends a validated link without AI or GitHub writes', async () => {
  assert.equal(herramienta.name, 'pr_revisar');
  assert.deepEqual(herramienta.inputSchema.required, ['enlace']);
  const e = entorno([vista(12)]);
  const r = await herramienta.handler({ proyecto: e.clave, enlace: 'https://github.com/o/r/pull/12/files' });
  assert.deepEqual(r, { id: 'r#12', estado: 'agregada', enlaceTablero: '#r%2312/resumen' });
  assert.deepEqual((await herramienta.handler({ proyecto: e.clave, enlace: 'r#12' })).estado, 'ya_estaba');
  assert.deepEqual(leerJson(rutaRevisar(e.salida)).prs.map((x) => [x.repo, x.numero, x.origen]), [['r', 12, 'enlace']]);
  for (const c of e.gh.llamadas()) assert.deepEqual(c.slice(0, 2), ['pr', 'view']);
});

test('pr_revisar refuses closed PRs, bad links and unconfigured repos before touching the list', async () => {
  const e = entorno([vista(5, 'MERGED')]);
  await assert.rejects(() => herramienta.handler({ proyecto: e.clave, enlace: 'r#5' }), /PR r#5 is closed or merged/);
  await assert.rejects(() => llamarCon(e, 'https://github.com/o/otro/pull/1'), /The repository o\/otro is not configured in project pv\d+/);
  await assert.rejects(() => llamarCon(e, 'x'.repeat(10240)), /longer than 500/);
  await assert.rejects(() => llamarCon(e, undefined), /required/);
  assert.equal(leerJson(rutaRevisar(e.salida), null), null);
  assert.equal(e.gh.llamadas().length, 1);
});
const llamarCon = (e, enlace) => herramienta.handler({ proyecto: e.clave, enlace });

test('prs_pendientes lists the To review section apart from the groups', async () => {
  const e = entorno([
    { patron: '^api user$', json: { login: 'yo' } },
    { patron: '^pr list -R o/r .*--search review-requested:@me', json: [ghPr(50, 'ana')] },
    { patron: '^pr list ', json: [] },
    { patron: '^api repos/o/r/pulls\\?base=', json: [] },
  ]);
  const texto = await pendientes.handler({ proyecto: e.clave });
  assert.match(texto, /0 open PRs/);
  assert.match(texto, /## To review \(1\)/);
  assert.match(texto, /- r#50 pr 50 \[Requested · by ana · /);
  assert.doesNotMatch(texto, /Branches no longer in use/);
});
