import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { anexarLinea, conBloqueo, conBloqueoSync, escribirAtomico, retirarObsoleto } from '../mcp/lib/bloqueo.mjs';
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

// Child that holds the lock, prints "listo", and releases only after the parent writes a line to its stdin.
// Just before releasing it writes the release time to `marcaLiberacion`.
function retenerEnHijo(ruta, marcaLiberacion) {
  const hijo = spawn(process.execPath, ['--input-type=module', '-e',
    `import { conBloqueo } from ${JSON.stringify(BLOQUEO)};
     import { writeFileSync } from 'node:fs';
     await conBloqueo(${JSON.stringify(ruta)}, async () => {
       console.log('listo');
       await new Promise((r) => process.stdin.once('data', r));
       process.stdin.destroy();
       writeFileSync(${JSON.stringify(marcaLiberacion)}, String(Date.now()));
     });`]);
  const listo = new Promise((resolve, reject) => {
    hijo.stdout.on('data', (d) => String(d).includes('listo') && resolve());
    hijo.on('error', reject);
    hijo.on('exit', (c) => c && reject(new Error(`child exited ${c}`)));
  });
  const fin = new Promise((r) => hijo.on('exit', r));
  return { listo, fin, liberar: () => new Promise((r) => hijo.stdin.write('go\n', r)) };
}

// Child that waits for the go file, then takes the lock `vueltas` times. Inside the critical section it
// creates a marker with 'wx', sleeps 5 ms and removes it: a second holder would hit EEXIST.
// Prints {inicio, fin, colisiones, ok}.
function contender(modo, ruta, irArchivo, vueltas) {
  const marca = `${ruta}.marca`;
  const critico = modo === 'sync'
    ? `() => { try { writeFileSync(M, '', { flag: 'wx' }); } catch (e) { if (e.code === 'EEXIST') colisiones++; else throw e; return; }
         Atomics.wait(pausa, 0, 0, 5); unlinkSync(M); }`
    : `async () => { try { writeFileSync(M, '', { flag: 'wx' }); } catch (e) { if (e.code === 'EEXIST') colisiones++; else throw e; return; }
         await new Promise((r) => setTimeout(r, 5)); unlinkSync(M); }`;
  const llamada = modo === 'sync' ? 'conBloqueoSync(RUTA, critico)' : 'await conBloqueo(RUTA, critico)';
  return ejecutar(process.execPath, ['--input-type=module', '-e',
    `import { conBloqueo, conBloqueoSync } from ${JSON.stringify(BLOQUEO)};
     import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
     const RUTA = ${JSON.stringify(ruta)}, M = ${JSON.stringify(marca)};
     const pausa = new Int32Array(new SharedArrayBuffer(4));
     let colisiones = 0;
     const critico = ${critico};
     while (!existsSync(${JSON.stringify(irArchivo)})) Atomics.wait(pausa, 0, 0, 1);
     const inicio = Date.now();
     for (let i = 0; i < ${vueltas}; i++) ${llamada};
     console.log(JSON.stringify({ inicio, fin: Date.now(), colisiones, ok: true }));`]).then((r) => JSON.parse(r.stdout));
}

