import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QA_DEFECTO } from '../mcp/lib/config.mjs';
import { aplicarRastreador, cambiosPendientes, contenidoRastreador, leerRastreador } from '../mcp/lib/rastreador-xlsx.mjs';
import { leerZip, reemplazarEntradas } from '../mcp/lib/zip.mjs';
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

test('per ID: discarded ignored, finished ignored while another is active, then least advanced and latest merge', () => {
  const { cfg } = escenario('inline');
  const otras = [
    { clave: 'a', ids: ['X-001'], etapa: 'esperando_qa', prs: ['r#1'] },
    { clave: 'c', ids: ['X-001'], etapa: 'en_produccion', prs: ['r#2'] },
    { clave: 'd', ids: ['X-002'], etapa: 'esperando_qa', prs: ['r#1'] },
    { clave: 'e', ids: ['X-002'], etapa: 'esperando_qa', prs: ['r#3'] },
    { clave: 'f', ids: ['X-002'], etapa: 'descartada', prs: ['r#2'] },
    { clave: 'g', ids: ['X-003'], etapa: 'cerrada', prs: ['r#2'] },
    { clave: 'h', ids: ['X-003'], etapa: 'en_produccion', prs: ['r#2'] },
  ];
  const c = cambiosPendientes(cfg, otras, prs);
  assert.equal(c.find((x) => x.id === 'X-001' && x.columna === 'estado').nuevo, 'In progress');
  assert.equal(c.find((x) => x.id === 'X-002' && x.columna === 'prPruebas').nuevo, 'https://example.test/pr/3');
  assert.ok(!c.some((x) => x.id === 'X-002' && x.columna === 'prProd'));
  assert.ok(c.some((x) => x.id === 'X-003' && x.columna === 'prProd'));
  assert.ok(!c.some((x) => x.id === 'Z-999'));
  const soloTerminadas = cambiosPendientes(cfg, [otras[1], { clave: 'z', ids: ['X-001'], etapa: 'descartada', prs: ['r#1'] }], prs);
  assert.equal(soloTerminadas.find((x) => x.id === 'X-001' && x.columna === 'estado').nuevo, 'Closed');
});

test('a LibreOffice lock file refuses the write without a backup', async () => {
  const { dir, ruta, p } = escenario('inline');
  writeFileSync(join(dir, '.~lock.tracker.xlsx#'), '');
  const antes = readFileSync(ruta);
  const r = await aplicarRastreador(p, entregas, prs);
  assert.equal(r.escrito, false);
  assert.match(r.motivo, /open in another program: close it and use Update spreadsheet/);
  assert.ok(readFileSync(ruta).equals(antes));
  assert.equal(existsSync(join(p.salida, 'respaldos')), false);
});

for (const descriptores of [true, 'sin-firma']) {
  test(`a tracker saved with data descriptors is read and written (${descriptores})`, async () => {
    const { ruta, p, cfg } = escenario('inline');
    writeFileSync(ruta, trackerFixture({ descriptores }));
    assert.equal(contenidoRastreador(cfg).get('X-001').pasos, 'Open the page\nClick the button');
    const r = await aplicarRastreador(p, entregas, prs);
    assert.equal(r.escrito, true);
    assert.equal(leerXlsx(readFileSync(ruta)).hojas[0].filas[1][4], 'In progress');
  });
}

test('backups are written readable only by the owner', async () => {
  const { p } = escenario('inline');
  const r = await aplicarRastreador(p, entregas, prs);
  assert.equal(statSync(r.respaldo).mode & 0o777, 0o600);
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
  const { ruta, p } = escenario('inline');
  const z = leerZip(readFileSync(ruta));
  const xml = z.get('xl/worksheets/sheet1.xml').toString().replace(/<c r="E2" s="0"\/>|<c r="E2"[^>]*>[\s\S]*?<\/c>/, '<c r="E2" s="0"><f>1+1</f><v>2</v></c>');
  writeFileSync(ruta, reemplazarEntradas(readFileSync(ruta), new Map([['xl/worksheets/sheet1.xml', xml]])));
  const antes = readFileSync(ruta);
  const r = await aplicarRastreador(p, entregas, prs);
  assert.equal(r.escrito, false);
  assert.match(r.motivo, /formula/);
  assert.ok(readFileSync(ruta).equals(antes));
  assert.equal(existsSync(join(p.salida, 'respaldos')), false);
});

