import { crearZip, leerZip } from './zip.mjs';

const ETIQUETA = '[seki-review/xlsx]';
const MAX_FILAS = 5000;
const MAX_COLUMNAS = 100;
const MAX_CELDA = 32767;
const MAX_HOJAS = 50;
const MAX_CELDAS_TOTAL = 500000;
const MAX_FILA_EXCEL = 1048576;
const MAX_COL_EXCEL = 16383; // XFD

function fallar(codigo, mensaje) {
  const e = new Error(`${ETIQUETA} ${mensaje}`);
  e.codigo = codigo;
  throw e;
}

export function columnaLetra(i) {
  if (!Number.isInteger(i) || i < 0) fallar('XLSX_COLUMNAS', 'Invalid column index');
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = (n - 1 - r) / 26;
  }
  return s;
}

export function indiceColumna(letra) {
  if (typeof letra !== 'string' || !/^[A-Za-z]{1,3}$/.test(letra)) fallar('XLSX_COLUMNAS', 'Invalid column letters');
  let n = 0;
  for (const c of letra.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

// ---------------------------------------------------------------- writer

const INVALIDOS_XML = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu;

function limpiar(texto) {
  return String(texto).replace(INVALIDOS_XML, '');
}

function escTexto(texto) {
  return texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
}

function escAttr(texto) {
  return limpiar(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;');
}

const CABECERA_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

const ESTILOS = `${CABECERA_XML}<styleSheet xmlns="${NS_MAIN}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function validarHoja(h, nombres) {
  if (!h || typeof h.nombre !== 'string' || !Array.isArray(h.filas)) fallar('XLSX_ESTRUCTURA', 'Invalid sheet definition');
  const nombre = limpiar(h.nombre);
  if (nombre === '' || nombre.length > 31 || /[[\]:*?/\\]/.test(nombre) || nombre.startsWith("'") || nombre.endsWith("'")) {
    fallar('XLSX_ESTRUCTURA', 'Invalid sheet name');
  }
  if (nombres.has(nombre.toLowerCase())) fallar('XLSX_ESTRUCTURA', 'Duplicate sheet name');
  nombres.add(nombre.toLowerCase());
  return nombre;
}

function rangoValido(rango) {
  const m = /^([A-Z]{1,3})([0-9]{1,7})(?::([A-Z]{1,3})([0-9]{1,7}))?$/.exec(rango);
  if (!m) return false;
  const col = (l) => indiceColumna(l) <= MAX_COL_EXCEL;
  const fil = (n) => Number(n) >= 1 && Number(n) <= MAX_FILA_EXCEL;
  return col(m[1]) && fil(m[2]) && (m[3] === undefined || (col(m[3]) && fil(m[4])));
}

function xmlHoja(h, esActiva) {
  const filas = h.filas;
  const encabezado = h.encabezado !== false;
  let maxCol = 0;
  for (const f of filas) {
    if (!Array.isArray(f)) fallar('XLSX_ESTRUCTURA', 'Invalid row');
    if (f.length > maxCol) maxCol = f.length;
  }
  if (maxCol > MAX_COLUMNAS) fallar('XLSX_COLUMNAS', 'Too many columns');
  const partes = [`${CABECERA_XML}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`];
  const ultima = maxCol > 0 && filas.length > 0 ? `A1:${columnaLetra(maxCol - 1)}${filas.length}` : 'A1';
  partes.push(`<dimension ref="${ultima}"/>`);
  const sel = esActiva ? ' tabSelected="1"' : '';
  if (h.congelar === true) {
    partes.push(`<sheetViews><sheetView${sel} workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>`);
  } else {
    partes.push(`<sheetViews><sheetView${sel} workbookViewId="0"/></sheetViews>`);
  }
  partes.push('<sheetFormatPr defaultRowHeight="15"/>');
  if (h.anchos !== undefined && !Array.isArray(h.anchos)) fallar('XLSX_ESTRUCTURA', 'Invalid column widths');
  if (h.validaciones !== undefined && !Array.isArray(h.validaciones)) fallar('XLSX_ESTRUCTURA', 'Invalid data validations');
  if (Array.isArray(h.anchos) && h.anchos.length > MAX_COLUMNAS) fallar('XLSX_COLUMNAS', 'Too many column widths');
  if (Array.isArray(h.anchos) && h.anchos.length > 0) {
    partes.push('<cols>');
    h.anchos.forEach((a, i) => {
      if (!Number.isFinite(a) || a <= 0 || a > 255) fallar('XLSX_ESTRUCTURA', 'Invalid column width');
      partes.push(`<col min="${i + 1}" max="${i + 1}" width="${a}" customWidth="1"/>`);
    });
    partes.push('</cols>');
  }
  partes.push('<sheetData>');
  filas.forEach((f, ri) => {
    partes.push(`<row r="${ri + 1}">`);
    f.forEach((v, ci) => {
      const ref = `${columnaLetra(ci)}${ri + 1}`;
      const estilo = ri === 0 && encabezado ? 1 : 2;
      const texto = v === null || v === undefined ? '' : limpiar(v);
      if (texto.length > MAX_CELDA) fallar('XLSX_CELDA', 'Cell text is too long');
      if (texto === '') partes.push(`<c r="${ref}" s="${estilo}"/>`);
      else partes.push(`<c r="${ref}" s="${estilo}" t="inlineStr"><is><t xml:space="preserve">${escTexto(texto)}</t></is></c>`);
    });
    partes.push('</row>');
  });
  partes.push('</sheetData>');
  const vals = h.validaciones ?? [];
  if (vals.length > 0) {
    partes.push(`<dataValidations count="${vals.length}">`);
    for (const v of vals) {
      if (!v || typeof v.rango !== 'string' || !Array.isArray(v.lista) || v.lista.length === 0 || !rangoValido(v.rango)) {
        fallar('XLSX_ESTRUCTURA', 'Invalid data validation');
      }
      const items = v.lista.map((x) => limpiar(x));
      if (items.some((x) => x.includes(',') || x.includes('"') || x === '')) fallar('XLSX_ESTRUCTURA', 'Invalid data validation list item');
      const formula = items.join(',');
      if (formula.length > 255) fallar('XLSX_ESTRUCTURA', 'Data validation list is too long');
      partes.push(`<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${v.rango}"><formula1>"${escTexto(formula)}"</formula1></dataValidation>`);
    }
    partes.push('</dataValidations>');
  }
  partes.push('</worksheet>');
  return partes.join('');
}