function verSolape(resultados) {
  const suma = resultados.reduce((t, r) => t + (r.fin - r.inicio), 0);
  const union = Math.max(...resultados.map((r) => r.fin)) - Math.min(...resultados.map((r) => r.inicio));
  assert.ok(union < suma, `lock windows should overlap in time (union ${union} ms, sum ${suma} ms)`);
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

test('conBloqueoSync acquires only after the holding process has released', () => conTemp(async (dir) => {
  const ruta = join(dir, 'b.json');
  const marca = join(dir, 'liberado.txt');
  const hijo = retenerEnHijo(ruta, marca);
  await hijo.listo;
  await hijo.liberar(); // flushed before the synchronous acquire blocks this process
  assert.equal(conBloqueoSync(ruta, () => existsSync(marca)), true);
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

test('a lock older than 10 min is taken over even when its pid is alive (pid reuse)', () => conTemp(async (dir) => {
  const ruta = join(dir, 'g.json');
  writeFileSync(`${ruta}.lock`, JSON.stringify({ pid: process.pid, ts: Date.now() - 11 * 60_000 }));
  assert.equal(await conBloqueo(ruta, () => 'a'), 'a');
  writeFileSync(`${ruta}.lock`, JSON.stringify({ pid: process.pid, ts: Date.now() - 9 * 60_000 }));
  assert.throws(() => conBloqueoSync(ruta, () => 1, { esperaMs: 100 }), /Lock busy: g\.json/);
  writeFileSync(`${ruta}.lock`, JSON.stringify({ pid: process.pid, ts: Date.now() - 11 * 60_000 }));
  assert.equal(conBloqueoSync(ruta, () => 's'), 's');
  assert.deepEqual(readdirSync(dir), []);
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

test('processes contending for conBloqueoSync never share the critical section', () => conTemp(async (dir) => {
  const ruta = join(dir, 'k.json');
  const ir = join(dir, 'ir');
  const tareas = [contender('sync', ruta, ir, 30), contender('sync', ruta, ir, 30), contender('sync', ruta, ir, 30)];
  await dormir(300);
  writeFileSync(ir, '');
  const r = await Promise.all(tareas);
  assert.deepEqual(r.map((x) => x.colisiones), [0, 0, 0]);
  verSolape(r);
  assert.deepEqual(readdirSync(dir).sort(), ['ir']);
}));

test('processes contending for async conBloqueo never share the critical section', () => conTemp(async (dir) => {
  const ruta = join(dir, 'l.json');
  const ir = join(dir, 'ir');
  const tareas = [contender('async', ruta, ir, 30), contender('async', ruta, ir, 30), contender('async', ruta, ir, 30)];
  await dormir(300);
  writeFileSync(ir, '');
  const r = await Promise.all(tareas);
  assert.deepEqual(r.map((x) => x.colisiones), [0, 0, 0]);
  verSolape(r);
  assert.deepEqual(readdirSync(dir).sort(), ['ir']);
}));

test('two takers and a plain acquirer over a planted stale lock never collide', () => conTemp(async (dir) => {
  const ruta = join(dir, 'm.json');
  const ir = join(dir, 'ir');
  lockViejo(ruta, 999999);
  const tareas = [contender('sync', ruta, ir, 20), contender('async', ruta, ir, 20), contender('sync', ruta, ir, 20)];
  await dormir(300);
  writeFileSync(ir, '');
  const r = await Promise.all(tareas);
  assert.deepEqual(r.map((x) => x.colisiones), [0, 0, 0]);
  assert.ok(r.every((x) => x.ok));
  assert.deepEqual(readdirSync(dir).sort(), ['ir']);
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

test('acquiring a path this process already holds throws at once (nested, mixed)', () => conTemp(async (dir) => {
  const ruta = join(dir, 'n.json');
  const t0 = Date.now();
  await conBloqueo(ruta, async () => {
    await assert.rejects(conBloqueo(ruta, () => 1), /Lock already held by this process: n\.json/);
    assert.throws(() => conBloqueoSync(ruta, () => 1), /Lock already held by this process: n\.json/);
  });
  conBloqueoSync(ruta, () => {
    assert.throws(() => conBloqueoSync(ruta, () => 1), /Lock already held by this process/);
  });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(existsSync(`${ruta}.lock`), false);
  assert.equal(conBloqueoSync(ruta, () => 'libre'), 'libre');
}));

test('escribirJson keeps its format and stays synchronous', () => conTemp(async (dir) => {
  const ruta = join(dir, 'sub', 'k.json');
  const r = escribirJson(ruta, { a: 1 });
  assert.equal(r, undefined);
  assert.equal(readFileSync(ruta, 'utf8'), '{\n  "a": 1\n}\n');
}));

const envejecer = (archivo) => {
  const antes = new Date(Date.now() - 60_000);
  utimesSync(archivo, antes, antes);
};

test('a stale guard file does not block the take-over of a stale lock', () => conTemp(async (dir) => {
  const ruta = join(dir, 'o.json');
  lockViejo(ruta, 999999);
  writeFileSync(`${ruta}.lock.takeover`, '');
  envejecer(`${ruta}.lock.takeover`);
  assert.equal(await conBloqueo(ruta, () => 'a'), 'a');
  lockViejo(ruta, 999999);
  writeFileSync(`${ruta}.lock.takeover`, '');
  envejecer(`${ruta}.lock.takeover`);
  assert.equal(conBloqueoSync(ruta, () => 's'), 's');
  assert.deepEqual(readdirSync(dir), []);
}));

test('a fresh guard file is left alone and the lock is reported busy', () => conTemp(async (dir) => {
  const ruta = join(dir, 'p.json');
  lockViejo(ruta, 999999);
  writeFileSync(`${ruta}.lock.takeover`, '');
  await assert.rejects(conBloqueo(ruta, () => 1, { esperaMs: 150 }), /Lock busy: p\.json/);
  assert.equal(existsSync(`${ruta}.lock.takeover`), true);
  assert.equal(existsSync(`${ruta}.lock`), true);
}));

test('an empty lock with an old mtime is stale; a fresh empty lock is never removed', () => conTemp(async (dir) => {
  const ruta = join(dir, 'q.json');
  writeFileSync(`${ruta}.lock`, '');
  retirarObsoleto(`${ruta}.lock`, ''); // judged stale earlier as '', but this lock is new
  assert.equal(existsSync(`${ruta}.lock`), true);
  assert.equal(existsSync(`${ruta}.lock.takeover`), false);
  await assert.rejects(conBloqueo(ruta, () => 1, { esperaMs: 150 }), /Lock busy: q\.json/);
  envejecer(`${ruta}.lock`);
  assert.equal(conBloqueoSync(ruta, () => 'ok'), 'ok');
  assert.deepEqual(readdirSync(dir), []);
}));
