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

test('style survives a shared-string cell turned inline', () => {
  const buf = conHoja(trackerFixture({ variante: 'compartidas' }), (x) => x.replace('<c r="B3" s="0" t="s">', '<c r="B3" s="1" t="s">'));
  const out = editarCeldas(buf, { hoja: 'Sheet1', celdas: [{ ref: 'B3', valor: 'Z' }] });
  assert.match(xmlHoja(out), /<c r="B3" s="1" t="inlineStr"><is><t xml:space="preserve">Z<\/t><\/is><\/c>/);
  assert.ok(leerZip(out).get('xl/sharedStrings.xml').equals(leerZip(buf).get('xl/sharedStrings.xml')));
});

test('formula cells are refused, plain neighbours are not', () => {
  const buf = conHoja(trackerFixture(), (x) => x.replace(/<c r="B3"[^>]*>[\s\S]*?<\/c>/, '<c r="B3" s="0"><f t="shared" ref="B3:B4" si="0">1+1</f><v>2</v></c>'));
  assert.throws(() => editarCeldas(buf, { hoja: 'Sheet1', celdas: [{ ref: 'B3', valor: 'Z' }] }), { codigo: 'XLSX_FORMULA', message: /^\[seki-review\/xlsx\]/ });
  assert.equal(leerXlsx(editarCeldas(buf, { hoja: 'Sheet1', celdas: [{ ref: 'A3', valor: 'Z' }] })).hojas[0].filas[2][0], 'Z');
});

