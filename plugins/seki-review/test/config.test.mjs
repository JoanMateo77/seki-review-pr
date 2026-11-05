import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proyecto, QA_DEFECTO } from '../mcp/lib/config.mjs';
import { reglasDeConfig } from '../mcp/lib/reglas.mjs';
import { verificar } from '../mcp/lib/verificar.mjs';
import { sistemaDe } from '../mcp/lib/ia.mjs';

const previo = { config: process.env.SEKI_REVIEW_CONFIG, proyecto: process.env.SEKI_PROYECTO };
const temporales = [];
afterEach(() => {
  for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of [['SEKI_REVIEW_CONFIG', previo.config], ['SEKI_PROYECTO', previo.proyecto]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

function config(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'seki-cfg-'));
  temporales.push(dir);
  const ruta = join(dir, 'proyectos.json');
  writeFileSync(ruta, JSON.stringify(obj));
  process.env.SEKI_REVIEW_CONFIG = ruta;
}

test('without a key uses SEKI_PROYECTO or the first project, and copies live outside the project', () => {
  config({ uno: { salida: '/s/uno', repos: {} }, dos: { salida: '/s/dos', repos: {} } });
  delete process.env.SEKI_PROYECTO;
  assert.equal(proyecto().clave, 'uno');
  assert.match(proyecto().copias, /\.cache\/seki-review\/copias\/uno$/);
  process.env.SEKI_PROYECTO = 'dos';
  assert.equal(proyecto().clave, 'dos');
  assert.throws(() => proyecto('tres'), /Project "tres" is not in/);
});

test('a project-specific rule applies with soloEnTexto, exclusions and repos', () => {
  const extra = reglasDeConfig([
    { id: 'palabra', titulo: 'Banned word', severidad: 'alto', archivos: '\\.(ts|ejs)$', patron: '\\bcliente\\b', flags: 'i', excluir: '^\\s*//', soloEnTexto: true, mensaje: 'Say user.' },
    { id: 'solo-web', titulo: 'Web only', severidad: 'raro', archivos: '\\.js$', patron: 'x', repos: ['web'], mensaje: 'm' },
  ]);
  assert.equal(extra[1].severidad, 'aviso');
  const archivos = [{ filename: 'a.ts', status: 'modified', patch: '@@ -1,0 +1,4 @@\n+const cliente = 1;\n+msg("Hola Cliente");\n+// cliente en comentario\n+x' }, { filename: 'v.ejs', status: 'added', patch: '@@ -0,0 +1 @@\n+<p>cliente</p>' }];
  const r = verificar({ repo: 'api', archivos, extra });
  const propios = r.hallazgos.filter((h) => h.regla === 'palabra' || h.titulo === 'Banned word');
  assert.deepEqual(propios.map((h) => `${h.archivo}:${h.linea}`), ['a.ts:2', 'v.ejs:1']);
  assert.ok(!r.hallazgos.some((h) => h.titulo === 'Web only'));
});

test('the system prompt includes the project context only if it exists', () => {
  assert.match(sistemaDe({ contexto: 'Decir "usuario".' }, 'base'), /# Project context\n\nDecir "usuario"\./);
  assert.doesNotMatch(sistemaDe({}, 'base'), /Project context/);
});

test('config values of the wrong type fall back to their defaults with one warning per key', () => {
  config({ x: { salida: '/tmp/x', repos: {}, entregas: { sufijosRama: '-qa', patronId: 7, ventanaDias: 'many', alertaDias: -1, cerrarTrasDias: Infinity, maxPorSenal: 4 }, vigia: { intervaloSeg: '60' } } });
  const original = console.error;
  const avisos = [];
  console.error = (m) => avisos.push(m);
  let p;
  try {
    p = proyecto('x');
    proyecto('x');
  } finally {
    console.error = original;
  }
  assert.deepEqual(p.entregas.sufijosRama, ['-pruebas', '-testing', '-staging']);
  assert.equal(p.entregas.patronId, null);
  assert.deepEqual([p.entregas.ventanaDias, p.entregas.alertaDias, p.entregas.cerrarTrasDias, p.entregas.maxPorSenal], [30, 5, 7, 4]);
  assert.equal(p.vigia.intervaloSeg, 300);
  assert.equal(avisos.length, 6);
  assert.ok(avisos.every((m) => m.startsWith('[seki-review/config] ')));
  assert.ok(avisos.some((m) => m.includes('entregas.sufijosRama')));
  assert.ok(avisos.some((m) => m.includes('vigia.intervaloSeg')));
});

test('valid config values are kept and the interval is clamped to the minimum', () => {
  config({ y: { salida: '/tmp/y', repos: {}, entregas: { sufijosRama: ['-qa'], patronId: 'T-\\d+' }, vigia: { intervaloSeg: 30 } } });
  const p = proyecto('y');
  assert.deepEqual(p.entregas.sufijosRama, ['-qa']);
  assert.equal(p.entregas.patronId, 'T-\\d+');
  assert.equal(p.vigia.intervaloSeg, 120);
});

test('qa defaults are applied and the tracker defaults are completed', () => {
  config({ q: { salida: '/s/q', repos: {} }, r: { salida: '/s/r', repos: {}, qa: { rastreador: { tipo: 'xlsx', ruta: '~/t.xlsx', hoja: 'S', columnaId: 'ID', lectura: { pasos: 'Steps' } } } } });
  assert.deepEqual(proyecto('q').qa, QA_DEFECTO);
  const r = proyecto('r').qa.rastreador;
  assert.equal(r.filaEncabezado, 1);
  assert.equal(r.escribir, true);
  assert.deepEqual(r.estados, {});
  assert.equal(r.lectura.pasos, 'Steps');
  assert.equal(r.lectura.hallazgo, null);
  assert.equal(r.columnas.estado, null);
});

test('qa columnas without Result fall back with one warning; invalid rastreador.tipo gives null', () => {
  config({ w: { salida: '/s/w', repos: {}, qa: { columnas: ['ID', 'Portal'], chrome: 5, rastreador: { tipo: 'csv', ruta: 'x', hoja: 'S', columnaId: 'ID' } } } });
  const previo = console.error;
  const avisos = [];
  console.error = (m) => avisos.push(String(m));
  try {
    const qa = proyecto('w').qa;
    proyecto('w');
    assert.deepEqual(qa.columnas, QA_DEFECTO.columnas);
    assert.equal(qa.chrome, null);
    assert.equal(qa.rastreador, null);
  } finally {
    console.error = previo;
  }
  assert.equal(avisos.filter((m) => m.includes('qa.columnas')).length, 1);
  assert.equal(avisos.filter((m) => m.includes('qa.rastreador')).length, 1);
});

test('qa defaults are copies; mapeo values, duplicate columns and tracker path are validated', () => {
  config({ a: { salida: '/s/a', repos: {} }, b: { salida: '/s/b', repos: {}, qa: { mapeo: { OK: 'bogus' }, columnas: ['ID', 'Portal', 'Result', 'ID'], rastreador: { tipo: 'xlsx', ruta: '~/t.xlsx', hoja: 'S', columnaId: 'ID' } } } });
  const previo = console.error;
  console.error = () => {};
  try {
    proyecto('a').qa.columnas.push('Mutated');
    proyecto('a').qa.mapeo.X = 'ok';
    assert.deepEqual(proyecto('a').qa, QA_DEFECTO);
    assert.equal(QA_DEFECTO.columnas.includes('Mutated'), false);
    const qa = proyecto('b').qa;
    assert.deepEqual(qa.mapeo, QA_DEFECTO.mapeo);
    assert.deepEqual(qa.columnas, QA_DEFECTO.columnas);
    assert.ok(qa.rastreador.ruta.startsWith('/'));
    assert.ok(!qa.rastreador.ruta.startsWith('~'));
  } finally {
    console.error = previo;
  }
});

function conAvisos(clave) {
  const previo = console.error;
  const avisos = [];
  console.error = (m) => avisos.push(String(m));
  try {
    const p = proyecto(clave);
    proyecto(clave);
    return { qa: p.qa, avisos: avisos.filter((m) => m.includes('qa.resultados')) };
  } finally {
    console.error = previo;
  }
}

test('qa resultados must agree with mapeo and the validation list limits, else both defaults with one warning', () => {
  const caso = (qa) => ({ salida: '/s/r', repos: {}, qa });
  config({
    traducido: caso({ resultados: ['Si', 'No'] }),
    coherente: caso({ resultados: ['Si', 'NO', 'Pend'], mapeo: { si: 'ok', no: 'fallo', Pend: null } }),
    coma: caso({ resultados: ['OK, bien', 'Fail'], mapeo: { 'OK, bien': 'ok', Fail: 'fallo' } }),
    comilla: caso({ resultados: ['"OK"', 'Fail'], mapeo: { '"OK"': 'ok', Fail: 'fallo' } }),
    larga: caso({ resultados: Array.from({ length: 30 }, (_, i) => `Result number ${i}`), mapeo: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`Result number ${i}`, 'ok'])) }),
  });
  const ok = conAvisos('coherente');
  assert.deepEqual(ok.qa.resultados, ['Si', 'NO', 'Pend']);
  assert.equal(ok.avisos.length, 0);
  for (const clave of ['traducido', 'coma', 'comilla', 'larga']) {
    const { qa, avisos } = conAvisos(clave);
    assert.deepEqual(qa.resultados, QA_DEFECTO.resultados, clave);
    assert.deepEqual(qa.mapeo, QA_DEFECTO.mapeo, clave);
    assert.equal(avisos.length, 1, clave);
  }
});

