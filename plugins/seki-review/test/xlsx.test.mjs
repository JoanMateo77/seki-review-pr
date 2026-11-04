import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearZip, leerZip } from '../mcp/lib/zip.mjs';
import { escribirXlsx, leerXlsx, columnaLetra, indiceColumna } from '../mcp/lib/xlsx.mjs';
import { trackerFixture, FILAS_EJEMPLO } from './util/xlsx-fixture.mjs';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function libroMinimo({ hoja, relsExtra = '', objetivo = 'worksheets/sheet1.xml', extras = [], libroExtra = '', relsLibro } = {}) {
  return crearZip([
    { nombre: 'xl/workbook.xml', datos: `<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets>${libroExtra}</workbook>` },
    { nombre: 'xl/_rels/workbook.xml.rels', datos: relsLibro ?? `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="${objetivo}"/>${relsExtra}</Relationships>` },
    { nombre: 'xl/worksheets/sheet1.xml', datos: hoja ?? `<worksheet xmlns="${NS}"><sheetData/></worksheet>` },
    ...extras,
  ]);
}

const hojaCon = (filas) => `<worksheet xmlns="${NS}"><sheetData>${filas}</sheetData></worksheet>`;
const rechaza = (fn, codigo) => assert.throws(fn, (e) => e.codigo === codigo && e.message.startsWith('[seki-review/xlsx]'));

test('columnaLetra e indiceColumna', () => {
  assert.equal(columnaLetra(0), 'A');
  assert.equal(columnaLetra(25), 'Z');
  assert.equal(columnaLetra(26), 'AA');
  assert.equal(columnaLetra(701), 'ZZ');
  assert.equal(columnaLetra(702), 'AAA');
  for (const i of [0, 1, 25, 26, 51, 52, 701, 702, 999]) assert.equal(indiceColumna(columnaLetra(i)), i);
});

test('round trip de texto con casos borde', () => {
  const largo = 'x'.repeat(32767);
  const filas = [
    ['ID', 'Text'],
    ['X-001', 'Árbol ñandú — café'],
    ['X-002', '<&>"\' mixed'],
    ['X-003', 'line1\nline2\r\nline3\ttab'],
    ['X-004', '  leading and trailing  '],
    ['X-005', largo],
    ['X-006', ''],
  ];
  const buf = escribirXlsx({ hojas: [{ nombre: 'Guide', filas }] });
  const { hojas } = leerXlsx(buf);
  assert.equal(hojas.length, 1);
  assert.equal(hojas[0].nombre, 'Guide');
  assert.equal(hojas[0].oculta, false);
  assert.deepEqual(hojas[0].filas, filas);
});

test('caracteres invalidos en XML 1.0 se eliminan', () => {
  const buf = escribirXlsx({ hojas: [{ nombre: 'A', filas: [['a\u0000b\u0008c\uD800d￾e', 'ok😀']] }] });
  assert.deepEqual(leerXlsx(buf).hojas[0].filas, [['abcde', 'ok😀']]);
});