test('the original file mode is kept', async () => {
  const { ruta, p } = escenario('inline');
  chmodSync(ruta, 0o640);
  const r = await aplicarRastreador(p, entregas, prs);
  assert.equal(r.escrito, true);
  assert.equal(statSync(ruta).mode & 0o777, 0o640);
});

const HOJA = 'xl/worksheets/sheet1.xml';
const salidaAparte = (p) => { p.salida = join(tmp(), 's'); };
const listado = (dir) => readdirSync(dir).sort();
const sinRespaldos = (p) => assert.equal(existsSync(join(p.salida, 'respaldos')), false);

test('a change between read and rename leaves no backup and no temporary file', async () => {
  const { dir, ruta, p } = escenario('inline');
  const antes = readFileSync(ruta);
  const st = statSync(ruta);
  const r = await aplicarRastreador(p, entregas, prs, { gancho: () => utimesSync(ruta, new Date(), new Date(st.mtimeMs + 5000)) });
  assert.equal(r.escrito, false);
  assert.match(r.motivo, /changed while/);
  assert.deepEqual(listado(dir), ['salida', 'tracker.xlsx']);
  assert.ok(readFileSync(ruta).equals(antes));
  sinRespaldos(p);
});

test('same-size same-mtime content change is detected by the hash', async () => {
  const { dir, ruta, p } = escenario('inline');
  const st = statSync(ruta);
  const alterado = Buffer.from(readFileSync(ruta));
  alterado[alterado.length - 30] ^= 0x01;
  const r = await aplicarRastreador(p, entregas, prs, { gancho: () => { writeFileSync(ruta, alterado); utimesSync(ruta, st.atime, st.mtime); } });
  assert.equal(r.escrito, false);
  assert.match(r.motivo, /changed while/);
  assert.deepEqual(listado(dir), ['salida', 'tracker.xlsx']);
  sinRespaldos(p);
});

