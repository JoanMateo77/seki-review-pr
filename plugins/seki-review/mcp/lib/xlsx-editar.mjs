import { reemplazarEntradas } from './zip.mjs';
import { abrirLibro, decodificarParte, escTexto, fallar, indiceColumna, columnaLetra, leerRelaciones, limpiar, resolverRuta, LIMITES_XLSX } from './xlsx.mjs';

const { MAX_FILAS, MAX_COLUMNAS, MAX_CELDA, MAX_CELDAS_TOTAL } = LIMITES_XLSX;
const ATRIBUTO = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const RANGO = /^([A-Z]{1,3})([0-9]{1,7})(?::([A-Z]{1,3})([0-9]{1,7}))?$/;
const ESTILO = /^[0-9]+$/;

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

function rango(texto) {
  const r = RANGO.exec(texto ?? '');
  if (!r) return null;
  const c1 = indiceColumna(r[1]);
  const r1 = Number(r[2]);
  return { c1, r1, c2: r[3] ? indiceColumna(r[3]) : c1, r2: r[4] ? Number(r[4]) : r1 };
}

const textoRango = (g) => `${columnaLetra(g.c1)}${g.r1}:${columnaLetra(g.c2)}${g.r2}`;

function escanearFilas(xml, ini) {
  const filas = [];
  let pos = ini;
  let previa = 0;
  for (;;) {
    const lt = xml.indexOf('<', pos);
    if (lt < 0) fallar('XLSX_XML', 'Unterminated sheetData');
    if (xml.startsWith('</sheetData', lt)) return { filas, cierre: lt };
    if (xml.startsWith('<!--', lt)) {
      const f = xml.indexOf('-->', lt + 4);
      if (f < 0) fallar('XLSX_XML', 'Unterminated comment');
      pos = f + 3;
      continue;
    }
    if (!esEtiqueta(xml, lt, 'row')) fallar('XLSX_XML', 'Unexpected element in sheetData');
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
      cierre = xml.indexOf('</row>', finAbre);
      if (cierre < 0) fallar('XLSX_XML', 'Unterminated row');
      fin = cierre + 6;
    }
    filas.push({ r, ini: lt, finAbre, fin, cierre, auto, abre, spans: at.spans, s: at.s, formato: at.customFormat });
    pos = fin;
  }
}

function escanearCeldas(xml, fila) {
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
    if (!esEtiqueta(xml, lt, 'c')) { fin = lt; break; }
    const finAbre = finEtiqueta(xml, lt);
    const abre = xml.slice(lt, finAbre);
    let fc = finAbre;
    if (!abre.endsWith('/>')) {
      const c = xml.indexOf('</c>', finAbre);
      if (c < 0) fallar('XLSX_XML', 'Unterminated cell');
      fc = c + 4;
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

// Keeps the sheet's _xlnm._FilterDatabase defined name in step with its autoFilter range; null when nothing changes.
function sincronizarFiltro(brutoLibro, indiceHoja, ultimaFila) {
  const bom = brutoLibro.length >= 3 && brutoLibro[0] === 0xef && brutoLibro[1] === 0xbb && brutoLibro[2] === 0xbf;
  const xml = decodificarParte(brutoLibro);
  for (const m of xml.matchAll(/<definedName\b[^>]*>[^<]*<\/definedName>/g)) {
    const abre = m[0].slice(0, m[0].indexOf('>') + 1);
    const at = atributos(abre);
    if (at.name !== '_xlnm._FilterDatabase' || at.localSheetId !== String(indiceHoja)) continue;
    const valor = m[0].slice(abre.length, m[0].length - '</definedName>'.length);
    const filaFinal = /([0-9]+)$/.exec(valor);
    if (!filaFinal || !/\$$/.test(valor.slice(0, filaFinal.index))) return null;
    const nuevo = valor.slice(0, filaFinal.index) + String(ultimaFila);
    const ini = m.index + abre.length;
    const salida = Buffer.from(xml.slice(0, ini) + nuevo + xml.slice(ini + valor.length), 'utf8');
    return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), salida]) : salida;
  }
  return null;
}