test('hoja, validaciones, congelado, ocultas y anchos en el XML', () => {
  const buf = escribirXlsx({
    hojas: [
      { nombre: 'Guide', filas: [['H1', 'H2'], ['a', 'b']], anchos: [10, 20], congelar: true, validaciones: [{ rango: 'B2:B100', lista: ['OK', 'Fail'] }] },
      { nombre: '_seki', filas: [['k']], oculta: true },
    ],
  });
  const partes = leerZip(buf);
  const h1 = partes.get('xl/worksheets/sheet1.xml').toString();
  assert.match(h1, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(h1, /<dataValidation type="list"[^>]*sqref="B2:B100"><formula1>"OK,Fail"<\/formula1>/);
  assert.match(h1, /<col min="2" max="2" width="20" customWidth="1"\/>/);
  assert.match(h1, /t="inlineStr"><is><t xml:space="preserve">/);
  assert.match(partes.get('xl/workbook.xml').toString(), /name="_seki"[^>]*state="hidden"/);
  assert.match(partes.get('xl/styles.xml').toString(), /<b\/>[\s\S]*wrapText="1"/);
  const { hojas } = leerXlsx(buf);
  assert.deepEqual(hojas.map((h) => h.oculta), [false, true]);
});

test('salida determinista y validaciones invalidas rechazadas', () => {
  const entrada = { hojas: [{ nombre: 'A', filas: [['x', 'y']], congelar: true }] };
  assert.ok(escribirXlsx(entrada).equals(escribirXlsx(entrada)));
  rechaza(() => escribirXlsx({ hojas: [{ nombre: 'A', filas: [['x']], validaciones: [{ rango: 'A1', lista: ['a,b'] }] }] }), 'XLSX_ESTRUCTURA');
  rechaza(() => escribirXlsx({ hojas: [{ nombre: 'A/B', filas: [] }] }), 'XLSX_ESTRUCTURA');
  rechaza(() => escribirXlsx({ hojas: [{ nombre: 'A', filas: [['x'.repeat(32768)]] }] }), 'XLSX_CELDA');
});

test('las dos variantes del rastreador leen igual', () => {
  const a = leerXlsx(trackerFixture({ variante: 'inline' }));
  const b = leerXlsx(trackerFixture({ variante: 'compartidas' }));
  assert.deepEqual(a, b);
  assert.equal(a.hojas[0].filas[0][0], 'ID');
  assert.equal(a.hojas[0].filas[1][2], 'Open the page\nClick the button');
  assert.deepEqual(a.hojas[0].filas.slice(1), FILAS_EJEMPLO);
  assert.equal(a.hojas[0].filas.length, 1 + FILAS_EJEMPLO.length);
});

test('lee cadenas compartidas con texto enriquecido, fonetico, numeros, booleanos y str', () => {
  const sst = `<sst xmlns="${NS}"><si><r><t>Hel</t></r><r><rPr><b/></rPr><t xml:space="preserve">lo </t></r><r><t>w&amp;orld</t></r><rPh sb="0" eb="1"><t>IGNORED</t></rPh></si><si><t>two</t></si></sst>`;
  const hoja = hojaCon('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"><v>3.5</v></c><c r="D1" t="b"><v>1</v></c><c r="E1" t="str"><f>A1&amp;B1</f><v>formula text</v></c></row>');
  const buf = libroMinimo({
    hoja,
    relsExtra: `<Relationship Id="rId9" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`,
    extras: [{ nombre: 'xl/sharedStrings.xml', datos: sst }],
  });
  assert.deepEqual(leerXlsx(buf).hojas[0].filas, [['Hello w&orld', 'two', '3.5', 'TRUE', 'formula text']]);
});

test('celdas se ubican por r, con huecos, filas saltadas y referencias numericas', () => {
  const hoja = hojaCon('<row r="2"><c r="C2" t="inlineStr"><is><t>c&#233;&#x41;</t></is></c><c r="A2" t="inlineStr"><is><t>a</t></is></c></row><row r="4"><c t="inlineStr"><is><t>x</t></is></c></row>');
  assert.deepEqual(leerXlsx(libroMinimo({ hoja })).hojas[0].filas, [[], ['a', '', 'céA'], [], ['x']]);
});

test('rechaza DOCTYPE y ENTITY en cualquier caso', () => {
  for (const marca of ['<!DOCTYPE x>', '<!doctype x>', '<!ENTITY a "b">', '<!eNtItY a "b">']) {
    const hoja = `<?xml version="1.0"?>${marca}<worksheet xmlns="${NS}"><sheetData/></worksheet>`;
    rechaza(() => leerXlsx(libroMinimo({ hoja })), 'XLSX_XML');
  }
  const libro = crearZip([
    { nombre: 'xl/workbook.xml', datos: `<!DOCTYPE x><workbook/>` },
    { nombre: 'xl/_rels/workbook.xml.rels', datos: '<Relationships/>' },
  ]);
  rechaza(() => leerXlsx(libro), 'XLSX_XML');
});

test('rechaza entidades no soportadas y XML mal formado', () => {
  rechaza(() => leerXlsx(libroMinimo({ hoja: hojaCon('<row r="1"><c r="A1" t="inlineStr"><is><t>&nbsp;</t></is></c></row>') })), 'XLSX_XML');
  rechaza(() => leerXlsx(libroMinimo({ hoja: hojaCon('<row r="1"><c r="A1" t="inlineStr"><is><t>&#0;</t></is></c></row>') })), 'XLSX_XML');
  rechaza(() => leerXlsx(libroMinimo({ hoja: hojaCon('<row r="1"><c r="A1" t=inlineStr></c></row>') })), 'XLSX_XML');
  rechaza(() => leerXlsx(libroMinimo({ hoja: '<worksheet><!-- sin cierre' })), 'XLSX_XML');
});

test('rechaza UTF-16 por BOM y por declaracion', () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<worksheet/>', 'utf16le')]);
  rechaza(() => leerXlsx(libroMinimo({ hoja: utf16 })), 'XLSX_CODIFICACION');
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('<worksheet/>', 'utf16le').swap16()]);
  rechaza(() => leerXlsx(libroMinimo({ hoja: utf16be })), 'XLSX_CODIFICACION');
  rechaza(() => leerXlsx(libroMinimo({ hoja: `<?xml version="1.0" encoding="UTF-16"?><worksheet xmlns="${NS}"/>` })), 'XLSX_CODIFICACION');
  rechaza(() => leerXlsx(libroMinimo({ hoja: Buffer.from([0x3c, 0xc3, 0x28, 0x3e]) })), 'XLSX_CODIFICACION');
});