export function escribirXlsx({ hojas } = {}) {
  if (!Array.isArray(hojas) || hojas.length === 0) fallar('XLSX_ESTRUCTURA', 'At least one sheet is required');
  const nombres = new Set();
  const lista = hojas.map((h) => ({ h, nombre: validarHoja(h, nombres) }));
  const activa = lista.findIndex(({ h }) => h.oculta !== true);
  if (activa < 0) fallar('XLSX_ESTRUCTURA', 'At least one sheet must be visible');

  const tipos = [
    `${CABECERA_XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`,
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    ...lista.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`),
    '</Types>',
  ].join('');
  const relsRaiz = `${CABECERA_XML}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const libro = [
    `${CABECERA_XML}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`,
    `<bookViews><workbookView activeTab="${activa}"/></bookViews><sheets>`,
    ...lista.map(({ h, nombre }, i) => `<sheet name="${escAttr(nombre)}" sheetId="${i + 1}"${h.oculta === true ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`),
    '</sheets></workbook>',
  ].join('');
  const relsLibro = [
    `${CABECERA_XML}<Relationships xmlns="${NS_PKG_REL}">`,
    ...lista.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`),
    `<Relationship Id="rId${lista.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>`,
    '</Relationships>',
  ].join('');

  return crearZip([
    { nombre: '[Content_Types].xml', datos: tipos },
    { nombre: '_rels/.rels', datos: relsRaiz },
    { nombre: 'xl/workbook.xml', datos: libro },
    { nombre: 'xl/_rels/workbook.xml.rels', datos: relsLibro },
    { nombre: 'xl/styles.xml', datos: ESTILOS },
    ...lista.map(({ h }, i) => ({ nombre: `xl/worksheets/sheet${i + 1}.xml`, datos: xmlHoja(h, i === activa) })),
  ]);
}

// ---------------------------------------------------------------- reader

function decodificarParte(buf) {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    fallar('XLSX_CODIFICACION', 'UTF-16 content is not supported');
  }
  let texto;
  try {
    texto = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf);
  } catch {
    fallar('XLSX_CODIFICACION', 'Part is not valid UTF-8');
  }
  if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1);
  const decl = /^<\?xml[^>]*>/.exec(texto);
  if (decl && /encoding\s*=\s*["']?\s*utf-?16/i.test(decl[0])) fallar('XLSX_CODIFICACION', 'UTF-16 content is not supported');
  if (/<!doctype|<!entity/i.test(texto)) fallar('XLSX_XML', 'DTD and entity declarations are not allowed');
  return texto;
}

function decodificarEntidades(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&[^;\s&<]{0,10};?/g, (m) => {
    switch (m) {
      case '&lt;': return '<';
      case '&gt;': return '>';
      case '&amp;': return '&';
      case '&quot;': return '"';
      case '&apos;': return "'";
      default: {
        const num = /^&#(?:x([0-9A-Fa-f]{1,6})|([0-9]{1,7}));$/.exec(m);
        if (!num) fallar('XLSX_XML', 'Unsupported entity reference');
        const cp = num[1] ? parseInt(num[1], 16) : parseInt(num[2], 10);
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || (cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13) || cp === 0xfffe || cp === 0xffff) {
          fallar('XLSX_XML', 'Invalid character reference');
        }
        return String.fromCodePoint(cp);
      }
    }
  });
}

