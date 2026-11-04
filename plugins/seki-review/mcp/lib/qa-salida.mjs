// QA guide files: xlsx (visible QA sheet + hidden _seki signatures), html and pdf under salida/qa.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { secretoQa } from './acceso.mjs';
import { quitar } from './archivos.mjs';
import { conBloqueo, escribirAtomico } from './bloqueo.mjs';
import { dirQa, leerJson, rutaEntregas, rutaExplicacion, rutaGuias, rutaInstantanea } from './cache.mjs';
import { QA_DEFECTO } from './config.mjs';
import { htmlAPdf, rutaChrome } from './pdf.mjs';
import { entregasDesdeCorte, filasDeGuia, firmaFila, fusionesDe, leerGuias, quitarGuia, registrarGuia } from './qa-guia.mjs';
import { contenidoRastreador, fechaLocal } from './rastreador-xlsx.mjs';
import { mapaPrs } from './tablero-entregas.mjs';
import { columnaLetra, escribirXlsx, limpiar } from './xlsx.mjs';

export const FORMATO_SEKI = 'seki-qa-1';
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

// Reserves guia-<date>-<n> by creating its xlsx exclusively: two racing calls never take the same n.
// Ids already registered are skipped even when their files were deleted, so an id is never reused.
function reservar(dir, dia, registrados) {
  for (let n = 1; ; n++) {
    const id = `guia-${dia}-${n}`;
    if (registrados.has(id)) continue;
    try {
      closeSync(openSync(join(dir, `${id}.xlsx`), 'wx'));
      return id;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

// Cut keys use the same cleaned PR ids as the registered rows.
const entregasLimpias = (entregas) => entregas.map((e) => ({ ...e, pistas: e.pistas.map((x) => ({ ...x, prs: x.prs.map(limpiar) })) }));

const filaSeki = (secreto, guia) => (f) => [f.etiqueta, f.portal, f.entrega, JSON.stringify(f.prs), firmaFila(secreto, { guia, etiqueta: f.etiqueta, portal: f.portal, prs: f.prs, entrega: f.entrega })];

// The writer strips XML-invalid characters from every cell: the key fields are cleaned once here so that what is
// signed, registered and written is the same text.
const limpiarClaves = (f) => ({ ...f, etiqueta: limpiar(f.etiqueta), portal: limpiar(f.portal), entrega: limpiar(f.entrega), prs: f.prs.map(limpiar), celdas: f.celdas.map(limpiar) });

function columnasValidas(p) {
  const c = p.qa?.columnas;
  return Array.isArray(c) && ['ID', 'Portal', 'Result'].every((x) => c.includes(x)) ? c : QA_DEFECTO.columnas;
}

// Selection, numbering and registration of one project run under one lock, so two concurrent cuts never share tracks.
export function generarGuia(p, opciones = {}) {
  return conBloqueo(`${rutaGuias(p.salida)}.gen`, () => generar(p, opciones), { esperaMs: 180_000 });
}

async function generar(p, { claves, desde, ahora = new Date(), rastreador = null, chrome, limiteMs } = {}) {
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
  let contenido = rastreador;
  if (contenido === null && p.qa?.rastreador) {
    try {
      contenido = contenidoRastreador(p.qa.rastreador);
    } catch (e) {
      console.error(`[seki-review/qa] Tracker content was not read; the guide is generated without it: ${e?.codigo ?? 'error'}`);
    }
  }
  const filas = filasDeGuia({ entregas, prsPorId, explicaciones, rastreador: contenido, columnas }).map(limpiarClaves);
  if (filas.length === 0) return { id: null, archivos: { xlsx: null, html: null, pdf: null }, filas: 0, pendientes: [], avisoPdf: null, vacia: true };

  const dir = dirQa(p.salida);
  mkdirSync(dir, { recursive: true });
  const id = reservar(dir, fechaLocal(ahora), new Set(leerGuias(p).guias.map((g) => g.id)));
  const rutas = { xlsx: join(dir, `${id}.xlsx`), html: join(dir, `${id}.html`), pdf: join(dir, `${id}.pdf`) };
  let registrada = false;
  try {
    const generado = ahora.toISOString();
    const secreto = secretoQa(p);
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
            [FORMATO_SEKI, id, p.clave, generado],
            ...filas.map(filaSeki(secreto, id)),
          ],
        },
      ],
    });
    escribirAtomico(rutas.xlsx, libro);
    escribirAtomico(rutas.html, htmlGuia({ titulo: `QA guide ${id}`, columnas, filas: filas.map((f) => f.celdas) }));

    const pendientes = [...new Set(filas.filter((f) => f.pendiente).flatMap((f) => f.prs))].sort();
    // Registered before the slow PDF step: an interrupted run leaves a guide that can still be imported.
    await registrarGuia(p, { id, fecha: generado, entregas: [...new Set(filas.map((f) => f.entrega))], filas, fusiones: fusionesDe(entregasLimpias(entregas), new Map([...prsPorId].map(([k, v]) => [limpiar(k), v]))) });
    registrada = true;

    let pdf = null;
    let avisoPdf = null;
    const exe = chrome === undefined ? rutaChrome(p) : chrome;
    if (!exe) avisoPdf = p.qa?.chrome && chrome === undefined ? 'PDF not generated: The configured Chrome path does not exist.' : 'PDF not generated: Chrome was not found (set qa.chrome in proyectos.json).';
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

    return { id, archivos: { xlsx: rutas.xlsx, html: rutas.html, pdf }, filas: filas.length, pendientes, avisoPdf, vacia: false };
  } catch (e) {
    for (const r of Object.values(rutas)) quitar(r);
    quitar(`${rutas.pdf}.tmp.pdf`);
    if (registrada) await quitarGuia(p, id).catch(() => {});
    throw e;
  }
}