test('a relative tracker path is ignored with a warning', () => {
  config({ rel: { salida: '/s/rel', repos: {}, qa: { rastreador: { tipo: 'xlsx', ruta: 'tracker.xlsx', hoja: 'S', columnaId: 'ID' } } } });
  const previo = console.error;
  const avisos = [];
  console.error = (m) => avisos.push(String(m));
  try {
    assert.equal(proyecto('rel').qa.rastreador, null);
  } finally {
    console.error = previo;
  }
  assert.equal(avisos.filter((m) => m.includes('absolute')).length, 1);
});

test('the example project that reads the finding column also lists Finding in the guide columns', () => {
  const ejemplo = JSON.parse(readFileSync(new URL('../config/proyectos.ejemplo.json', import.meta.url), 'utf8'));
  const qa = ejemplo['demo-tracker'].qa;
  assert.ok(qa.rastreador.lectura.hallazgo);
  assert.ok(qa.columnas.includes('Finding'));
  assert.ok(['ID', 'Portal', 'Result'].every((c) => qa.columnas.includes(c)));
});

test('ia section: defaults, valid values and fallbacks', () => {
  config({ a: { salida: '/s/a', repos: {} }, b: { salida: '/s/b', repos: {}, ia: { modo: 'ahorro', presupuestoDiarioUsd: 12.5, rutasSensibles: ['auth', '(^|/)pagos/'] } }, c: { salida: '/s/c', repos: {}, ia: { modo: 'turbo', presupuestoDiarioUsd: -3, rutasSensibles: 'x' } } });
  const a = proyecto('a').ia;
  assert.equal(a.modo, 'normal');
  assert.equal(a.presupuestoDiarioUsd, null);
  assert.deepEqual(a.rutasSensibles, []);
  assert.deepEqual(a.patronesSensibles, []);
  const b = proyecto('b').ia;
  assert.equal(b.modo, 'ahorro');
  assert.equal(b.presupuestoDiarioUsd, 12.5);
  assert.ok(b.patronesSensibles.every((r) => r instanceof RegExp));
  assert.ok(b.patronesSensibles[1].test('src/pagos/x.ts'));
  const c = proyecto('c').ia;
  assert.equal(c.modo, 'normal');
  assert.equal(c.presupuestoDiarioUsd, null);
  assert.deepEqual(c.rutasSensibles, []);
});

test('ia.rutasSensibles drops invalid and oversized patterns', () => {
  config({ a: { salida: '/s/a', repos: {}, ia: { rutasSensibles: ['ok', '(sin cerrar', 'x'.repeat(201)] } } });
  const ia = proyecto('a').ia;
  assert.deepEqual(ia.rutasSensibles, ['ok']);
  assert.equal(ia.patronesSensibles.length, 1);
});
