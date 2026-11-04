import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QA_DEFECTO } from '../mcp/lib/config.mjs';
import { aplicarRastreador, cambiosPendientes, contenidoRastreador, leerRastreador } from '../mcp/lib/rastreador-xlsx.mjs';
import { leerZip } from '../mcp/lib/zip.mjs';
import { leerXlsx } from '../mcp/lib/xlsx.mjs';
import { trackerFixture } from './util/xlsx-fixture.mjs';

const temporales = [];
after(() => { for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'seki-rast-'));
  temporales.push(d);
  return d;
};

const cfgBase = (ruta) => ({
  tipo: 'xlsx', ruta, hoja: 'Sheet1', filaEncabezado: 1, columnaId: ' id ',
  lectura: { hallazgo: 'FINDING', pasos: 'How to reproduce', esperado: 'expected', pantalla: null, prioridad: null },
  columnas: { estado: 'State', prPruebas: 'Testing PR', prProd: 'Production PR', enPruebas: 'In testing', enProd: 'In production' },
  estados: { esperando_qa: 'In progress', en_produccion: 'Closed' },
  escribir: true,
});
const pr = (id, ambiente, url, mergeada) => ({ id, ambiente, url, mergeada });
const prs = new Map([
  ['r#1', pr('r#1', 'pruebas', 'https://example.test/pr/1', '2026-03-01T10:00:00Z')],
  ['r#2', pr('r#2', 'prod', 'https://example.test/pr/2', '2026-03-05T10:00:00Z')],
  ['r#3', pr('r#3', 'pruebas', 'https://example.test/pr/3', '2026-03-02T10:00:00Z')],
]);
const entregas = [
  { clave: 'a', ids: ['X-001'], etapa: 'esperando_qa', prs: ['r#1'] },
  { clave: 'b', ids: ['X-003', 'Z-999'], etapa: 'por_mergear_pruebas', prs: ['r#3'] },
];

function escenario(variante) {
  const dir = tmp();
  const ruta = join(dir, 'tracker.xlsx');
  writeFileSync(ruta, trackerFixture({ variante }));
  const p = { clave: 't', salida: join(dir, 'salida'), qa: { ...structuredClone(QA_DEFECTO), rastreador: cfgBase(ruta) } };
  return { dir, ruta, p, cfg: p.qa.rastreador };
}

for (const variante of ['inline', 'compartidas']) {
  test(`reads rows by header text, case-insensitive (${variante})`, () => {
    const { cfg } = escenario(variante);
    const { filasPorId, encabezados } = leerRastreador(cfg);
    assert.equal(encabezados.get('state'), 4);
    assert.deepEqual([...filasPorId.keys()], ['X-001', 'X-002', 'X-003']);
    assert.equal(filasPorId.get('X-002').fila, 3);
    assert.equal(filasPorId.get('X-002').valores.hallazgo, 'Generic finding two & more');
    const c = contenidoRastreador(cfg);
    assert.equal(c.get('X-001').pasos, 'Open the page\nClick the button');
    assert.equal(c.get('X-001').pantalla, '');
  });

  test(`writes only differing cells, backs up and keeps the rest identical (${variante})`, async () => {
    const { ruta, p, cfg } = escenario(variante);
    const antes = readFileSync(ruta);
    const cambios = cambiosPendientes(cfg, entregas, prs);
    assert.deepEqual(cambios.map((c) => `${c.id}:${c.columna}`), ['X-001:estado', 'X-001:prPruebas', 'X-001:enPruebas', 'X-003:prPruebas', 'X-003:enPruebas']);
    // X-003 state: stage without text is skipped; X-003 already has the same testing URL? it has pr/2, so it differs.
    const r = await aplicarRastreador(p, entregas, prs, { ahora: new Date(2026, 10, 4, 9, 8, 7) });
    assert.equal(r.escrito, true);
    assert.equal(r.celdas, 5);
    assert.match(r.respaldo, /respaldos[\\/]tracker-20261104-090807\.xlsx$/);
    assert.ok(readFileSync(r.respaldo).equals(antes));
    const hoja = leerXlsx(readFileSync(ruta)).hojas[0].filas;
    assert.equal(hoja[1][4], 'In progress');
    assert.equal(hoja[1][5], 'https://example.test/pr/1');
    assert.equal(hoja[1][7], '2026-03-01');
    assert.equal(hoja[3][4], 'Closed');
    assert.equal(hoja[3][5], 'https://example.test/pr/3');
    assert.equal(hoja[2][4], 'In progress');
    const a = leerZip(antes);
    const d = leerZip(readFileSync(ruta));
    for (const [nombre, datos] of a) if (nombre !== 'xl/worksheets/sheet1.xml') assert.ok(d.get(nombre).equals(datos), nombre);
    assert.match(d.get('xl/worksheets/sheet1.xml').toString(), /<dataValidations count="2">/);
    assert.deepEqual(cambiosPendientes(cfg, entregas, prs), []);
    const otra = await aplicarRastreador(p, entregas, prs);
    assert.deepEqual(otra, { escrito: false, celdas: 0, motivo: 'Nothing to update' });
    assert.equal(readdirSync(join(p.salida, 'respaldos')).length, 1);
  });
}

