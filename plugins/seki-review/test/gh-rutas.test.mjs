import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { falsoGhRutas } from './util/gh-rutas.mjs';
import { gh, ghJson } from '../mcp/lib/proceso.mjs';

const exec = promisify(execFile);

test('an anchored route does not match a longer argument', async () => {
  const f = falsoGhRutas([{ patron: '^api repos/o/r/pulls/1$', json: { n: 1 } }]);
  process.env.SEKI_GH = f.ruta;
  assert.deepEqual(await ghJson(['api', 'repos/o/r/pulls/1']), { n: 1 });
  await assert.rejects(() => gh(['api', 'repos/o/r/pulls/10']));
});

test('an unrouted call exits 1 with the joined args', async () => {
  const f = falsoGhRutas([]);
  await assert.rejects(() => exec(f.ruta, ['pr', 'list']), (e) => e.code === 1 && e.stderr === 'no route: pr list');
});

test('a route with salida and stderr makes gh() reject', async () => {
  const f = falsoGhRutas([{ patron: '^pr view', salida: 1, stderr: 'boom' }]);
  process.env.SEKI_GH = f.ruta;
  await assert.rejects(() => gh(['pr', 'view']), (e) => e.code === 1 && e.stderr === 'boom');
});

test('texto answers raw stdout', async () => {
  const f = falsoGhRutas([{ patron: '^x$', texto: 'plain' }]);
  const { stdout } = await exec(f.ruta, ['x']);
  assert.equal(stdout, 'plain');
});

test('fijar swaps routes between calls and failed calls are recorded', async () => {
  const f = falsoGhRutas([{ patron: '^a$', json: 1 }]);
  assert.equal((await exec(f.ruta, ['a'])).stdout, '1');
  f.fijar([{ patron: '^a$', json: 2 }]);
  assert.equal((await exec(f.ruta, ['a'])).stdout, '2');
  await assert.rejects(() => exec(f.ruta, ['zzz']));
  assert.deepEqual(f.llamadas(), [['a'], ['a'], ['zzz']]);
});
