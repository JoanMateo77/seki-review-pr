import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { anexarLinea, conBloqueo, conBloqueoSync, escribirAtomico } from '../mcp/lib/bloqueo.mjs';
import { escribirJson } from '../mcp/lib/cache.mjs';

const ejecutar = promisify(execFile);
const BLOQUEO = pathToFileURL(join(import.meta.dirname, '../mcp/lib/bloqueo.mjs')).href;
const CACHE = pathToFileURL(join(import.meta.dirname, '../mcp/lib/cache.mjs')).href;

async function conTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'seki-bloqueo-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const lockViejo = (ruta, pid) => {
  writeFileSync(`${ruta}.lock`, JSON.stringify({ pid, ts: Date.now() - 60_000 }));
};

// Child process that holds the lock for `ms` and prints "listo" once it has it.
function retenerEnHijo(ruta, ms) {
  const hijo = spawn(process.execPath, ['--input-type=module', '-e',
    `import { conBloqueo } from ${JSON.stringify(BLOQUEO)};
     await conBloqueo(${JSON.stringify(ruta)}, async () => { console.log('listo'); await new Promise((r) => setTimeout(r, ${ms})); });`]);
  const listo = new Promise((resolve, reject) => {
    hijo.stdout.on('data', (d) => String(d).includes('listo') && resolve());
    hijo.on('error', reject);
    hijo.on('exit', (c) => c && reject(new Error(`child exited ${c}`)));
  });
  const fin = new Promise((r) => hijo.on('exit', r));
  return { listo, fin };
}

test('two concurrent conBloqueo calls run one after the other', () => conTemp(async (dir) => {
  const ruta = join(dir, 'a.json');
  const orden = [];
  const tarea = (id) => conBloqueo(ruta, async () => {
    orden.push(`ini-${id}`);
    await dormir(80);
    orden.push(`fin-${id}`);
  });
  await Promise.all([tarea(1), tarea(2)]);
  assert.deepEqual(orden, ['ini-1', 'fin-1', 'ini-2', 'fin-2']);
  assert.equal(existsSync(`${ruta}.lock`), false);
}));

test('conBloqueoSync waits for a lock held by another process', () => conTemp(async (dir) => {
  const ruta = join(dir, 'b.json');
  const hijo = retenerEnHijo(ruta, 400);
  await hijo.listo;
  const t0 = Date.now();
  const r = conBloqueoSync(ruta, () => 'dentro');
  assert.equal(r, 'dentro');
  assert.ok(Date.now() - t0 >= 150, 'it should have waited for the child');
  await hijo.fin;
  assert.equal(existsSync(`${ruta}.lock`), false);
}));

test('stale lock of a dead pid is taken over (async and sync)', () => conTemp(async (dir) => {
  const ruta = join(dir, 'c.json');
  lockViejo(ruta, 999999);
  assert.equal(await conBloqueo(ruta, () => 'a'), 'a');
  lockViejo(ruta, 999999);
  assert.equal(conBloqueoSync(ruta, () => 's'), 's');
  assert.equal(existsSync(`${ruta}.lock`), false);
  assert.deepEqual(readdirSync(dir), []);
}));

test('corrupt lock older than 30 s by mtime is taken over, a fresh one is not', () => conTemp(async (dir) => {
  const ruta = join(dir, 'd.json');
  writeFileSync(`${ruta}.lock`, 'no json');
  await assert.rejects(conBloqueo(ruta, () => 1, { esperaMs: 150 }), /Lock busy: d\.json/);
  const antes = new Date(Date.now() - 60_000);
  utimesSync(`${ruta}.lock`, antes, antes);
  assert.equal(conBloqueoSync(ruta, () => 'ok'), 'ok');
}));

test('old lock of a live pid is not taken over', () => conTemp(async (dir) => {
  const ruta = join(dir, 'e.json');
  lockViejo(ruta, process.pid);
  await assert.rejects(conBloqueo(ruta, () => 1, { esperaMs: 200 }), /Lock busy: e\.json/);
  assert.throws(() => conBloqueoSync(ruta, () => 1, { esperaMs: 200 }), /Lock busy: e\.json/);
  assert.equal(existsSync(`${ruta}.lock`), true);
}));

