import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { compararFotos, hayCambios } from '../mcp/lib/cambios.mjs';
import { falsoGhRutas, limpiarGhRutas } from './util/gh-rutas.mjs';

const previoGh = process.env.SEKI_GH;
afterEach(() => { if (previoGh === undefined) delete process.env.SEKI_GH; else process.env.SEKI_GH = previoGh; });
after(limpiarGhRutas);

const pr = (numero, accion, extra = {}) => ({ id: `r#${numero}`, repo: 'r', numero, titulo: `PR ${numero}`, base: 'main', portal: 'p', accion, estadoPr: 'OPEN', ...extra });

test('compararFotos reports merged, new and moved PRs', async () => {
  const gh = falsoGhRutas([{ patron: '^api repos/o/r/pulls/1$', json: { merged_at: '2026-11-01T10:00:00Z', state: 'closed' } }]);
  process.env.SEKI_GH = gh.ruta;
  const anterior = { generado: 'a', prs: [pr(1, 'revisar'), pr(2, 'revisar')] };
  const actual = { generado: 'b', prs: [pr(2, 'esperar'), pr(3, 'revisar')] };
  const c = await compararFotos(anterior, actual, 'o');
  assert.equal(c.mergeadas.length, 1);
  assert.equal(c.mergeadas[0].id, 'r#1');
  assert.equal(c.mergeadas[0].fecha, '2026-11-01T10:00:00Z');
  assert.deepEqual(c.cerradas, []);
  assert.deepEqual(c.nuevas.map((x) => x.id), ['r#3']);
  assert.deepEqual(c.movidas.map((x) => x.id), ['r#2']);
  assert.deepEqual([c.movidas[0].de, c.movidas[0].a], ['revisar', 'esperar']);
  assert.equal(hayCambios(c), true);
  assert.deepEqual(gh.llamadas(), [['api', 'repos/o/r/pulls/1']]);
});

test('compararFotos without a previous snapshot returns null; no changes is falsy', async () => {
  assert.equal(await compararFotos(null, { prs: [] }, 'o'), null);
  const foto = { generado: 'a', prs: [pr(1, 'revisar')] };
  assert.equal(hayCambios(await compararFotos(foto, foto, 'o')), false);
  assert.equal(hayCambios(null), false);
});