const ESPACIO = /\s/;

function nombreLocal(n) {
  const i = n.indexOf(':');
  return i < 0 ? n : n.slice(i + 1);
}

// Linear-time tokenizer: each step consumes input; nothing rescans.
function* tokens(xml) {
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      yield { tipo: 'texto', texto: decodificarEntidades(xml.slice(i)) };
      return;
    }
    if (lt > i) yield { tipo: 'texto', texto: decodificarEntidades(xml.slice(i, lt)) };
    if (xml.startsWith('<!--', lt)) {
      const fin = xml.indexOf('-->', lt + 4);
      if (fin < 0) fallar('XLSX_XML', 'Unterminated comment');
      i = fin + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const fin = xml.indexOf(']]>', lt + 9);
      if (fin < 0) fallar('XLSX_XML', 'Unterminated CDATA section');
      yield { tipo: 'texto', texto: xml.slice(lt + 9, fin) };
      i = fin + 3;
    } else if (xml.startsWith('<?', lt)) {
      const fin = xml.indexOf('?>', lt + 2);
      if (fin < 0) fallar('XLSX_XML', 'Unterminated processing instruction');
      i = fin + 2;
    } else if (xml.startsWith('<!', lt)) {
      fallar('XLSX_XML', 'Unsupported markup declaration');
    } else if (xml.startsWith('</', lt)) {
      const gt = xml.indexOf('>', lt + 2);
      if (gt < 0) fallar('XLSX_XML', 'Unterminated end tag');
      yield { tipo: 'cierra', nombre: nombreLocal(xml.slice(lt + 2, gt).trim()) };
      i = gt + 1;
    } else {
      let p = lt + 1;
      while (p < n && !ESPACIO.test(xml[p]) && xml[p] !== '>' && xml[p] !== '/') p++;
      if (p >= n || p === lt + 1) fallar('XLSX_XML', 'Malformed start tag');
      const nombre = nombreLocal(xml.slice(lt + 1, p));
      const attrs = {};
      let auto = false;
      for (;;) {
        while (p < n && ESPACIO.test(xml[p])) p++;
        if (p >= n) fallar('XLSX_XML', 'Unterminated start tag');
        if (xml[p] === '>') { p++; break; }
        if (xml[p] === '/') {
          if (xml[p + 1] !== '>') fallar('XLSX_XML', 'Malformed start tag');
          auto = true;
          p += 2;
          break;
        }
        const ini = p;
        while (p < n && xml[p] !== '=' && !ESPACIO.test(xml[p]) && xml[p] !== '>' && xml[p] !== '/' && xml[p] !== '<') p++;
        const clave = xml.slice(ini, p);
        while (p < n && ESPACIO.test(xml[p])) p++;
        if (clave === '' || xml[p] !== '=') fallar('XLSX_XML', 'Malformed attribute');
        p++;
        while (p < n && ESPACIO.test(xml[p])) p++;
        const q = xml[p];
        if (q !== '"' && q !== "'") fallar('XLSX_XML', 'Malformed attribute');
        const fin = xml.indexOf(q, p + 1);
        if (fin < 0) fallar('XLSX_XML', 'Unterminated attribute value');
        attrs[clave] = decodificarEntidades(xml.slice(p + 1, fin));
        p = fin + 1;
      }
      yield { tipo: 'abre', nombre, attrs };
      if (auto) yield { tipo: 'cierra', nombre };
      i = p;
    }
  }
}

function atributoId(attrs) {
  for (const k of Object.keys(attrs)) if (k === 'r:id' || k.endsWith(':id')) return attrs[k];
  return undefined;
}