// Table ranges referenced by the sheet's <tableParts>, read through the sheet's own rels.
function leerTablas(partes, xml, ruta) {
  if (!/<tableParts[\s/>]/.test(xml)) return [];
  const partidos = ruta.split('/');
  const nombre = partidos.pop();
  const desde = partidos;
  const relsRuta = `${desde.join('/')}/_rels/${nombre}.rels`;
  if (!partes.has(relsRuta)) fallar('XLSX_ESTRUCTURA', 'Sheet relationships are missing');
  const rels = leerRelaciones(decodificarParte(partes.get(relsRuta)));
  const tablas = [];
  for (const m of xml.matchAll(/<tablePart\b[^>]*>/g)) {
    const at = atributos(m[0]);
    const id = at['r:id'] ?? Object.entries(at).find(([k]) => k.endsWith(':id'))?.[1];
    const rel = id === undefined ? undefined : rels.get(id);
    if (!rel) fallar('XLSX_ESTRUCTURA', 'Table relationship not found');
    const tr = resolverRuta(rel.objetivo, desde);
    if (!partes.has(tr)) fallar('XLSX_RUTA', 'Relationship target is not in the archive');
    const raiz = /<table(?=[\s>])[^>]*>/.exec(decodificarParte(partes.get(tr)));
    const ta = raiz ? atributos(raiz[0]) : {};
    const g = rango(ta.ref);
    if (!g) fallar('XLSX_ESTRUCTURA', 'Table has no valid range');
    tablas.push({ ...g, cabecera: ta.headerRowCount !== '0' });
  }
  return tablas;
}