test('a missing configured header fails with RASTREADOR_COLUMNA naming the text', () => {
  const { cfg } = escenario('inline');
  cfg.columnas.estado = 'Nope';
  assert.throws(() => leerRastreador(cfg), (e) => e.codigo === 'RASTREADOR_COLUMNA' && /Nope/.test(e.message));
});

test('most advanced delivery wins per ID and ties go to the latest merge', () => {
  const { cfg } = escenario('inline');
  const otras = [
    { clave: 'a', ids: ['X-001'], etapa: 'esperando_qa', prs: ['r#1'] },
    { clave: 'c', ids: ['X-001'], etapa: 'en_produccion', prs: ['r#2'] },
    { clave: 'd', ids: ['X-002'], etapa: 'esperando_qa', prs: ['r#1'] },
    { clave: 'e', ids: ['X-002'], etapa: 'esperando_qa', prs: ['r#3'] },
  ];
  const c = cambiosPendientes(cfg, otras, prs);
  assert.equal(c.find((x) => x.id === 'X-001' && x.columna === 'estado').nuevo, 'Closed');
  assert.equal(c.find((x) => x.id === 'X-002' && x.columna === 'prPruebas').nuevo, 'https://example.test/pr/3');
  assert.ok(!c.some((x) => x.id === 'Z-999'));
});

test('an Office lock file refuses the write without a backup', async () => {
  const { dir, ruta, p } = escenario('inline');
  writeFileSync(join(dir, '~$tracker.xlsx'), '');
  const antes = readFileSync(ruta);
  const r = await aplicarRastreador(p, entregas, prs);
  assert.equal(r.escrito, false);
  assert.match(r.motivo, /open in another program/);
  assert.ok(readFileSync(ruta).equals(antes));
  assert.equal(existsSync(join(p.salida, 'respaldos')), false);
});

test('a symlink is refused', async () => {
  const { dir, ruta, p } = escenario('inline');
  const enlace = join(dir, 'enlace.xlsx');
  symlinkSync(ruta, enlace);
  p.qa.rastreador.ruta = enlace;
  const r = await aplicarRastreador(p, entregas, prs);
  assert.equal(r.escrito, false);
  assert.match(r.motivo, /symbolic link/);
});

test('escribir false and a non-file path are refused', async () => {
  const { dir, p } = escenario('inline');
  p.qa.rastreador.escribir = false;
  assert.match((await aplicarRastreador(p, entregas, prs)).motivo, /disabled/);
  p.qa.rastreador.escribir = true;
  p.qa.rastreador.ruta = dir;
  assert.match((await aplicarRastreador(p, entregas, prs)).motivo, /not a regular file/);
});

test('a formula in a target cell is refused, not thrown', async () => {
  const { dir, ruta, p } = escenario('inline');
  const { reemplazarEntradas } = await import('../mcp/lib/zip.mjs');
  const z = leerZip(readFileSync(ruta));
  const xml = z.get('xl/worksheets/sheet1.xml').toString().replace(/<c r="E2" s="0"\/>|<c r="E2"[^>]*>[\s\S]*?<\/c>/, '<c r="E2" s="0"><f>1+1</f><v>2</v></c>');
  writeFileSync(ruta, reemplazarEntradas(readFileSync(ruta), new Map([['xl/worksheets/sheet1.xml', xml]])));
  const antes = readFileSync(ruta);
  const r = await aplicarRastreador(p, entregas, prs);
  assert.equal(r.escrito, false);
  assert.match(r.motivo, /formula/);
  assert.ok(readFileSync(ruta).equals(antes));
  assert.equal(existsSync(join(p.salida, 'respaldos')), false);
  assert.ok(dir);
});

test('the original file mode is kept', async () => {
  const { ruta, p } = escenario('inline');
  chmodSync(ruta, 0o640);
  const r = await aplicarRastreador(p, entregas, prs);
  assert.equal(r.escrito, true);
  assert.equal(statSync(ruta).mode & 0o777, 0o640);
});