test('a failing temporary write is reported without backup or leftovers', { skip: process.getuid?.() === 0 }, async (t) => {
  const { dir, p } = escenario('inline');
  salidaAparte(p);
  const espia = t.mock.method(console, 'error', () => {});
  chmodSync(dir, 0o500);
  try {
    const r = await aplicarRastreador(p, entregas, prs);
    assert.equal(r.escrito, false);
    assert.match(r.motivo, /could not be updated/);
    assert.match(String(espia.mock.calls.at(-1).arguments[0]), /\(EACCES\)/);
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.deepEqual(listado(dir), ['tracker.xlsx']);
  sinRespaldos(p);
});

test('a lock file appearing mid-write refuses and cleans up', async () => {
  const { dir, p } = escenario('inline');
  const r = await aplicarRastreador(p, entregas, prs, { gancho: () => writeFileSync(join(dir, '~$tracker.xlsx'), '') });
  assert.equal(r.escrito, false);
  assert.match(r.motivo, /open in another program/);
  assert.deepEqual(listado(dir), ['salida', 'tracker.xlsx', '~$tracker.xlsx']);
  sinRespaldos(p);
});

test('a path swapped for a symlink after the first check is refused', async () => {
  const { dir, ruta, p } = escenario('inline');
  const copia = join(dir, 'copia.xlsx');
  writeFileSync(copia, readFileSync(ruta));
  const r = await aplicarRastreador(p, entregas, prs, { gancho: () => { unlinkSync(ruta); symlinkSync(copia, ruta); } });
  assert.equal(r.escrito, false);
  assert.match(r.motivo, /symbolic link/);
  assert.ok(!listado(dir).some((f) => f.endsWith('.tmp')));
  sinRespaldos(p);
});

test('a missing configured header through aplicarRastreador is a refusal without backup', async () => {
  const { p } = escenario('inline');
  p.qa.rastreador.columnas.estado = 'Nope';
  const r = await aplicarRastreador(p, entregas, prs);
  assert.equal(r.escrito, false);
  assert.match(r.motivo, /Nope/);
  sinRespaldos(p);
});

test('a target cell inside a table header is refused', async () => {
  const { dir, ruta, p } = escenario('inline');
  const base = reemplazarEntradas(readFileSync(ruta), new Map([[HOJA, leerZip(readFileSync(ruta)).get(HOJA).toString().replace('</worksheet>', '<tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>')]]));
  const conTabla = reemplazarEntradas(base, new Map([
    ['xl/worksheets/_rels/sheet1.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>'],
    ['xl/tables/table1.xml', '<?xml version="1.0"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="T1" displayName="T1" ref="A2:I4"><tableColumns count="1"><tableColumn id="1" name="ID"/></tableColumns></table>'],
  ]));
  writeFileSync(ruta, conTabla);
  const r = await aplicarRastreador(p, entregas, prs);
  assert.equal(r.escrito, false);
  assert.match(r.motivo, /table/);
  assert.deepEqual(listado(dir), ['salida', 'tracker.xlsx']);
  sinRespaldos(p);
});

test('two concurrent calls serialize: one writes, the other finds nothing to update', async () => {
  const { p } = escenario('inline');
  const [a, b] = await Promise.all([aplicarRastreador(p, entregas, prs), aplicarRastreador(p, entregas, prs)]);
  assert.deepEqual([a.escrito, b.escrito].sort(), [false, true]);
  assert.equal([a, b].find((x) => !x.escrito).motivo, 'Nothing to update');
  assert.equal(readdirSync(join(p.salida, 'respaldos')).length, 1);
});

test('every row of a duplicated ID is updated', async () => {
  const dir = tmp();
  const ruta = join(dir, 'tracker.xlsx');
  const fila = (id) => [id, 'F', 'S', 'E', '', '', '', '', ''];
  writeFileSync(ruta, trackerFixture({ filas: [fila('X-001'), fila('X-002'), fila('X-001')] }));
  const p = { clave: 't', salida: join(dir, 'salida'), qa: { ...structuredClone(QA_DEFECTO), rastreador: cfgBase(ruta) } };
  const r = await aplicarRastreador(p, entregas, prs);
  assert.equal(r.escrito, true);
  const filas = leerXlsx(readFileSync(ruta)).hojas[0].filas;
  assert.equal(filas[1][4], 'In progress');
  assert.equal(filas[3][4], 'In progress');
  assert.equal(filas[2][4], '');
});

test('only the newest 20 backups of the tracker are kept', async () => {
  const { p } = escenario('inline');
  const dirR = join(p.salida, 'respaldos');
  mkdirSync(dirR, { recursive: true });
  for (let i = 0; i < 22; i++) {
    const f = join(dirR, `tracker-20260101-0000${String(i).padStart(2, '0')}.xlsx`);
    writeFileSync(f, 'x');
    utimesSync(f, new Date(2026, 0, 1, 0, 0, i), new Date(2026, 0, 1, 0, 0, i));
  }
  writeFileSync(join(dirR, 'otro-20260101-000000.xlsx'), 'x');
  const r = await aplicarRastreador(p, entregas, prs, { ahora: new Date(2026, 10, 4, 9, 0, 0) });
  assert.equal(r.escrito, true);
  const lista = readdirSync(dirR).filter((f) => f.startsWith('tracker-'));
  assert.equal(lista.length, 20);
  assert.ok(!lista.includes('tracker-20260101-000000.xlsx'));
  assert.ok(lista.includes('tracker-20261104-090000.xlsx'));
  assert.ok(readdirSync(dirR).includes('otro-20260101-000000.xlsx'));
});

test('a date cell holding the same Excel serial is not rewritten', () => {
  const { ruta, cfg } = escenario('inline');
  const xml = leerZip(readFileSync(ruta)).get(HOJA).toString().replace(/<c r="H2"[^>]*\/>/, '<c r="H2" s="0"><v>46082</v></c>');
  writeFileSync(ruta, reemplazarEntradas(readFileSync(ruta), new Map([[HOJA, xml]])));
  assert.equal(leerXlsx(readFileSync(ruta)).hojas[0].filas[1][7], '46082');
  const c = cambiosPendientes(cfg, entregas, prs);
  assert.ok(!c.some((x) => x.id === 'X-001' && x.columna === 'enPruebas'));
});

test('a tracker owned by another user is refused', async () => {
  const { dir, ruta, p } = escenario('inline');
  const antes = readFileSync(ruta);
  const r = await aplicarRastreador(p, entregas, prs, { uidProceso: statSync(ruta).uid + 1 });
  assert.equal(r.escrito, false);
  assert.equal(r.motivo, 'The spreadsheet belongs to another user');
  assert.ok(readFileSync(ruta).equals(antes));
  assert.deepEqual(readdirSync(dir).sort(), ['tracker.xlsx']);
  sinRespaldos(p);
});
