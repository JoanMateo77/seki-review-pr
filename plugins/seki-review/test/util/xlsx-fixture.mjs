import { crc32, deflateRawSync } from 'node:zlib';
import { crearZip, leerZip } from '../../mcp/lib/zip.mjs';

const ENCABEZADOS = ['ID', 'Finding', 'How to reproduce', 'Expected', 'State', 'Testing PR', 'Production PR', 'In testing', 'In production'];
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export const FILAS_EJEMPLO = [
  ['X-001', 'Generic finding one', 'Open the page\nClick the button', 'The page shows a message', 'Open', '', '', '', ''],
  ['X-002', 'Generic finding two & more', 'Step <a>', 'Value "ok"', 'In progress', 'https://example.test/pr/1', '', '2026-01-02', ''],
  ['X-003', ' padded text ', '', 'Done', 'Closed', 'https://example.test/pr/2', 'https://example.test/pr/3', '2026-01-03', '2026-01-04'],
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ref = (c, r) => `${String.fromCharCode(65 + c)}${r}`;

function hojaXml(todas, compartidas) {
  const ancho = ENCABEZADOS.length;
  const cuerpo = todas.map((fila, ri) => {
    const celdas = fila.map((v, ci) => {
      if (v === '') return `<c r="${ref(ci, ri + 1)}" s="${ri === 0 ? 1 : 0}"/>`;
      const s = ri === 0 ? 1 : 0;
      if (compartidas) return `<c r="${ref(ci, ri + 1)}" s="${s}" t="s"><v>${compartidas.indexOf(v)}</v></c>`;
      return `<c r="${ref(ci, ri + 1)}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    });
    return `<row r="${ri + 1}" spans="1:${ancho}">${celdas.join('')}</row>`;
  });
  const ultima = `${ref(ancho - 1, todas.length)}`;
  return `${DECL}<worksheet xmlns="${NS}" xmlns:r="${REL}"><dimension ref="A1:${ultima}"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>${cuerpo.join('')}</sheetData><autoFilter ref="A1:${ultima}"/><dataValidations count="2"><dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="E2:E5000"><formula1>"Open,In progress,Closed"</formula1></dataValidation><dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="H2:H5000"><formula1>"Yes,No"</formula1></dataValidation></dataValidations></worksheet>`;
}

export function trackerFixture({ variante = 'inline', filas = FILAS_EJEMPLO, descriptores = false } = {}) {
  const todas = [ENCABEZADOS, ...filas];
  const compartidas = variante === 'compartidas' ? [...new Set(todas.flat().filter((v) => v !== ''))] : null;
  const estilos = `${DECL}<styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;
  const tipos = `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${compartidas ? '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' : ''}</Types>`;
  const relsLibro = `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/>${compartidas ? `<Relationship Id="rId3" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` : ''}</Relationships>`;
  const entradas = [
    { nombre: '[Content_Types].xml', datos: tipos },
    { nombre: '_rels/.rels', datos: `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { nombre: 'xl/workbook.xml', datos: `${DECL}<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { nombre: 'xl/_rels/workbook.xml.rels', datos: relsLibro },
    { nombre: 'xl/styles.xml', datos: estilos },
    { nombre: 'xl/worksheets/sheet1.xml', datos: hojaXml(todas, compartidas) },
  ];
  if (compartidas) {
    const si = compartidas.map((v) => `<si><t xml:space="preserve">${esc(v)}</t></si>`).join('');
    entradas.push({ nombre: 'xl/sharedStrings.xml', datos: `${DECL}<sst xmlns="${NS}" count="${compartidas.length}" uniqueCount="${compartidas.length}">${si}</sst>` });
  }
  const zip = crearZip(entradas);
  return descriptores ? conDescriptores(zip, { firma: descriptores !== 'sin-firma' }) : zip;
}

// LibreOffice-style archive: every entry has flag bit 3, zeroed local crc/sizes and a data descriptor after the data.
export function conDescriptores(buf, { firma = true } = {}) {
  const partes = [];
  const centrales = [];
  let offset = 0;
  for (const [nombre, datos] of leerZip(buf)) {
    const nom = Buffer.from(nombre, 'utf8');
    const cuerpo = deflateRawSync(datos);
    const crc = crc32(datos) >>> 0;
    const local = Buffer.alloc(30 + nom.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt16LE(nom.length, 26);
    nom.copy(local, 30);
    const desc = Buffer.alloc(firma ? 16 : 12);
    let o = 0;
    if (firma) { desc.writeUInt32LE(0x08074b50, 0); o = 4; }
    desc.writeUInt32LE(crc, o);
    desc.writeUInt32LE(cuerpo.length, o + 4);
    desc.writeUInt32LE(datos.length, o + 8);
    const central = Buffer.alloc(46 + nom.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    local.copy(central, 6, 4, 30);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(cuerpo.length, 20);
    central.writeUInt32LE(datos.length, 24);
    central.writeUInt32LE(offset, 42);
    nom.copy(central, 46);
    centrales.push(central);
    partes.push(local, cuerpo, desc);
    offset += local.length + cuerpo.length + desc.length;
  }
  const dir = Buffer.concat(centrales);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrales.length, 8);
  eocd.writeUInt16LE(centrales.length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...partes, dir, eocd]);
}