test('acepta BOM UTF-8', () => {
  const hoja = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(hojaCon('<row r="1"><c r="A1" t="inlineStr"><is><t>ok</t></is></c></row>'))]);
  assert.deepEqual(leerXlsx(libroMinimo({ hoja })).hojas[0].filas, [['ok']]);
});

test('limites de filas, columnas y celda', () => {
  const filas = (n) => Array.from({ length: n }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>v</t></is></c></row>`).join('');
  assert.equal(leerXlsx(libroMinimo({ hoja: hojaCon(filas(5000)) })).hojas[0].filas.length, 5000);
  rechaza(() => leerXlsx(libroMinimo({ hoja: hojaCon(filas(5001)) })), 'XLSX_FILAS');
  rechaza(() => leerXlsx(libroMinimo({ hoja: hojaCon('<row r="9999"><c r="A9999"/></row>') })), 'XLSX_FILAS');
  const col = (letra) => hojaCon(`<row r="1"><c r="${letra}1" t="inlineStr"><is><t>v</t></is></c></row>`);
  assert.equal(leerXlsx(libroMinimo({ hoja: col('CV') })).hojas[0].filas[0].length, 100);
  rechaza(() => leerXlsx(libroMinimo({ hoja: col('CW') })), 'XLSX_COLUMNAS');
  const celda = (n) => hojaCon(`<row r="1"><c r="A1" t="inlineStr"><is><t>${'x'.repeat(n)}</t></is></c></row>`);
  assert.equal(leerXlsx(libroMinimo({ hoja: celda(32767) })).hojas[0].filas[0][0].length, 32767);
  rechaza(() => leerXlsx(libroMinimo({ hoja: celda(32768) })), 'XLSX_CELDA');
  rechaza(() => leerXlsx(libroMinimo({ hoja: hojaCon('<row r="1"><c r="A1" t="s"><v>5</v></c></row>') })), 'XLSX_CELDA');
});

test('rutas de relaciones fuera de xl/ o inexistentes', () => {
  for (const objetivo of ['../../etc/x', '../docProps/app.xml', '/etc/passwd', '/docProps/core.xml', 'worksheets/nope.xml', '..\\x', '../xl']) {
    rechaza(() => leerXlsx(libroMinimo({ objetivo })), 'XLSX_RUTA');
  }
  const externa = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="http://x.test/s.xml" TargetMode="External"/></Relationships>`;
  rechaza(() => leerXlsx(libroMinimo({ relsLibro: externa })), 'XLSX_RUTA');
});

test('objetivo absoluto /xl/ valido y solo se leen partes alcanzadas', () => {
  const buf = libroMinimo({
    objetivo: '/xl/worksheets/sheet1.xml',
    hoja: hojaCon('<row r="1"><c r="A1" t="inlineStr"><is><t>ok</t></is></c></row>'),
    extras: [{ nombre: 'xl/worksheets/sheet2.xml', datos: '<<<< basura sin relacion' }, { nombre: 'docProps/core.xml', datos: '<!DOCTYPE x>' }],
  });
  assert.deepEqual(leerXlsx(buf).hojas[0].filas, [['ok']]);
});

test('estructura faltante y errores del zip llevan etiqueta y codigo', () => {
  rechaza(() => leerXlsx(crearZip([{ nombre: 'otro.xml', datos: '<a/>' }])), 'XLSX_ESTRUCTURA');
  rechaza(() => leerXlsx(crearZip([{ nombre: 'xl/workbook.xml', datos: '<workbook/>' }])), 'XLSX_ESTRUCTURA');
  rechaza(() => leerXlsx(libroMinimo({ libroExtra: '', relsLibro: '<Relationships/>' })), 'XLSX_ESTRUCTURA');
  rechaza(() => leerXlsx(Buffer.from('not a zip at all, definitely')), 'ZIP_CORRUPTO');
});

test('tokenizador lineal: entrada patologica termina rapido', () => {
  const casos = ['<c '.repeat(350000), '<c r="A1" '.repeat(100000), '<'.repeat(1_000_000), `<row>${'<c r="A1" t="inlineStr"><is><t>'.repeat(30000)}`];
  for (const patologico of casos) {
    const t0 = performance.now();
    try {
      leerXlsx(libroMinimo({ hoja: patologico }));
    } catch (e) {
      assert.equal(typeof e.codigo, 'string');
    }
    assert.ok(performance.now() - t0 < 2000, 'tokenizer must be linear');
  }
  const tag = `<worksheet xmlns="${NS}"><sheetData>${'<x a="&amp;&amp;&amp;"/>'.repeat(40000)}</sheetData></worksheet>`;
  const t1 = performance.now();
  assert.deepEqual(leerXlsx(libroMinimo({ hoja: tag })).hojas[0].filas, []);
  assert.ok(performance.now() - t1 < 2000);
});

function libroConHojas(n, { mismaParte = true, hoja, ids } = {}) {
  const sheets = Array.from({ length: n }, (_, i) => `<sheet name="S${i}" sheetId="${i + 1}" r:id="${ids ? ids(i) : `rId${i + 1}`}"/>`).join('');
  const rels = Array.from({ length: n }, (_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/${mismaParte ? 'sheet1' : `sheet${i + 1}`}.xml"/>`).join('');
  const cuerpo = hoja ?? hojaCon('<row r="1"><c r="A1" t="inlineStr"><is><t>v</t></is></c></row>');
  const partes = mismaParte ? [{ nombre: 'xl/worksheets/sheet1.xml', datos: cuerpo }] : Array.from({ length: n }, (_, i) => ({ nombre: `xl/worksheets/sheet${i + 1}.xml`, datos: cuerpo }));
  return crearZip([
    { nombre: 'xl/workbook.xml', datos: `<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>${sheets}</sheets></workbook>` },
    { nombre: 'xl/_rels/workbook.xml.rels', datos: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>` },
    ...partes,
  ]);
}

test('regresion: 200 hojas sobre una misma parte fallan rapido', () => {
  const fila = `<row r="1">${Array.from({ length: 100 }, (_, c) => `<c r="${columnaLetra(c)}1" t="inlineStr"><is><t>v</t></is></c>`).join('')}</row>`;
  const t0 = performance.now();
  rechaza(() => leerXlsx(libroConHojas(200, { hoja: hojaCon(fila.repeat(1)) })), 'XLSX_ESTRUCTURA');
  assert.ok(performance.now() - t0 < 1000);
});

test('limite de hojas, ids duplicados y partes compartidas', () => {
  assert.equal(leerXlsx(libroConHojas(50, { mismaParte: false })).hojas.length, 50);
  rechaza(() => leerXlsx(libroConHojas(51, { mismaParte: false })), 'XLSX_ESTRUCTURA');
  rechaza(() => leerXlsx(libroConHojas(2, { mismaParte: false, ids: () => 'rId1' })), 'XLSX_ESTRUCTURA');
  rechaza(() => leerXlsx(libroConHojas(2, { mismaParte: true })), 'XLSX_ESTRUCTURA');
});

test('presupuesto global de celdas entre hojas', () => {
  const filas = Array.from({ length: 2000 }, (_, r) => `<row r="${r + 1}">${Array.from({ length: 100 }, (_, c) => `<c r="${columnaLetra(c)}${r + 1}"/>`).join('')}</row>`).join('');
  const t0 = performance.now();
  rechaza(() => leerXlsx(libroConHojas(3, { mismaParte: false, hoja: hojaCon(filas) })), 'XLSX_FILAS');
  assert.ok(performance.now() - t0 < 5000);
});

test('cadenas compartidas mal formadas dan error etiquetado', () => {
  const con = (sst) => libroMinimo({
    hoja: hojaCon('<row r="1"><c r="A1" t="s"><v>0</v></c></row>'),
    relsExtra: `<Relationship Id="rId9" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`,
    extras: [{ nombre: 'xl/sharedStrings.xml', datos: sst }],
  });
  rechaza(() => leerXlsx(con(`<sst xmlns="${NS}"></si></sst>`)), 'XLSX_XML');
  rechaza(() => leerXlsx(con(`<sst xmlns="${NS}"><si><t>x</t>`)), 'XLSX_XML');
  rechaza(() => leerXlsx(con(`<sst xmlns="${NS}"><si><t>${'x'.repeat(32768)}</t></si></sst>`)), 'XLSX_CELDA');
  const partido = `<sst xmlns="${NS}"><si>${'<r><t>xxxxxxxx</t></r>'.repeat(5000)}</si></sst>`;
  rechaza(() => leerXlsx(con(partido)), 'XLSX_CELDA');
});

test('estructuras desbalanceadas en hoja y libro nunca lanzan TypeError', () => {
  const casos = ['</c></row></is></t></v>', '<row><c></c></c></row></row>', '<is><t>x</t></is><v>1</v><rPh></rPh></rPh>', '<c r="A1"><v>1</v></c>'];
  for (const c of casos) {
    try {
      leerXlsx(libroMinimo({ hoja: hojaCon(c) }));
    } catch (e) {
      assert.equal(typeof e.codigo, 'string', e.message);
      assert.ok(e.message.startsWith('[seki-review/xlsx]'));
    }
  }
});

test('celda t="s" vacia se lee como cadena vacia', () => {
  assert.deepEqual(leerXlsx(libroMinimo({ hoja: hojaCon('<row r="1"><c r="A1" t="s"/><c r="B1" t="s"><v></v></c></row>') })).hojas[0].filas, [['', '']]);
});

test('errores del zip llevan una sola etiqueta', () => {
  assert.throws(() => leerXlsx(Buffer.from('not a zip at all, definitely')), (e) => e.codigo === 'ZIP_CORRUPTO' && e.message.split('[seki-review/xlsx]').length === 2 && !e.message.includes('[seki-review/zip]'));
});

test('escritor: todas ocultas, rangos fuera de la grilla y argumentos mal tipados', () => {
  rechaza(() => escribirXlsx({ hojas: [{ nombre: 'A', filas: [['x']], oculta: true }] }), 'XLSX_ESTRUCTURA');
  const v = (rango) => escribirXlsx({ hojas: [{ nombre: 'A', filas: [['x']], validaciones: [{ rango, lista: ['a'] }] }] });
  assert.ok(v('XFD1048576'));
  rechaza(() => v('ZZZ9999999'), 'XLSX_ESTRUCTURA');
  rechaza(() => v('XFE1'), 'XLSX_ESTRUCTURA');
  rechaza(() => v('A0'), 'XLSX_ESTRUCTURA');
  rechaza(() => v('A1:A1048577'), 'XLSX_ESTRUCTURA');
  rechaza(() => escribirXlsx({ hojas: [{ nombre: 'A', filas: [['x']], validaciones: 'abc' }] }), 'XLSX_ESTRUCTURA');
  rechaza(() => escribirXlsx({ hojas: [{ nombre: 'A', filas: [['x']], anchos: 'abc' }] }), 'XLSX_ESTRUCTURA');
  rechaza(() => escribirXlsx({ hojas: [{ nombre: 'A', filas: [['x']], anchos: Array(101).fill(10) }] }), 'XLSX_COLUMNAS');
});