function resolverRuta(objetivo) {
  if (typeof objetivo !== 'string' || objetivo === '' || objetivo.includes('\\') || objetivo.includes('\0')) {
    fallar('XLSX_RUTA', 'Invalid relationship target');
  }
  const base = objetivo.startsWith('/') ? [] : ['xl'];
  const segs = base.slice();
  for (const s of objetivo.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (segs.length === 0) fallar('XLSX_RUTA', 'Relationship target escapes the package');
      segs.pop();
    } else segs.push(s);
  }
  if (segs[0] !== 'xl' || segs.length < 2) fallar('XLSX_RUTA', 'Relationship target is outside xl/');
  return segs.join('/');
}

function parte(partes, nombre) {
  const b = partes.get(nombre);
  if (!b) fallar('XLSX_ESTRUCTURA', `Missing required part ${nombre}`);
  return decodificarParte(b);
}

function leerRelaciones(xml) {
  const rels = new Map();
  for (const t of tokens(xml)) {
    if (t.tipo === 'abre' && t.nombre === 'Relationship') {
      const { Id: id, Target: objetivo, Type: tipo, TargetMode: modo } = t.attrs;
      if (id === undefined || objetivo === undefined) fallar('XLSX_ESTRUCTURA', 'Malformed relationship');
      if (modo !== undefined && modo.toLowerCase() === 'external') fallar('XLSX_RUTA', 'External relationship targets are not allowed');
      rels.set(id, { objetivo, tipo: tipo ?? '' });
    }
  }
  return rels;
}

function leerCompartidas(xml) {
  const lista = [];
  let actual = null;
  let enT = false;
  let fonetico = 0;
  for (const t of tokens(xml)) {
    if (t.tipo === 'abre') {
      if (t.nombre === 'si') actual = '';
      else if (t.nombre === 'rPh') fonetico++;
      else if (t.nombre === 't' && actual !== null && fonetico === 0) enT = true;
    } else if (t.tipo === 'cierra') {
      if (t.nombre === 't') enT = false;
      else if (t.nombre === 'rPh') fonetico = Math.max(0, fonetico - 1);
      else if (t.nombre === 'si') {
        if (actual === null) fallar('XLSX_XML', 'Unbalanced shared string item');
        lista.push(actual);
        actual = null;
        enT = false;
      }
    } else if (enT) {
      actual += t.texto;
      if (actual.length > MAX_CELDA) fallar('XLSX_CELDA', 'Cell text is too long');
    }
  }
  if (actual !== null) fallar('XLSX_XML', 'Unterminated shared string item');
  return lista;
}

function leerHoja(xml, compartidas, presupuesto) {
  const filas = [];
  let fila = -1;
  let enFila = false;
  let col = 0;
  let celda = null;
  let enV = false;
  let enT = false;
  let enIs = false;
  let fonetico = 0;
  for (const t of tokens(xml)) {
    if (t.tipo === 'abre') {
      const nombre = t.nombre;
      if (nombre === 'row') {
        const r = t.attrs.r;
        if (r !== undefined) {
          if (!/^[0-9]{1,9}$/.test(r) || Number(r) < 1) fallar('XLSX_XML', 'Invalid row index');
          fila = Number(r) - 1;
        } else fila += 1;
        if (fila >= MAX_FILAS) fallar('XLSX_FILAS', 'Too many rows');
        enFila = true;
        col = 0;
      } else if (nombre === 'c' && enFila) {
        const ref = t.attrs.r;
        if (ref !== undefined) {
          const m = /^([A-Z]{1,3})([0-9]{1,9})$/.exec(ref);
          if (!m) fallar('XLSX_XML', 'Invalid cell reference');
          col = indiceColumna(m[1]);
        }
        if (col >= MAX_COLUMNAS) fallar('XLSX_COLUMNAS', 'Too many columns');
        celda = { col, tipo: t.attrs.t ?? 'n', v: '', is: '' };
      } else if (celda) {
        if (nombre === 'v') enV = true;
        else if (nombre === 'is') enIs = true;
        else if (nombre === 'rPh') fonetico++;
        else if (nombre === 't' && enIs && fonetico === 0) enT = true;
      }
    } else if (t.tipo === 'cierra') {
      const nombre = t.nombre;
      if (nombre === 'v') enV = false;
      else if (nombre === 't') enT = false;
      else if (nombre === 'is') enIs = false;
      else if (nombre === 'rPh') fonetico = Math.max(0, fonetico - 1);
      else if (nombre === 'row') enFila = false;
      else if (nombre === 'c' && celda) {
        if (++presupuesto.celdas > MAX_CELDAS_TOTAL) fallar('XLSX_FILAS', 'Too many cells in the workbook');
        const valor = valorCelda(celda, compartidas);
        if (valor.length > MAX_CELDA) fallar('XLSX_CELDA', 'Cell text is too long');
        const f = (filas[fila] ??= []);
        while (f.length < celda.col) f.push('');
        f[celda.col] = valor;
        col = celda.col + 1;
        celda = null;
        enV = enT = enIs = false;
        fonetico = 0;
      }
    } else if (celda) {
      if (enV) celda.v += t.texto;
      else if (enT) celda.is += t.texto;
      if (celda.v.length > MAX_CELDA + 64 || celda.is.length > MAX_CELDA + 64) fallar('XLSX_CELDA', 'Cell text is too long');
    }
  }
  const salida = new Array(filas.length);
  for (let i = 0; i < filas.length; i++) salida[i] = filas[i] ?? [];
  return salida;
}

