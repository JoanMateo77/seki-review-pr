import { reemplazarEntradas } from './zip.mjs';
import { abrirLibro, decodificarParte, escTexto, fallar, indiceColumna, columnaLetra, limpiar, LIMITES_XLSX } from './xlsx.mjs';

const { MAX_FILAS, MAX_COLUMNAS, MAX_CELDA, MAX_CELDAS_TOTAL } = LIMITES_XLSX;
const ATRIBUTO = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function validarCeldas(celdas) {
  if (!Array.isArray(celdas) || celdas.length > MAX_CELDAS_TOTAL) fallar('XLSX_ESTRUCTURA', 'Invalid cell list');
  const mapa = new Map();
  for (const c of celdas) {
    if (!c || typeof c.ref !== 'string' || typeof c.valor !== 'string') fallar('XLSX_ESTRUCTURA', 'Invalid cell edit');
    const m = /^([A-Z]{1,3})([0-9]{1,7})$/.exec(c.ref);
    if (!m) fallar('XLSX_ESTRUCTURA', 'Invalid cell reference');
    const col = indiceColumna(m[1]);
    const fila = Number(m[2]);
    if (col >= MAX_COLUMNAS || fila < 1 || fila > MAX_FILAS) fallar('XLSX_ESTRUCTURA', 'Cell reference is out of bounds');
    const valor = limpiar(c.valor);
    if (valor.length > MAX_CELDA) fallar('XLSX_CELDA', 'Cell text is too long');
    mapa.set(c.ref, { ref: c.ref, col, fila, valor }); // last wins
  }
  return [...mapa.values()].sort((a, b) => a.fila - b.fila || a.col - b.col);
}

// End index (exclusive) of the start tag beginning at i, honouring quoted values.
function finEtiqueta(xml, i) {
  let q = null;
  for (let p = i + 1; p < xml.length; p++) {
    const ch = xml[p];
    if (q) { if (ch === q) q = null; } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === '>') return p + 1;
  }
  return fallar('XLSX_XML', 'Unterminated start tag');
}

function atributos(etiqueta) {
  const a = {};
  for (const m of etiqueta.matchAll(ATRIBUTO)) a[m[1]] = m[2] ?? m[3];
  return a;
}

