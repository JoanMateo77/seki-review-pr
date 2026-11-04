import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leerZip, reemplazarEntradas } from '../mcp/lib/zip.mjs';
import { leerXlsx } from '../mcp/lib/xlsx.mjs';
import { editarCeldas } from '../mcp/lib/xlsx-editar.mjs';
import { trackerFixture } from './util/xlsx-fixture.mjs';

const HOJA = 'xl/worksheets/sheet1.xml';
const xmlHoja = (buf) => leerZip(buf).get(HOJA).toString('utf8');
const conHoja = (buf, f) => reemplazarEntradas(buf, new Map([[HOJA, f(xmlHoja(buf))]]));

function normalizar(xml, refs) {
  let x = xml.replace(/<dimension [^>]*\/>/, '').replace(/ spans="[^"]*"/g, '');
  for (const r of refs) x = x.replace(new RegExp(`<c r="${r}"(?:[^>]*/>|[^>]*>[\\s\\S]*?</c>)`), '');
  return x.replace(/<row r="\d+"><\/row>/g, '');
}

for (const variante of ['inline', 'compartidas']) {
  test(`edits read back and the rest is untouched (${variante})`, () => {
    const buf = trackerFixture({ variante });
    const refs = ['B2', 'E3', 'F4'];
    const out = editarCeldas(buf, { hoja: 'Sheet1', celdas: [
      { ref: 'B2', valor: 'New <text> & "more"\nline' },
      { ref: 'E3', valor: 'Closed' },
      { ref: 'F4', valor: '' },
    ] });
    const hoja = leerXlsx(out).hojas[0];
    assert.equal(hoja.filas[1][1], 'New <text> & "more"\nline');
    assert.equal(hoja.filas[2][4], 'Closed');
    assert.equal(hoja.filas[3][5], '');
    assert.equal(hoja.filas[1][0], 'X-001');
    assert.equal(normalizar(xmlHoja(out), refs), normalizar(xmlHoja(buf), refs));
    const a = leerZip(buf);
    const b = leerZip(out);
    assert.deepEqual([...b.keys()], [...a.keys()]);
    for (const [k, v] of a) if (k !== HOJA) assert.ok(v.equals(b.get(k)), k);
    for (const tag of ['dataValidations', 'autoFilter']) {
      const re = new RegExp(`<${tag}[\\s\\S]*?(?:</${tag}>|/>)`);
      assert.equal(re.exec(xmlHoja(out))[0], re.exec(xmlHoja(buf))[0]);
    }
  });
}

test('style survives a shared-string cell turned inline; formula is dropped', () => {
  const buf = conHoja(trackerFixture({ variante: 'compartidas' }), (x) => x.replace('<c r="B3" s="0" t="s"><v>', '<c r="B3" s="1" t="s"><f>1+1</f><v>'));
  const out = editarCeldas(buf, { hoja: 'Sheet1', celdas: [{ ref: 'B3', valor: 'Z' }] });
  const x = xmlHoja(out);
  assert.match(x, /<c r="B3" s="1" t="inlineStr"><is><t xml:space="preserve">Z<\/t><\/is><\/c>/);
  assert.doesNotMatch(x, /<f>/);
  assert.ok(leerZip(out).get('xl/sharedStrings.xml').equals(leerZip(buf).get('xl/sharedStrings.xml')));
});

test('a new cell lands in column order and extends spans and dimension', () => {
  const sin = conHoja(trackerFixture(), (x) => x.replace(/<c r="D2"[^>]*\/>|<c r="D2".*?<\/c>/, ''));
  const out = editarCeldas(sin, { hoja: 'Sheet1', celdas: [{ ref: 'K2', valor: 'k' }, { ref: 'D2', valor: 'd' }] });
  const fila = /<row r="2"[^>]*>[\s\S]*?<\/row>/.exec(xmlHoja(out))[0];
  const cols = [...fila.matchAll(/<c r="([A-Z]+)2"/g)].map((m) => m[1]);
  assert.deepEqual(cols, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'K']);
  assert.match(fila, /<c r="D2" s="1" t="inlineStr">/);
  assert.match(fila, /spans="1:11"/);
  assert.match(xmlHoja(out), /<dimension ref="A1:K4"\/>/);
  const hoja = leerXlsx(out).hojas[0];
  assert.equal(hoja.filas[1][3], 'd');
  assert.equal(hoja.filas[1][10], 'k');
});

