import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsearEnlacePr, leerRevisar, agregarRevisar, quitarRevisar, podarRevisar, MAX_REVISAR } from '../mcp/lib/revisar.mjs';
import { leerJson, rutaRevisar } from '../mcp/lib/cache.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const proyecto = () => {
  const dir = mkdtempSync(join(tmpdir(), 'seki-revisar-'));
  dirs.push(dir);
  return { clave: 't', owner: 'Acme', salida: join(dir, 'salida'), repos: { api: {}, web: {} } };
};

test('parsearEnlacePr accepts every documented form', () => {
  const p = proyecto();
  const bien = { repo: 'api', numero: 12 };
  for (const t of [
    'https://github.com/Acme/api/pull/12',
    'https://github.com/acme/api/pull/12/files',
    'https://github.com/acme/api/pull/12/commits/abc123',
    'https://github.com/acme/api/pull/12?w=1',
    'https://github.com/acme/api/pull/12#discussion_r99',
    '  https://github.com/acme/api/pull/12  \n',
    'acme/api#12', 'api#12', 'api 12', 'API#12',
  ]) assert.deepEqual(parsearEnlacePr(t, p), bien, t);
});

test('parsearEnlacePr rejects unconfigured repos, other owners, garbage and long text', () => {
  const p = proyecto();
  const falla = (t, codigo, texto) => assert.throws(() => parsearEnlacePr(t, p), (e) => e.codigo === codigo && (!texto || e.message.includes(texto)), String(t).slice(0, 40));
  falla('https://github.com/Acme/otro/pull/3', 'REPO_NO_CONFIGURADO', 'The repository Acme/otro is not configured in project t');
  falla('https://github.com/Otra/api/pull/3', 'REPO_NO_CONFIGURADO', 'Otra/api');
  falla('otro#3', 'REPO_NO_CONFIGURADO');
  falla('hola', 'ENLACE_INVALIDO');
  falla('', 'ENLACE_INVALIDO');
  falla('   ', 'ENLACE_INVALIDO');
  falla(null, 'ENLACE_INVALIDO');
  falla('api#0', 'ENLACE_INVALIDO');
  falla('api#10000001', 'ENLACE_INVALIDO');
  falla('api#99999999999999999999', 'ENLACE_INVALIDO');
  falla('http://github.com/Acme/api/pull/3', 'ENLACE_INVALIDO');
  falla('https://gitlab.com/Acme/api/pull/3', 'ENLACE_INVALIDO');
  falla('x'.repeat(10240), 'ENLACE_INVALIDO', '500');
  falla(`https://github.com/Acme/api/pull/3${'a'.repeat(600)}`, 'ENLACE_INVALIDO');
  falla('api#3; rm -rf /', 'ENLACE_INVALIDO');
});

test('the list collapses same-id entries and never downgrades an enlace', () => {
  const p = proyecto();
  assert.deepEqual(leerRevisar(p), []);
  assert.equal(agregarRevisar(p, { repo: 'api', numero: 1, origen: 'solicitada' }), 'agregada');
  assert.equal(agregarRevisar(p, { repo: 'api', numero: 1, origen: 'solicitada' }), 'ya_estaba');
  assert.equal(agregarRevisar(p, { repo: 'api', numero: 1, origen: 'enlace' }), 'ya_estaba');
  assert.equal(agregarRevisar(p, { repo: 'api', numero: 1, origen: 'solicitada' }), 'ya_estaba');
  agregarRevisar(p, [{ repo: 'web', numero: 2, origen: 'solicitada' }, { repo: 'web', numero: 2, origen: 'solicitada' }]);
  const lista = leerRevisar(p);
  assert.deepEqual(lista.map((e) => [e.repo, e.numero, e.origen]), [['api', 1, 'enlace'], ['web', 2, 'solicitada']]);
  assert.equal(leerJson(rutaRevisar(p.salida)).version, 1);
});

test('removing a requested PR hides it until the search stops returning it; adding by link brings it back', () => {
  const p = proyecto();
  agregarRevisar(p, [{ repo: 'api', numero: 1, origen: 'solicitada' }, { repo: 'api', numero: 2, origen: 'enlace' }]);
  assert.equal(quitarRevisar(p, 'api#1'), true);
  assert.equal(quitarRevisar(p, 'api#2'), true);
  assert.equal(quitarRevisar(p, 'api#1'), false);
  assert.deepEqual(leerRevisar(p), []);
  assert.deepEqual(leerRevisar(p, { todas: true }).map((e) => [e.numero, !!e.descartada]), [[1, true]]);
  assert.equal(agregarRevisar(p, { repo: 'api', numero: 1, origen: 'solicitada' }), 'ya_estaba');
  assert.deepEqual(leerRevisar(p), []);
  assert.equal(agregarRevisar(p, { repo: 'api', numero: 1, origen: 'enlace' }), 'agregada');
  assert.deepEqual(leerRevisar(p).map((e) => [e.numero, e.origen, e.descartada]), [[1, 'enlace', undefined]]);
});

test('the list keeps at most 200 entries and drops the oldest requested first', () => {
  const p = proyecto();
  const entradas = Array.from({ length: MAX_REVISAR }, (_, i) => ({ repo: 'api', numero: i + 1, origen: i === 0 ? 'enlace' : 'solicitada' }));
  agregarRevisar(p, entradas);
  agregarRevisar(p, { repo: 'api', numero: 500, origen: 'enlace' });
  const ids = leerRevisar(p).map((e) => e.numero);
  assert.equal(ids.length, MAX_REVISAR);
  assert.ok(ids.includes(1), 'the old enlace stays');
  assert.ok(ids.includes(500));
  assert.ok(!ids.includes(2), 'the oldest requested goes first');
});

test('quitar and podar remove only what they are given; a corrupt file reads as empty', () => {
  const p = proyecto();
  agregarRevisar(p, [{ repo: 'api', numero: 1, origen: 'enlace' }, { repo: 'api', numero: 2, origen: 'solicitada' }, { repo: 'web', numero: 3, origen: 'solicitada' }]);
  assert.equal(quitarRevisar(p, 'api#9'), false);
  assert.equal(quitarRevisar(p, 'api#1'), true);
  assert.equal(podarRevisar(p, new Set(['web#3', 'zzz#1'])), 1);
  assert.deepEqual(leerRevisar(p).map((e) => e.numero), [2]);
  mkdirSync(join(p.salida, 'datos'), { recursive: true });
  writeFileSync(rutaRevisar(p.salida), '{ no json');
  assert.deepEqual(leerRevisar(p), []);
});