function esEtiqueta(xml, i, nombre) {
  if (!xml.startsWith(nombre, i + 1)) return false;
  const c = xml[i + 1 + nombre.length];
  return c === '>' || c === '/' || c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

function escanearFilas(xml, ini, pfx) {
  const filas = [];
  const cierraDatos = `</${pfx}sheetData`;
  let pos = ini;
  let previa = 0;
  for (;;) {
    const lt = xml.indexOf('<', pos);
    if (lt < 0) fallar('XLSX_XML', 'Unterminated sheetData');
    if (xml.startsWith(cierraDatos, lt)) return { filas, cierre: lt };
    if (xml.startsWith('<!--', lt)) {
      const f = xml.indexOf('-->', lt + 4);
      if (f < 0) fallar('XLSX_XML', 'Unterminated comment');
      pos = f + 3;
      continue;
    }
    if (!esEtiqueta(xml, lt, `${pfx}row`)) fallar('XLSX_XML', 'Unexpected element in sheetData');
    const finAbre = finEtiqueta(xml, lt);
    const abre = xml.slice(lt, finAbre);
    const auto = abre.endsWith('/>');
    const at = atributos(abre);
    let r = previa + 1;
    if (at.r !== undefined) {
      if (!/^[0-9]{1,9}$/.test(at.r) || Number(at.r) < 1) fallar('XLSX_XML', 'Invalid row index');
      r = Number(at.r);
    }
    previa = r;
    let fin = finAbre;
    let cierre = finAbre;
    if (!auto) {
      cierre = xml.indexOf(`</${pfx}row>`, finAbre);
      if (cierre < 0) fallar('XLSX_XML', 'Unterminated row');
      fin = cierre + pfx.length + 6;
    }
    filas.push({ r, ini: lt, finAbre, fin, cierre, auto, abre, spans: at.spans });
    pos = fin;
  }
}

function escanearCeldas(xml, fila, pfx) {
  const celdas = [];
  let fin = fila.cierre;
  if (fila.auto) return { celdas, finCeldas: fila.ini };
  let pos = fila.finAbre;
  let col = -1;
  while (pos < fila.cierre) {
    const lt = xml.indexOf('<', pos);
    if (lt < 0 || lt >= fila.cierre) break;
    if (xml.startsWith('<!--', lt)) {
      const f = xml.indexOf('-->', lt + 4);
      if (f < 0) fallar('XLSX_XML', 'Unterminated comment');
      pos = f + 3;
      continue;
    }
    if (!esEtiqueta(xml, lt, `${pfx}c`)) { fin = lt; break; }
    const finAbre = finEtiqueta(xml, lt);
    const abre = xml.slice(lt, finAbre);
    let fc = finAbre;
    if (!abre.endsWith('/>')) {
      const c = xml.indexOf(`</${pfx}c>`, finAbre);
      if (c < 0) fallar('XLSX_XML', 'Unterminated cell');
      fc = c + pfx.length + 4;
    }
    const at = atributos(abre);
    if (at.r !== undefined) {
      const m = /^([A-Z]{1,3})[0-9]{1,9}$/.exec(at.r);
      if (!m) fallar('XLSX_XML', 'Invalid cell reference');
      col = indiceColumna(m[1]);
    } else col += 1;
    celdas.push({ col, ini: lt, fin: fc, s: at.s });
    pos = fc;
  }
  return { celdas, finCeldas: fin };
}

export function editarCeldas(buf, { hoja, celdas } = {}) {
  if (typeof hoja !== 'string' || hoja === '') fallar('XLSX_ESTRUCTURA', 'Sheet name is required');
  const objetivos = validarCeldas(celdas);
  const { partes, declaradas, resolver } = abrirLibro(buf);
  const decl = declaradas.find((d) => d.nombre === hoja);
  if (!decl) fallar('XLSX_HOJA', 'Sheet not found');
  const ruta = resolver(decl.id);
  const bruto = partes.get(ruta);
  const bom = bruto.length >= 3 && bruto[0] === 0xef && bruto[1] === 0xbb && bruto[2] === 0xbf;
  if (objetivos.length === 0) return Buffer.from(buf);
  const xml = decodificarParte(bruto);

  const dato = /<(?:([A-Za-z_][\w.-]*):)?sheetData(?=[\s/>])/.exec(xml);
  if (!dato) fallar('XLSX_ESTRUCTURA', 'Sheet has no sheetData');
  const pfx = dato[1] ? `${dato[1]}:` : '';
  const datosIni = dato.index;
  const finAbreDatos = finEtiqueta(xml, datosIni);
  const datosAuto = xml.slice(datosIni, finAbreDatos).endsWith('/>');
  const { filas, cierre } = datosAuto ? { filas: [], cierre: finAbreDatos } : escanearFilas(xml, finAbreDatos, pfx);

  const porFila = new Map();
  for (const o of objetivos) {
    if (!porFila.has(o.fila)) porFila.set(o.fila, []);
    porFila.get(o.fila).push(o);
  }
  const filaPorNumero = new Map();
  for (const f of filas) if (!filaPorNumero.has(f.r)) filaPorNumero.set(f.r, f);
  const cacheCeldas = new Map();
  const celdasDe = (f) => {
    if (!cacheCeldas.has(f)) cacheCeldas.set(f, escanearCeldas(xml, f, pfx));
    return cacheCeldas.get(f);
  };
  const estiloArriba = (fila, col) => {
    const arriba = filas.filter((f) => f.r < fila).sort((x, y) => y.r - x.r);
    for (const f of arriba) {
      const c = celdasDe(f).celdas.find((x) => x.col === col);
      if (c) return c.s !== undefined && /^[0-9]+$/.test(c.s) ? c.s : undefined;
    }
    return undefined;
  };

  const celdaXml = (o, s) => `<${pfx}c r="${o.ref}"${s !== undefined ? ` s="${s}"` : ''} t="inlineStr"><${pfx}is><${pfx}t xml:space="preserve">${escTexto(o.valor)}</${pfx}t></${pfx}is></${pfx}c>`;
  const cortes = [];
  let seq = 0;
  const cortar = (ini, fin, texto) => cortes.push({ ini, fin, texto, seq: seq++ });

  let maxFila = 0;
  let maxCol = 0;
  let minFila = Infinity;
  let minCol = Infinity;
  for (const [numFila, lista] of porFila) {
    maxFila = Math.max(maxFila, numFila);
    minFila = Math.min(minFila, numFila);
    for (const o of lista) { maxCol = Math.max(maxCol, o.col); minCol = Math.min(minCol, o.col); }
    const fila = filaPorNumero.get(numFila);
    if (!fila) {
      const sig = filas.find((f) => f.r > numFila);
      const cuerpo = lista.map((o) => celdaXml(o, estiloArriba(numFila, o.col))).join('');
      cortar(sig ? sig.ini : cierre, sig ? sig.ini : cierre, `<${pfx}row r="${numFila}">${cuerpo}</${pfx}row>`);
      continue;
    }
    const { celdas: existentes, finCeldas } = celdasDe(fila);
    const nuevas = [];
    for (const o of lista) {
      const previa = existentes.find((c) => c.col === o.col);
      if (previa) {
        const s = previa.s !== undefined && /^[0-9]+$/.test(previa.s) ? previa.s : undefined;
        cortar(previa.ini, previa.fin, celdaXml(o, s));
        continue;
      }
      const sig = existentes.find((c) => c.col > o.col);
      const texto = celdaXml(o, estiloArriba(numFila, o.col));
      if (fila.auto) nuevas.push(texto);
      else cortar(sig ? sig.ini : finCeldas, sig ? sig.ini : finCeldas, texto);
    }
    let abre = fila.abre;
    if (fila.spans !== undefined) {
      const m = /^([0-9]+):([0-9]+)$/.exec(fila.spans);
      if (m) {
        const a = Math.min(Number(m[1]), minColDe(lista) + 1);
        const b = Math.max(Number(m[2]), maxColDe(lista) + 1);
        if (a !== Number(m[1]) || b !== Number(m[2])) {
          const re = /(\sspans\s*=\s*)(["'])[^"']*\2/;
          const mm = re.exec(abre);
          if (mm) abre = abre.slice(0, mm.index) + `${mm[1]}${mm[2]}${a}:${b}${mm[2]}` + abre.slice(mm.index + mm[0].length);
        }
      }
    }
    if (fila.auto) {
      cortar(fila.ini, fila.fin, `${abre.replace(/\s*\/>$/, '>')}${nuevas.join('')}</${pfx}row>`);
    } else if (abre !== fila.abre) {
      cortar(fila.ini, fila.finAbre, abre);
    }
  }

  const dim = /<(?:[A-Za-z_][\w.-]*:)?dimension(?=[\s/>])[^>]*>/.exec(xml);
  if (dim) {
    const re = /(\sref\s*=\s*)(["'])([^"']*)\2/;
    const mm = re.exec(dim[0]);
    const r = mm && /^([A-Z]{1,3})([0-9]{1,7})(?::([A-Z]{1,3})([0-9]{1,7}))?$/.exec(mm[3]);
    if (r) {
      let c1 = indiceColumna(r[1]);
      let r1 = Number(r[2]);
      let c2 = r[3] ? indiceColumna(r[3]) : c1;
      let r2 = r[4] ? Number(r[4]) : r1;
      const antes = `${c1},${r1},${c2},${r2}`;
      c1 = Math.min(c1, minCol); r1 = Math.min(r1, minFila);
      c2 = Math.max(c2, maxCol); r2 = Math.max(r2, maxFila);
      if (antes !== `${c1},${r1},${c2},${r2}`) {
        const nuevo = `${columnaLetra(c1)}${r1}:${columnaLetra(c2)}${r2}`;
        const ini = dim.index + mm.index + mm[1].length;
        cortar(ini, ini + mm[0].length - mm[1].length, `${mm[2]}${nuevo}${mm[2]}`);
      }
    }
  }

  if (datosAuto) {
    // <sheetData/> becomes a populated element (no existing rows, so every cut is an insertion at `cierre`).
    const cuerpo = cortes.filter((c) => c.ini === cierre).sort((a, b) => a.seq - b.seq).map((c) => c.texto).join('');
    const resto = cortes.filter((c) => c.ini !== cierre);
    cortes.length = 0;
    cortes.push(...resto, { ini: datosIni, fin: finAbreDatos, texto: `${xml.slice(datosIni, finAbreDatos).replace(/\s*\/>$/, '>')}${cuerpo}</${pfx}sheetData>`, seq: seq++ });
  }

  cortes.sort((a, b) => a.ini - b.ini || a.seq - b.seq);
  const trozos = [];
  let cursor = 0;
  for (const c of cortes) {
    if (c.ini < cursor) fallar('XLSX_XML', 'Overlapping edits');
    trozos.push(xml.slice(cursor, c.ini), c.texto);
    cursor = c.fin;
  }
  trozos.push(xml.slice(cursor));
  const salida = Buffer.from(trozos.join(''), 'utf8');
  const datos = bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), salida]) : salida;
  return reemplazarEntradas(buf, new Map([[ruta, datos]]));
}

function minColDe(lista) { return Math.min(...lista.map((o) => o.col)); }
function maxColDe(lista) { return Math.max(...lista.map((o) => o.col)); }