test('a new cell lands in column order and extends spans and dimension', () => {
  const sin = conHoja(trackerFixture(), (x) => x.replace(/<c r="D2"[^>]*\/>|<c r="D2".*?<\/c>/, ''));
  const out = editarCeldas(sin, { hoja: 'Sheet1', celdas: [{ ref: 'K2', valor: 'k' }, { ref: 'D2', valor: 'd' }] });
  const fila = /<row r="2"[^>]*>[\s\S]*?<\/row>/.exec(xmlHoja(out))[0];
  const cols = [...fila.matchAll(/<c r="([A-Z]+)2"/g)].map((m) => m[1]);
  assert.deepEqual(cols, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'K']);
  assert.match(fila, /<c r="D2" t="inlineStr">/); // header row is never a style source
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
  assert.match(x, /<row r="3" spans="1:2"><c r="A3" s="0" t="inlineStr">.*?<c r="B3" s="0" t="inlineStr">/);
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

test('new cell styles: row customFormat, then column style, then cell above, never the header', () => {
  const base = trackerFixture();
  const sinC2 = (x) => x.replace(/<c r="C2"[\s\S]*?<\/c>/, '').replace(/<c r="D3"[^>]*>[\s\S]*?<\/c>/, '');
  // row style wins over column style
  const conFila = conHoja(base, (x) => sinC2(x).replace('<row r="2" spans="1:9">', '<row r="2" spans="1:9" s="1" customFormat="1">').replace('<sheetData>', '<cols><col min="3" max="3" width="9" style="1"/></cols><sheetData>'));
  assert.match(xmlHoja(editarCeldas(conFila, { hoja: 'Sheet1', celdas: [{ ref: 'C2', valor: 'v' }] })), /<c r="C2" s="1" t="inlineStr">/);
  // row s without customFormat is ignored; column style applies
  const conCol = conHoja(base, (x) => sinC2(x).replace('<row r="2" spans="1:9">', '<row r="2" spans="1:9" s="1">').replace('<sheetData>', '<cols><col min="2" max="3" width="9" style="1"/></cols><sheetData>'));
  assert.match(xmlHoja(editarCeldas(conCol, { hoja: 'Sheet1', celdas: [{ ref: 'C2', valor: 'v' }] })), /<c r="C2" s="1" t="inlineStr">/);
  // cell above from a data row
  assert.match(xmlHoja(editarCeldas(conHoja(base, sinC2), { hoja: 'Sheet1', celdas: [{ ref: 'D3', valor: 'v' }] })), /<c r="D3" s="0" t="inlineStr">/);
  // header row configurable: with filaEncabezado 0 the header row is a valid source
  assert.match(xmlHoja(editarCeldas(conHoja(base, sinC2), { hoja: 'Sheet1', celdas: [{ ref: 'C2', valor: 'v' }], filaEncabezado: 0 })), /<c r="C2" s="1" t="inlineStr">/);
  assert.match(xmlHoja(editarCeldas(conHoja(base, sinC2), { hoja: 'Sheet1', celdas: [{ ref: 'C2', valor: 'v' }] })), /<c r="C2" t="inlineStr">/);
});

test('new rows omit spans when neighbours have none', () => {
  const sin = conHoja(trackerFixture(), (x) => x.replace(/ spans="[^"]*"/g, ''));
  assert.match(xmlHoja(editarCeldas(sin, { hoja: 'Sheet1', celdas: [{ ref: 'A6', valor: 'v' }] })), /<row r="6"><c r="A6"/);
});

test('rows appended below an autoFilter range extend it', () => {
  const out = xmlHoja(editarCeldas(trackerFixture(), { hoja: 'Sheet1', celdas: [{ ref: 'A5', valor: 'a' }, { ref: 'A6', valor: 'b' }, { ref: 'A9', valor: 'c' }] }));
  assert.match(out, /<autoFilter ref="A1:I6"\/>/);
  assert.match(xmlHoja(editarCeldas(trackerFixture(), { hoja: 'Sheet1', celdas: [{ ref: 'A2', valor: 'a' }] })), /<autoFilter ref="A1:I4"\/>/);
});

test('the autoFilter extends over a contiguous run holding an edit, never across a gap', () => {
  const conVacia = conHoja(trackerFixture(), (x) => x.replace('</sheetData>', '<row r="5"/></sheetData>'));
  const ref = (b, celdas) => /<autoFilter ref="([^"]*)"/.exec(xmlHoja(editarCeldas(b, { hoja: 'Sheet1', celdas })))[1];
  assert.equal(ref(conVacia, [{ ref: 'A5', valor: 'a' }]), 'A1:I5');
  assert.equal(ref(conVacia, [{ ref: 'A6', valor: 'a' }]), 'A1:I6');
  assert.equal(ref(conVacia, [{ ref: 'A5', valor: 'a' }, { ref: 'A6', valor: 'b' }]), 'A1:I6');
  assert.equal(ref(conVacia, [{ ref: 'A7', valor: 'a' }]), 'A1:I4');
  assert.equal(ref(conVacia, [{ ref: 'A2', valor: 'a' }]), 'A1:I4');
  assert.equal(ref(trackerFixture(), [{ ref: 'A5', valor: 'a' }, { ref: 'A7', valor: 'c' }]), 'A1:I5');
});

function conTabla(ref, extra = '') {
  const base = conHoja(trackerFixture(), (x) => x.replace('</worksheet>', '<tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>'));
  return reemplazarEntradas(base, new Map([
    ['xl/worksheets/_rels/sheet1.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>'],
    ['xl/tables/table1.xml', `<?xml version="1.0"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="T1" displayName="T1" ref="${ref}"${extra}><tableColumns count="1"><tableColumn id="1" name="ID"/></tableColumns></table>`],
  ]));
}

test('table header edits and rows outside the table are refused', () => {
  const buf = conTabla('A1:I4');
  const falla = (celdas) => assert.throws(() => editarCeldas(buf, { hoja: 'Sheet1', celdas }), { codigo: 'XLSX_TABLA' });
  falla([{ ref: 'B1', valor: 'Renamed' }]);
  falla([{ ref: 'A5', valor: 'x' }]);
  assert.equal(leerXlsx(editarCeldas(buf, { hoja: 'Sheet1', celdas: [{ ref: 'B2', valor: 'ok' }] })).hojas[0].filas[1][1], 'ok');
  // headerRowCount="0": row 1 is data, not header
  const sinCab = conTabla('A1:I4', ' headerRowCount="0"');
  assert.equal(leerXlsx(editarCeldas(sinCab, { hoja: 'Sheet1', celdas: [{ ref: 'B1', valor: 'ok' }] })).hojas[0].filas[0][1], 'ok');
  // missing sheet rels with tableParts
  const roto = reemplazarEntradas(conHoja(trackerFixture(), (x) => x.replace('</worksheet>', '<tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>')), new Map());
  assert.throws(() => editarCeldas(roto, { hoja: 'Sheet1', celdas: [{ ref: 'B2', valor: 'x' }] }), { codigo: 'XLSX_ESTRUCTURA' });
});

