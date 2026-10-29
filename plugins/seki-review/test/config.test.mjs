import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proyecto } from '../mcp/lib/config.mjs';
import { reglasDeConfig } from '../mcp/lib/reglas.mjs';
import { verificar } from '../mcp/lib/verificar.mjs';
import { sistemaDe } from '../mcp/lib/ia.mjs';

const previo = { config: process.env.SEKI_REVIEW_CONFIG, proyecto: process.env.SEKI_PROYECTO };
afterEach(() => {
  for (const [k, v] of [['SEKI_REVIEW_CONFIG', previo.config], ['SEKI_PROYECTO', previo.proyecto]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

function config(obj) {
  const ruta = join(mkdtempSync(join(tmpdir(), 'seki-cfg-')), 'proyectos.json');
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
