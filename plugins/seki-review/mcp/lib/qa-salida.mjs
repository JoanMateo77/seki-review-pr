// QA guide files: xlsx (visible QA sheet + hidden _seki signatures), html and pdf under salida/qa.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { secretoQa } from './acceso.mjs';
import { escribirAtomico } from './bloqueo.mjs';
import { dirQa, leerJson, rutaEntregas, rutaExplicacion, rutaInstantanea } from './cache.mjs';
import { QA_DEFECTO } from './config.mjs';
import { htmlAPdf, rutaChrome } from './pdf.mjs';
import { entregasDesdeCorte, filasDeGuia, firmaFila, fusionesDe, leerGuias, registrarGuia } from './qa-guia.mjs';
import { mapaPrs } from './tablero-entregas.mjs';
import { columnaLetra, escribirXlsx } from './xlsx.mjs';

export const COLUMNAS_SEKI = ['etiqueta', 'portal', 'entrega', 'prs', 'firma'];
const ANCHOS = [14, 12, 24, 28, 48, 36, 10, 12, 28, 20, 12, 14];
const ANCHO_EXTRA = 16;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function htmlGuia({ titulo, columnas, filas }) {
  const th = columnas.map((c) => `<th>${esc(c)}</th>`).join('');
  const tr = filas.map((f) => `<tr>${f.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(titulo)}</title>
<style>
@page { size: A4 landscape; margin: 10mm }
body { font: 10px/1.35 Arial, sans-serif; margin: 0; color: #111 }
h1 { font-size: 14px; margin: 0 0 8px }
table { border-collapse: collapse; width: 100%; table-layout: auto }
th, td { border: 1px solid #888; padding: 3px 5px; vertical-align: top; text-align: left; white-space: pre-wrap; overflow-wrap: anywhere }
th { background: #e8e8e8 }
thead { display: table-header-group }
tr { break-inside: avoid }
</style></head><body>
<h1>${esc(titulo)}</h1>
<table><thead><tr>${th}</tr></thead><tbody>
${tr}
</tbody></table></body></html>
`;
}

const fechaLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Reserves guia-<date>-<n> by creating its xlsx exclusively: two racing calls never take the same n.
function reservar(dir, dia) {
  for (let n = 1; ; n++) {
    const id = `guia-${dia}-${n}`;
    try {
      closeSync(openSync(join(dir, `${id}.xlsx`), 'wx'));
      return id;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

const quitar = (ruta) => {
  try {
    unlinkSync(ruta);
  } catch { /* not created */ }
};

function columnasValidas(p) {
  const c = p.qa?.columnas;
  return Array.isArray(c) && ['ID', 'Portal', 'Result'].every((x) => c.includes(x)) ? c : QA_DEFECTO.columnas;
}

export async function generarGuia(p, { claves, desde, ahora = new Date(), rastreador = null, chrome, limiteMs } = {}) {
  const columnas = columnasValidas(p);
  const base = leerJson(rutaEntregas(p.salida));
  const prsPorId = mapaPrs(leerJson(rutaInstantanea(p.salida)));
  let entregas = base?.entregas ?? [];
  if (Array.isArray(claves) && claves.length) entregas = entregas.filter((e) => claves.includes(e.clave));
  if (desde === 'ultimo-corte') entregas = entregasDesdeCorte({ entregas, guias: leerGuias(p).guias, prsPorId });

  const explicaciones = new Map();
  for (const pr of prsPorId.values()) {
    const e = leerJson(rutaExplicacion(p.salida, pr.repo, pr.numero));
    if (e) explicaciones.set(pr.id, e);
  }
  const filas = filasDeGuia({ entregas, prsPorId, explicaciones, rastreador, columnas });
  if (filas.length === 0) return { id: null, archivos: { xlsx: null, html: null, pdf: null }, filas: 0, pendientes: [], avisoPdf: null, vacia: true };

  const dir = dirQa(p.salida);
  mkdirSync(dir, { recursive: true });
  const id = reservar(dir, fechaLocal(ahora));
  const rutas = { xlsx: join(dir, `${id}.xlsx`), html: join(dir, `${id}.html`), pdf: join(dir, `${id}.pdf`) };
  const generado = ahora.toISOString();
  const secreto = secretoQa(p);
  try {
    const iResultado = columnas.indexOf('Result');
    const letra = columnaLetra(iResultado);
    const anchos = columnas.map((_, i) => ANCHOS[i] ?? ANCHO_EXTRA);
    const libro = escribirXlsx({
      hojas: [
        {
          nombre: 'QA',
          filas: [columnas, ...filas.map((f) => f.celdas)],
          congelar: true,
          anchos,
          validaciones: [{ rango: `${letra}2:${letra}${filas.length + 1}`, lista: p.qa.resultados }],
        },
        {
          nombre: '_seki',
          oculta: true,
          encabezado: false,
          filas: [
            [id, p.clave, generado],
            ...filas.map((f) => [f.etiqueta, f.portal, f.entrega, JSON.stringify(f.prs), firmaFila(secreto, { guia: id, etiqueta: f.etiqueta, portal: f.portal, prs: f.prs, entrega: f.entrega })]),
          ],
        },
      ],
    });
    escribirAtomico(rutas.xlsx, libro);
    escribirAtomico(rutas.html, htmlGuia({ titulo: `QA guide ${id}`, columnas, filas: filas.map((f) => f.celdas) }));

    let pdf = null;
    let avisoPdf = null;
    const exe = chrome === undefined ? rutaChrome(p) : chrome;
    if (!exe) avisoPdf = 'PDF not generated: Chrome was not found (set qa.chrome in proyectos.json).';
    else {
      const temporal = `${rutas.pdf}.tmp.pdf`;
      quitar(temporal);
      const r = await htmlAPdf(exe, rutas.html, temporal, limiteMs === undefined ? {} : { limiteMs });
      if (r.ok) {
        renameSync(temporal, rutas.pdf);
        pdf = rutas.pdf;
      } else {
        quitar(temporal);
        avisoPdf = `PDF not generated: ${r.motivo}.`;
      }
    }

    const pendientes = [...new Set(filas.filter((f) => f.pendiente).flatMap((f) => f.prs))].sort();
    await registrarGuia(p, { id, fecha: generado, entregas: [...new Set(filas.map((f) => f.entrega))], filas, fusiones: fusionesDe(entregas, prsPorId) });
    return { id, archivos: { xlsx: rutas.xlsx, html: rutas.html, pdf }, filas: filas.length, pendientes, avisoPdf, vacia: false };
  } catch (e) {
    for (const r of Object.values(rutas)) quitar(r);
    quitar(`${rutas.pdf}.tmp.pdf`);
    throw e;
  }
}
