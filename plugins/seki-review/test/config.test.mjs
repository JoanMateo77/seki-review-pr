import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