test('fresh lock of the live test pid is not taken over', () => conTemp(async (dir) => {
  const ruta = join(dir, 'f.json');
  writeFileSync(`${ruta}.lock`, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  await assert.rejects(conBloqueo(ruta, () => 1, { esperaMs: 200 }), /Lock busy/);
}));

test('the lock is released when fn throws', () => conTemp(async (dir) => {
  const ruta = join(dir, 'g.json');
  await assert.rejects(conBloqueo(ruta, () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(`${ruta}.lock`), false);
  assert.throws(() => conBloqueoSync(ruta, () => { throw new Error('boom2'); }), /boom2/);
  assert.equal(existsSync(`${ruta}.lock`), false);
}));

test('a lock replaced by another holder is not removed on release', () => conTemp(async (dir) => {
  const ruta = join(dir, 'h.json');
  const ajeno = JSON.stringify({ pid: process.pid, ts: 1, n: 'otro' });
  conBloqueoSync(ruta, () => writeFileSync(`${ruta}.lock`, ajeno));
  assert.equal(readFileSync(`${ruta}.lock`, 'utf8'), ajeno);
}));

test('escribirAtomico leaves no tmp file and cleans up when rename fails', () => conTemp(async (dir) => {
  const ruta = join(dir, 'i.json');
  escribirAtomico(ruta, 'hola');
  assert.equal(readFileSync(ruta, 'utf8'), 'hola');
  assert.deepEqual(readdirSync(dir), ['i.json']);
  assert.throws(() => escribirAtomico(join(dir, 'no', 'existe.json'), 'x'));
  assert.deepEqual(readdirSync(dir), ['i.json']);
}));

test('two processes calling escribirJson on the same file leave valid JSON and no leftovers', () => conTemp(async (dir) => {
  const ruta = join(dir, 'j.json');
  const hijo = (marca) => ejecutar(process.execPath, ['--input-type=module', '-e',
    `import { escribirJson } from ${JSON.stringify(CACHE)};
     const datos = { marca: process.argv[1], relleno: 'x'.repeat(20000) };
     for (let i = 0; i < 60; i++) escribirJson(${JSON.stringify(ruta)}, datos);`, marca]);
  await Promise.all([hijo('A'), hijo('B')]);
  const final = JSON.parse(readFileSync(ruta, 'utf8'));
  assert.ok(['A', 'B'].includes(final.marca));
  assert.equal(final.relleno.length, 20000);
  assert.deepEqual(readdirSync(dir), ['j.json']);
}));

test('escribirJson keeps its format and stays synchronous', () => conTemp(async (dir) => {
  const ruta = join(dir, 'sub', 'k.json');
  const r = escribirJson(ruta, { a: 1 });
  assert.equal(r, undefined);
  assert.equal(readFileSync(ruta, 'utf8'), '{\n  "a": 1\n}\n');
}));

test('anexarLinea from two processes keeps every line whole', () => conTemp(async (dir) => {
  const ruta = join(dir, 'ev.jsonl');
  const hijo = (marca) => ejecutar(process.execPath, ['--input-type=module', '-e',
    `import { anexarLinea } from ${JSON.stringify(BLOQUEO)};
     for (let i = 0; i < 40; i++) await anexarLinea(${JSON.stringify(ruta)}, JSON.stringify({ m: process.argv[1], i }) + '\\n\\n');`, marca]);
  await Promise.all([hijo('A'), hijo('B')]);
  await anexarLinea(ruta, 'fin');
  const lineas = readFileSync(ruta, 'utf8').split('\n');
  assert.equal(lineas.pop(), '');
  assert.equal(lineas.length, 81);
  assert.equal(lineas.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).length, 80);
  assert.equal(lineas.at(-1), 'fin');
}));