export function editarCeldas(buf, { hoja, celdas, filaEncabezado = 1 } = {}) {
  if (typeof hoja !== 'string' || hoja === '') fallar('XLSX_ESTRUCTURA', 'Sheet name is required');
  if (!Number.isInteger(filaEncabezado) || filaEncabezado < 0 || filaEncabezado > MAX_FILAS) fallar('XLSX_ESTRUCTURA', 'Invalid header row');
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
  if (dato[1]) fallar('XLSX_ESTRUCTURA', 'Prefixed sheet elements are not supported');
  const datosIni = dato.index;
  const finAbreDatos = finEtiqueta(xml, datosIni);
  const datosAuto = xml.slice(datosIni, finAbreDatos).endsWith('/>');
  const { filas, cierre } = datosAuto ? { filas: [], cierre: finAbreDatos } : escanearFilas(xml, finAbreDatos);

  const porFila = new Map();
  for (const o of objetivos) {
    if (!porFila.has(o.fila)) porFila.set(o.fila, []);
    porFila.get(o.fila).push(o);
  }
  const filaPorNumero = new Map();
  for (const f of filas) if (!filaPorNumero.has(f.r)) filaPorNumero.set(f.r, f);

  const tablas = leerTablas(partes, xml, ruta);
  for (const o of objetivos) {
    for (const t of tablas) {
      const dentroCol = o.col >= t.c1 && o.col <= t.c2;
      if (t.cabecera && o.fila === t.r1 && dentroCol) fallar('XLSX_TABLA', 'Table header cells cannot be edited');
    }
    if (tablas.length > 0 && !filaPorNumero.has(o.fila) && !tablas.some((t) => o.fila >= t.r1 && o.fila <= t.r2)) {
      fallar('XLSX_TABLA', 'Rows cannot be appended outside a table range');
    }
  }

  const cacheCeldas = new Map();
  const celdasDe = (f) => {
    if (!cacheCeldas.has(f)) cacheCeldas.set(f, escanearCeldas(xml, f));
    return cacheCeldas.get(f);
  };
  const descendentes = [...filas].sort((a, b) => b.r - a.r);
  let columnas = null;
  const estiloColumna = (col) => {
    columnas ??= [...(/<cols>[\s\S]*?<\/cols>/.exec(xml)?.[0] ?? '').matchAll(/<col\b[^>]*>/g)].map((m) => atributos(m[0]));
    const c = columnas.find((a) => Number(a.min) <= col + 1 && col + 1 <= Number(a.max));
    return c && ESTILO.test(c.style ?? '') ? c.style : undefined;
  };
  // Row style (customFormat), then column style, then the cell above below the header row, else none.
  const estiloNuevo = (numFila, col, fila) => {
    if (fila && fila.formato === '1' && ESTILO.test(fila.s ?? '')) return fila.s;
    const deColumna = estiloColumna(col);
    if (deColumna !== undefined) return deColumna;
    let lo = 0;
    let hi = descendentes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (descendentes[mid].r < numFila) hi = mid; else lo = mid + 1;
    }
    for (let i = lo; i < descendentes.length && descendentes[i].r > filaEncabezado; i++) {
      const c = celdasDe(descendentes[i]).celdas.find((x) => x.col === col);
      if (c) return c.s !== undefined && ESTILO.test(c.s) ? c.s : undefined;
    }
    return undefined;
  };

  const celdaXml = (o, s) => `<c r="${o.ref}"${s !== undefined ? ` s="${s}"` : ''} t="inlineStr"><is><t xml:space="preserve">${escTexto(o.valor)}</t></is></c>`;
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
    const minL = lista[0].col;
    const maxL = lista[lista.length - 1].col;
    const fila = filaPorNumero.get(numFila);
    if (!fila) {
      const sig = filas.find((f) => f.r > numFila);
      const previa = descendentes.find((f) => f.r < numFila);
      const conSpans = sig?.spans !== undefined || previa?.spans !== undefined;
      const cuerpo = lista.map((o) => celdaXml(o, estiloNuevo(numFila, o.col, null))).join('');
      const pos = sig ? sig.ini : cierre;
      cortar(pos, pos, `<row r="${numFila}"${conSpans ? ` spans="${minL + 1}:${maxL + 1}"` : ''}>${cuerpo}</row>`);
      continue;
    }
    const { celdas: existentes, finCeldas } = celdasDe(fila);
    const nuevas = [];
    for (const o of lista) {
      const previa = existentes.find((c) => c.col === o.col);
      if (previa) {
        if (/<f[\s/>]/.test(xml.slice(previa.ini, previa.fin))) fallar('XLSX_FORMULA', 'Formula cells cannot be overwritten');
        cortar(previa.ini, previa.fin, celdaXml(o, previa.s !== undefined && ESTILO.test(previa.s) ? previa.s : undefined));
        continue;
      }
      const sig = existentes.find((c) => c.col > o.col);
      const texto = celdaXml(o, estiloNuevo(numFila, o.col, fila));
      if (fila.auto) nuevas.push(texto);
      else cortar(sig ? sig.ini : finCeldas, sig ? sig.ini : finCeldas, texto);
    }
    let abre = fila.abre;
    const m = fila.spans === undefined ? null : /^([0-9]+):([0-9]+)$/.exec(fila.spans);
    if (m) {
      const a = Math.min(Number(m[1]), minL + 1);
      const b = Math.max(Number(m[2]), maxL + 1);
      if (a !== Number(m[1]) || b !== Number(m[2])) {
        const mm = /(\sspans\s*=\s*)(["'])[^"']*\2/.exec(abre);
        if (mm) abre = abre.slice(0, mm.index) + `${mm[1]}${mm[2]}${a}:${b}${mm[2]}` + abre.slice(mm.index + mm[0].length);
      }
    }
    if (fila.auto) cortar(fila.ini, fila.fin, `${abre.replace(/\s*\/>$/, '>')}${nuevas.join('')}</row>`);
    else if (abre !== fila.abre) cortar(fila.ini, fila.finAbre, abre);
  }

  let libroNuevo = null;
  const cortarRef = (etiqueta, nuevoRango) => {
    const re = /(\sref\s*=\s*)(["'])([^"']*)\2/;
    const mm = re.exec(etiqueta.texto);
    const ini = etiqueta.index + mm.index + mm[1].length;
    cortar(ini, ini + mm[0].length - mm[1].length, `${mm[2]}${nuevoRango}${mm[2]}`);
  };
  const buscar = (re) => {
    const e = re.exec(xml);
    return e && /\sref\s*=/.test(e[0]) ? { texto: e[0], index: e.index } : null;
  };

  const dim = buscar(/<dimension(?=[\s/>])[^>]*>/);
  const gd = dim && rango(/\sref\s*=\s*["']([^"']*)["']/.exec(dim.texto)?.[1]);
  if (gd) {
    const nuevo = { c1: Math.min(gd.c1, minCol), r1: Math.min(gd.r1, minFila), c2: Math.max(gd.c2, maxCol), r2: Math.max(gd.r2, maxFila) };
    if (textoRango(nuevo) !== textoRango(gd)) cortarRef(dim, textoRango(nuevo));
  }

  // The contiguous run of rows right below the autoFilter range stays inside it when the run holds an edit.
  const filtro = buscar(/<autoFilter(?=[\s/>])[^>]*>/);
  const gf = filtro && rango(/\sref\s*=\s*["']([^"']*)["']/.exec(filtro.texto)?.[1]);
  if (gf) {
    let ultima = gf.r2;
    let editada = false;
    while (filaPorNumero.has(ultima + 1) || porFila.has(ultima + 1)) {
      ultima += 1;
      editada ||= porFila.has(ultima);
    }
    if (!editada) ultima = gf.r2;
    if (ultima !== gf.r2) {
      cortarRef(filtro, textoRango({ ...gf, r2: ultima }));
      libroNuevo = sincronizarFiltro(partes.get('xl/workbook.xml'), declaradas.indexOf(decl), ultima);
    }
  }

  if (datosAuto) {
    // <sheetData/> becomes a populated element: every row cut is an insertion at `cierre`.
    const cuerpo = cortes.filter((c) => c.ini === cierre).sort((a, b) => a.seq - b.seq).map((c) => c.texto).join('');
    const resto = cortes.filter((c) => c.ini !== cierre);
    cortes.length = 0;
    cortes.push(...resto, { ini: datosIni, fin: finAbreDatos, texto: `${xml.slice(datosIni, finAbreDatos).replace(/\s*\/>$/, '>')}${cuerpo}</sheetData>`, seq: seq++ });
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
  const cambios = new Map([[ruta, datos]]);
  if (libroNuevo !== null) cambios.set('xl/workbook.xml', libroNuevo);
  return reemplazarEntradas(buf, cambios);
}