test('cells and rows without r are positioned by order', () => {
  const buf = conHoja(trackerFixture(), () => '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C2"/><sheetData><row><c t="inlineStr"><is><t>a</t></is></c><c t="inlineStr"><is><t>b</t></is></c><c t="inlineStr"><is><t>c</t></is></c></row><row><c t="inlineStr"><is><t>d</t></is></c><c r="C2" t="inlineStr"><is><t>f</t></is></c></row></sheetData></worksheet>');
  const out = editarCeldas(buf, { hoja: 'Sheet1', celdas: [{ ref: 'B1', valor: 'B' }, { ref: 'B2', valor: 'e' }, { ref: 'D1', valor: 'z' }] });
  const f = leerXlsx(out).hojas[0].filas;
  assert.deepEqual(f[0], ['a', 'B', 'c', 'z']);
  assert.deepEqual(f[1], ['d', 'e', 'f']);
  assert.match(xmlHoja(out), /<dimension ref="A1:D2"\/>/);
});

test('extLst inside a row is preserved and cells are inserted before it', () => {
  const buf = conHoja(trackerFixture(), (x) => x.replace(/(<row r="2"[^>]*>[\s\S]*?)<c r="I2" s="0"\/><\/row>/, '$1<extLst><ext uri="{x}"/></extLst></row>'));
  const out = xmlHoja(editarCeldas(buf, { hoja: 'Sheet1', celdas: [{ ref: 'I2', valor: 'v' }, { ref: 'J2', valor: 'w' }] }));
  assert.match(out, /<c r="J2" t="inlineStr"><is><t xml:space="preserve">w<\/t><\/is><\/c><extLst><ext uri="\{x\}"\/><\/extLst><\/row>/);
});

test('the filter database name follows an extended autoFilter, and workbook.xml is untouched otherwise', () => {
  const nombre = (f) => `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Sheet1!$A$1:$I$${f}</definedName><definedName name="Other" localSheetId="1">Sheet1!$A$1:$I$4</definedName></definedNames>`;
  const base = trackerFixture();
  const libroBase = leerZip(base).get('xl/workbook.xml').toString('utf8');
  const conNombre = reemplazarEntradas(base, new Map([['xl/workbook.xml', libroBase.replace('</workbook>', `${nombre(4)}</workbook>`)]]));
  const out = editarCeldas(conNombre, { hoja: 'Sheet1', celdas: [{ ref: 'A5', valor: 'a' }, { ref: 'A6', valor: 'b' }] });
  assert.equal(leerZip(out).get('xl/workbook.xml').toString('utf8'), libroBase.replace('</workbook>', `${nombre(6)}</workbook>`));
  const quieto = editarCeldas(conNombre, { hoja: 'Sheet1', celdas: [{ ref: 'A2', valor: 'a' }] });
  assert.ok(leerZip(quieto).get('xl/workbook.xml').equals(leerZip(conNombre).get('xl/workbook.xml')));
  const sinNombre = editarCeldas(base, { hoja: 'Sheet1', celdas: [{ ref: 'A5', valor: 'a' }] });
  assert.ok(leerZip(sinNombre).get('xl/workbook.xml').equals(leerZip(base).get('xl/workbook.xml')));
});

test('prefixed sheet elements are refused', () => {
  const buf = conHoja(trackerFixture(), () => '<?xml version="1.0"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>a</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>');
  assert.throws(() => editarCeldas(buf, { hoja: 'Sheet1', celdas: [{ ref: 'A1', valor: 'b' }] }), { codigo: 'XLSX_ESTRUCTURA' });
});
