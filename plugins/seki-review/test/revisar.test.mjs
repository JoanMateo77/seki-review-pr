import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
  assert.equal(agregarRevisar(p, { repo: 'api', numero: 1, origen: 'enlace' }), 'agregada', 'the upgrade is a change');
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
  assert.equal(podarRevisar(p, new Map([['web#3', { repo: 'web', numero: 3, origen: 'solicitada' }], ['zzz#1', { repo: 'zzz', numero: 1, origen: 'enlace' }]])), 1);
  assert.deepEqual(leerRevisar(p).map((e) => e.numero), [2]);
  mkdirSync(join(p.salida, 'datos'), { recursive: true });
  writeFileSync(rutaRevisar(p.salida), '{ no json');
  assert.deepEqual(leerRevisar(p), []);
});

const registrando = (fn) => {
  const original = console.error;
  const lineas = [];
  console.error = (...a) => lineas.push(a.join(' '));
  try { return { resultado: fn(), lineas }; } finally { console.error = original; }
};

test('an unreadable list is copied aside and logged before a new one starts; reads log instead of failing silently', () => {
  const p = proyecto();
  mkdirSync(join(p.salida, 'datos'), { recursive: true });
  const ruta = rutaRevisar(p.salida);
  writeFileSync(ruta, '{ not json');
  const lectura = registrando(() => leerRevisar(p));
  assert.deepEqual(lectura.resultado, []);
  assert.match(lectura.lineas.join('\n'), /\[seki-review\/revisar\] revisar\.json could not be read/);
  assert.equal(readdirSync(join(p.salida, 'datos')).filter((x) => x.startsWith('revisar.json.corrupt-')).length, 0, 'a read never moves files');
  const { lineas } = registrando(() => agregarRevisar(p, { repo: 'api', numero: 1, origen: 'enlace' }));
  assert.match(lineas.join('\n'), /copied to revisar\.json\.corrupt-/);
  const copias = readdirSync(join(p.salida, 'datos')).filter((x) => x.startsWith('revisar.json.corrupt-'));
  assert.equal(copias.length, 1);
  assert.equal(readFileSync(join(p.salida, 'datos', copias[0]), 'utf8'), '{ not json');
  assert.deepEqual(leerRevisar(p).map((e) => e.numero), [1]);
  // A file with the wrong shape is treated the same way.
  writeFileSync(ruta, JSON.stringify({ version: 1, prs: 'x' }));
  registrando(() => agregarRevisar(p, { repo: 'api', numero: 2, origen: 'enlace' }));
  assert.equal(readdirSync(join(p.salida, 'datos')).filter((x) => x.startsWith('revisar.json.corrupt-')).length, 2);
});

test('nothing is rewritten when the call changes nothing', () => {
  const p = proyecto();
  agregarRevisar(p, [{ repo: 'api', numero: 1, origen: 'enlace' }, { repo: 'api', numero: 2, origen: 'solicitada' }]);
  const antes = statSync(rutaRevisar(p.salida)).ino;
  assert.equal(agregarRevisar(p, [{ repo: 'api', numero: 1, origen: 'solicitada' }, { repo: 'api', numero: 2, origen: 'solicitada' }]), 'ya_estaba');
  assert.equal(statSync(rutaRevisar(p.salida)).ino, antes);
  assert.equal(quitarRevisar(p, 'api#9'), false);
  assert.equal(podarRevisar(p, new Map([['api#9', { repo: 'api', numero: 9, origen: 'enlace' }]])), 0);
  assert.equal(statSync(rutaRevisar(p.salida)).ino, antes);
});

test('the cap counts visible entries only and never evicts a dismissed one', () => {
  const p = proyecto();
  const descartadas = Array.from({ length: 5 }, (_, i) => ({ repo: 'web', numero: i + 1, origen: 'solicitada', agregada: '2020-01-01T00:00:00.000Z', descartada: true }));
  const visibles = Array.from({ length: MAX_REVISAR }, (_, i) => ({ repo: 'api', numero: i + 1, origen: 'solicitada', agregada: `2021-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z` }));
  mkdirSync(join(p.salida, 'datos'), { recursive: true });
  writeFileSync(rutaRevisar(p.salida), JSON.stringify({ version: 1, prs: [...descartadas, ...visibles] }));
  agregarRevisar(p, { repo: 'api', numero: 999, origen: 'enlace' });
  const todas = leerRevisar(p, { todas: true });
  assert.equal(todas.filter((e) => e.descartada).length, 5);
  assert.equal(todas.filter((e) => !e.descartada).length, MAX_REVISAR);
  assert.ok(todas.some((e) => e.numero === 999));
});

test('two processes writing the list at once lose no entries', async () => {
  const p = proyecto();
  mkdirSync(join(p.salida, 'datos'), { recursive: true });
  const modulo = fileURLToPath(new URL('../mcp/lib/revisar.mjs', import.meta.url));
  const guion = `import { agregarRevisar } from ${JSON.stringify(modulo)};
const [salida, desde] = process.argv.slice(1);
for (let i = 0; i < 25; i++) agregarRevisar({ salida }, { repo: 'api', numero: Number(desde) + i, origen: 'solicitada' });`;
  const correr = (desde) => new Promise((ok, falla) => {
    const h = spawn(process.execPath, ['--input-type=module', '-e', guion, p.salida, String(desde)], { stdio: 'inherit' });
    h.on('exit', (c) => (c === 0 ? ok() : falla(new Error(`child exited with ${c}`))));
  });
  await Promise.all([correr(1), correr(1000)]);
  assert.equal(leerRevisar(p).length, 50);
});

test('podar only drops entries unchanged since the refresh read them', () => {
  const p = proyecto();
  agregarRevisar(p, [{ repo: 'api', numero: 1, origen: 'solicitada' }, { repo: 'api', numero: 2, origen: 'solicitada' }]);
  quitarRevisar(p, 'api#2');
  const leidas = new Map(leerRevisar(p, { todas: true }).map((e) => [`${e.repo}#${e.numero}`, e]));
  // While the refresh ran, the owner added both PRs by link.
  agregarRevisar(p, [{ repo: 'api', numero: 1, origen: 'enlace' }, { repo: 'api', numero: 2, origen: 'enlace' }]);
  assert.equal(podarRevisar(p, leidas), 0);
  assert.deepEqual(leerRevisar(p).map((e) => [e.numero, e.origen]), [[1, 'enlace'], [2, 'enlace']]);
  // Unchanged entries do go.
  assert.equal(podarRevisar(p, new Map(leerRevisar(p).map((e) => [`${e.repo}#${e.numero}`, e]))), 2);
});