test('dimension and spans are left alone when the edit does not extend them', () => {
  const buf = trackerFixture();
  const x = xmlHoja(editarCeldas(buf, { hoja: 'Sheet1', celdas: [{ ref: 'A2', valor: 'q' }] }));
  assert.match(x, /<dimension ref="A1:I4"\/>/);
  assert.match(x, /<row r="2" spans="1:9">/);
});

test('new rows land in row order with the style of the cell above', () => {
  const sin = conHoja(trackerFixture(), (x) => x.replace(/<row r="3".*?<\/row>/, ''));
  const out = editarCeldas(sin, { hoja: 'Sheet1', celdas: [
    { ref: 'A7', valor: 'late' }, { ref: 'B3', valor: 'mid' }, { ref: 'A3', valor: 'mid-a' },
  ] });
  const x = xmlHoja(out);
  assert.deepEqual([...x.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1])), [1, 2, 3, 4, 7]);
  assert.match(x, /<row r="3"><c r="A3" s="0" t="inlineStr">.*?<c r="B3" s="0" t="inlineStr">/);
  assert.match(x, /<dimension ref="A1:I7"\/>/);
  const f = leerXlsx(out).hojas[0].filas;
  assert.equal(f[2][0], 'mid-a');
  assert.equal(f[6][0], 'late');
});

test('self-closed rows, empty sheetData and a missing sheet', () => {
  const auto = conHoja(trackerFixture(), (x) => x.replace('</sheetData>', '<row r="9" spans="2:3"/></sheetData>'));
  const x = xmlHoja(editarCeldas(auto, { hoja: 'Sheet1', celdas: [{ ref: 'A9', valor: 'v' }] }));
  assert.match(x, /<row r="9" spans="1:3"><c r="A9" s="0" t="inlineStr">/);
  const vacia = conHoja(trackerFixture(), (xx) => xx.replace(/<sheetData>[\s\S]*<\/sheetData>/, '<sheetData/>'));
  const y = xmlHoja(editarCeldas(vacia, { hoja: 'Sheet1', celdas: [{ ref: 'C2', valor: 'v' }, { ref: 'A1', valor: 'h' }] }));
  assert.match(y, /<sheetData><row r="1"><c r="A1" t="inlineStr">.*<\/row><row r="2"><c r="C2"/);
  assert.throws(() => editarCeldas(trackerFixture(), { hoja: 'Nope', celdas: [{ ref: 'A1', valor: 'x' }] }), { codigo: 'XLSX_HOJA' });
});

test('invalid input is rejected and duplicates keep the last value', () => {
  const buf = trackerFixture();
  const malo = (celdas) => assert.throws(() => editarCeldas(buf, { hoja: 'Sheet1', celdas }), { codigo: 'XLSX_ESTRUCTURA' });
  malo([{ ref: 'a1', valor: 'x' }]);
  malo([{ ref: 'B0', valor: 'x' }]);
  malo([{ ref: 'ZZZ1', valor: 'x' }]);
  malo([{ ref: 'A5001', valor: 'x' }]);
  malo([{ ref: 'A1', valor: 5 }]);
  malo('A1');
  assert.throws(() => editarCeldas(buf, { hoja: 'Sheet1', celdas: [{ ref: 'A1', valor: 'x'.repeat(40000) }] }), { codigo: 'XLSX_CELDA' });
  assert.throws(() => editarCeldas(Buffer.from('nope'), { hoja: 'Sheet1', celdas: [] }), { codigo: 'ZIP_CORRUPTO' });
  const out = editarCeldas(buf, { hoja: 'Sheet1', celdas: [{ ref: 'B2', valor: 'one' }, { ref: 'B2', valor: 'two' }] });
  assert.equal(leerXlsx(out).hojas[0].filas[1][1], 'two');
});