function valorCelda(c, compartidas) {
  switch (c.tipo) {
    case 's': {
      const v = c.v.trim();
      if (v === '') return '';
      if (!/^[0-9]{1,9}$/.test(v)) fallar('XLSX_CELDA', 'Invalid shared string index');
      const s = compartidas[Number(v)];
      if (s === undefined) fallar('XLSX_CELDA', 'Shared string index out of range');
      return s;
    }
    case 'inlineStr': return c.is;
    case 'b': return c.v.trim() === '1' ? 'TRUE' : 'FALSE';
    default: return c.v;
  }
}

export const LIMITES_XLSX = { MAX_FILAS, MAX_COLUMNAS, MAX_CELDA, MAX_FILA_EXCEL, MAX_COL_EXCEL, MAX_CELDAS_TOTAL };
export { fallar, decodificarParte, escTexto, limpiar };

// Opens the package and resolves the declared sheets to their part names.
export function abrirLibro(buf) {
  let partes;
  try {
    partes = leerZip(buf);
  } catch (e) {
    if (e?.codigo) fallar(e.codigo, e.message.replace(/^\[seki-review\/[a-z]+\]\s*/, ''));
    throw e;
  }
  const libro = parte(partes, 'xl/workbook.xml');
  const rels = leerRelaciones(parte(partes, 'xl/_rels/workbook.xml.rels'));
  const declaradas = [];
  for (const t of tokens(libro)) {
    if (t.tipo === 'abre' && t.nombre === 'sheet') {
      const nombre = t.attrs.name;
      const id = atributoId(t.attrs);
      if (nombre === undefined || id === undefined) fallar('XLSX_ESTRUCTURA', 'Malformed sheet entry');
      declaradas.push({ nombre, id, oculta: t.attrs.state === 'hidden' || t.attrs.state === 'veryHidden' });
    }
  }
  if (declaradas.length === 0) fallar('XLSX_ESTRUCTURA', 'Workbook has no sheets');
  if (declaradas.length > MAX_HOJAS) fallar('XLSX_ESTRUCTURA', 'Too many sheets');
  if (new Set(declaradas.map((d) => d.id)).size !== declaradas.length) fallar('XLSX_ESTRUCTURA', 'Duplicate sheet relationship id');

  const resolver = (id) => {
    const rel = rels.get(id);
    if (!rel) fallar('XLSX_ESTRUCTURA', 'Sheet relationship not found');
    const ruta = resolverRuta(rel.objetivo);
    if (!partes.has(ruta)) fallar('XLSX_RUTA', 'Relationship target is not in the archive');
    return ruta;
  };
  return { partes, rels, declaradas, resolver };
}

export function leerXlsx(buf) {
  const { partes, rels, declaradas, resolver } = abrirLibro(buf);

  let compartidas = [];
  for (const rel of rels.values()) {
    if (rel.tipo.endsWith('/sharedStrings')) {
      compartidas = leerCompartidas(decodificarParte(partes.get(resolverRutaExistente(rel.objetivo, partes))));
      break;
    }
  }

  const presupuesto = { celdas: 0 };
  const usadas = new Set();
  const hojas = declaradas.map((d) => {
    const ruta = resolver(d.id);
    if (usadas.has(ruta)) fallar('XLSX_ESTRUCTURA', 'Several sheets share one part');
    usadas.add(ruta);
    return { nombre: d.nombre, oculta: d.oculta, filas: leerHoja(decodificarParte(partes.get(ruta)), compartidas, presupuesto) };
  });
  return { hojas };
}

function resolverRutaExistente(objetivo, partes) {
  const ruta = resolverRuta(objetivo);
  if (!partes.has(ruta)) fallar('XLSX_RUTA', 'Relationship target is not in the archive');
  return ruta;
}
