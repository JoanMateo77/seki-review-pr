import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { derivarEntregas } from '../mcp/lib/recolectar.mjs';
import { escribirJson, leerJson, rutaEntregas, rutaInstantanea } from '../mcp/lib/cache.mjs';
import { ENTREGAS_DEFECTO, QA_DEFECTO } from '../mcp/lib/config.mjs';
import { leerEventos } from '../mcp/lib/eventos.mjs';
import { leerGuias, qaDeEventos } from '../mcp/lib/qa-guia.mjs';
import { analizarImportacion, importarQa } from '../mcp/lib/qa-importar.mjs';
import { generarGuia } from '../mcp/lib/qa-salida.mjs';
import { escribirXlsx, leerXlsx } from '../mcp/lib/xlsx.mjs';
import { editarCeldas } from '../mcp/lib/xlsx-editar.mjs';
import { crearZip } from '../mcp/lib/zip.mjs';
import { trackerFixture } from './util/xlsx-fixture.mjs';

const temporales = [];
after(() => { for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true }); });

const GUIA = new Date('2026-11-04T12:00:00');
const T1 = new Date('2026-11-05T10:00:00Z');
const T2 = new Date('2026-11-05T11:00:00Z');
const pr = (n, portal) => ({
  id: `r#${n}`, repo: 'r', numero: n, portal, ambiente: 'pruebas', estadoPr: 'MERGED', mergeada: '2026-11-01T10:00:00Z',
  titulo: 'Fix login X-001 X-002', ramaOrigen: 'fix/login', base: `t${portal}`, descripcion: `## How to test\n- Open the screen ${n}`,
});

// Rows are generated in this order: X-001/p1, X-002/p1, X-001/p2, X-002/p2 (visible rows 2 to 5).
async function escenario() {
  const dir = mkdtempSync(join(tmpdir(), 'seki-qa-imp-'));
  temporales.push(dir);
  const salida = join(dir, 'salida');
  mkdirSync(join(salida, 'datos'), { recursive: true });
  const p = {
    clave: 't', owner: 'o', salida, qa: structuredClone(QA_DEFECTO), entregas: { ...ENTREGAS_DEFECTO, patronId: 'X-\\d+' },
    repos: { r: { lineas: [{ portal: 'p1', prod: 'mp1', pruebas: 'tp1' }, { portal: 'p2', prod: 'mp2', pruebas: 'tp2' }] } },
  };
  const foto = { prs: [pr(1, 'p1'), pr(2, 'p2')], recientes: [] };
  escribirJson(rutaInstantanea(salida), foto);
  await derivarEntregas(p, foto);
  const g = await generarGuia(p, { ahora: GUIA, chrome: null });
  return { p, foto, guia: g, buf: readFileSync(g.archivos.xlsx), ruta: g.archivos.xlsx };
}
const rellenar = (buf, mapa, tester) => editarCeldas(buf, {
  hoja: 'QA',
  celdas: Object.entries(mapa).flatMap(([fila, v]) => [{ ref: `H${fila}`, valor: v }, ...(tester ? [{ ref: `L${fila}`, valor: tester }] : [])]),
});
const etapas = (p) => Object.fromEntries(leerJson(rutaEntregas(p.salida)).entregas.flatMap((e) => e.pistas.map((x) => [x.portal, x.etapa])));
const conMotivos = (r) => r.rechazadas.map((x) => x.motivo);

test('round trip: all OK registers events with the signed key and moves the delivery to ready for production', async () => {
  const { p, buf, guia } = await escenario();
  assert.deepEqual(etapas(p), { p1: 'esperando_qa', p2: 'esperando_qa' });
  const r = await importarQa(p, { buf: rellenar(buf, { 2: 'OK', 3: ' ok ', 4: 'N/A', 5: 'OK' }, 'Ana'), ahora: T1 });
  assert.equal(r.guia, guia.id);
  assert.equal(r.nuevos, 4);
  assert.deepEqual(r.rechazadas, []);
  assert.deepEqual(r.resumen.map((x) => [x.portal, x.resultado, x.filas]).sort(), [['p1', 'ok', 2], ['p2', 'ok', 2]]);
  assert.deepEqual(r.rastreador, { escrito: false, motivo: 'No tracker configured' });
  const ev = leerEventos(p).filter((e) => e.tipo === 'qa_resultado');
  assert.equal(ev.length, 4);
  assert.equal(ev[0].ts, T1.toISOString());
  assert.equal(ev[0].tester, 'Ana');
  assert.equal(ev[0].origen, 'qa');
  assert.match(ev[0].id, /^[0-9a-f]{64}$/);
  assert.deepEqual(ev.map((e) => e.resultado).sort(), ['na', 'ok', 'ok', 'ok']);
  assert.deepEqual(etapas(p), { p1: 'listo_produccion', p2: 'listo_produccion' });
});

test('mixed tracks: portal A OK and portal B Fail leaves the delivery in qa_fallo', async () => {
  const { p, buf } = await escenario();
  const r = await importarQa(p, { buf: rellenar(buf, { 2: 'OK', 3: 'OK', 4: 'Fail', 5: 'OK' }), ahora: T1 });
  assert.deepEqual(r.resumen.map((x) => [x.portal, x.resultado]).sort(), [['p1', 'ok'], ['p2', 'fallo']]);
  assert.deepEqual(etapas(p), { p1: 'listo_produccion', p2: 'qa_fallo' });
  assert.equal(leerJson(rutaEntregas(p.salida)).entregas[0].etapa, 'qa_fallo');
});

test('a track with rows still pending stays waiting for QA', async () => {
  const { p, buf } = await escenario();
  const r = await importarQa(p, { buf: rellenar(buf, { 2: 'OK', 4: 'OK', 5: 'Pending' }), ahora: T1 });
  assert.equal(r.nuevos, 2);
  assert.deepEqual(r.resumen.map((x) => [x.portal, x.resultado]).sort(), [['p1', 'pendiente'], ['p2', 'pendiente']]);
  assert.deepEqual(etapas(p), { p1: 'esperando_qa', p2: 'esperando_qa' });
});

test('rows sorted in another order and one deleted still map by key', async () => {
  const { p, buf } = await escenario();
  const llena = rellenar(buf, { 2: 'OK', 3: 'OK', 4: 'OK', 5: 'OK' });
  const libro = leerXlsx(llena);
  const qa = libro.hojas.find((h) => h.nombre === 'QA');
  const seki = libro.hojas.find((h) => h.nombre === '_seki');
  const filas = [qa.filas[0], ...qa.filas.slice(1).reverse().slice(1)]; // reversed, the last original row (X-002/p2... first after reverse) dropped
  const reconstruido = escribirXlsx({ hojas: [{ nombre: 'QA', filas }, { nombre: '_seki', oculta: true, encabezado: false, filas: seki.filas }] });
  const r = await importarQa(p, { buf: reconstruido, ahora: T1 });
  assert.equal(r.nuevos, 3);
  assert.deepEqual(r.rechazadas, []);
  assert.equal(etapas(p).p1, 'listo_produccion');
  assert.equal(etapas(p).p2, 'esperando_qa');
});

// Mimics an Excel re-save: shared strings, the hidden sheet marked hidden, formatted workbook.
function reguardarComoExcel(buf) {
  const libro = leerXlsx(buf);
  const compartidas = [];
  const idx = (v) => {
    let i = compartidas.indexOf(v);
    if (i < 0) i = compartidas.push(v) - 1;
    return i;
  };
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ref = (c, r) => `${String.fromCharCode(65 + c)}${r}`;
  const hojas = libro.hojas.map((h) => `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${h.filas.map((f, ri) => `<row r="${ri + 1}">${f.map((v, ci) => (v === '' ? '' : `<c r="${ref(ci, ri + 1)}" t="s"><v>${idx(v)}</v></c>`)).join('')}</row>`).join('')}</sheetData></worksheet>`);
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return crearZip([
    { nombre: '[Content_Types].xml', datos: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>' },
    { nombre: '_rels/.rels', datos: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { nombre: 'xl/workbook.xml', datos: `<?xml version="1.0"?><workbook xmlns="${NS}" xmlns:r="${R}"><sheets>${libro.hojas.map((h, i) => `<sheet name="${h.nombre}" sheetId="${i + 1}"${h.oculta ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { nombre: 'xl/_rels/workbook.xml.rels', datos: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${libro.hojas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId9" Type="${R}/sharedStrings" Target="sharedStrings.xml"/></Relationships>` },
    ...hojas.map((x, i) => ({ nombre: `xl/worksheets/sheet${i + 1}.xml`, datos: x })),
    { nombre: 'xl/sharedStrings.xml', datos: `<?xml version="1.0"?><sst xmlns="${NS}" count="${compartidas.length}" uniqueCount="${compartidas.length}">${compartidas.map((v) => `<si><t xml:space="preserve">${esc(v)}</t></si>`).join('')}</sst>` },
  ]);
}

test('an Excel-style re-save of the filled guide still maps', async () => {
  const { p, buf } = await escenario();
  const r = await importarQa(p, { buf: reguardarComoExcel(rellenar(buf, { 2: 'OK', 3: 'OK', 4: 'OK', 5: 'OK' })), ahora: T1 });
  assert.equal(r.nuevos, 4);
  assert.deepEqual(r.rechazadas, []);
  assert.deepEqual(etapas(p), { p1: 'listo_produccion', p2: 'listo_produccion' });
});

test('a tampered ID cell or signature is rejected and records nothing', async () => {
  const { p, buf } = await escenario();
  const llena = editarCeldas(rellenar(buf, { 2: 'OK', 3: 'OK' }), { hoja: 'QA', celdas: [{ ref: 'A2', valor: 'X-009' }] });
  const r = await importarQa(p, { buf: llena, ahora: T1 });
  assert.deepEqual(conMotivos(r), ['Row key does not match the guide']);
  assert.equal(r.nuevos, 1);

  const firma = editarCeldas(rellenar(buf, { 2: 'OK' }), { hoja: '_seki', filaEncabezado: 0, celdas: [{ ref: 'E2', valor: 'deadbeef' }] });
  const r2 = await importarQa(p, { buf: firma, ahora: T2 });
  assert.deepEqual(conMotivos(r2), ['Row key does not match the guide']);
  assert.equal(r2.nuevos, 0);
});

test('unknown guide, other project, missing hidden sheet and unknown result text', async () => {
  const { p, buf } = await escenario();
  const llena = rellenar(buf, { 2: 'OK' });
  const codigo = async (b) => { try { await importarQa(p, { buf: b, ahora: T1 }); } catch (e) { return [e.codigo, e.message]; } return null; };
  const [c1, m1] = await codigo(editarCeldas(llena, { hoja: '_seki', filaEncabezado: 0, celdas: [{ ref: 'B1', valor: 'guia-9999-1' }] }));
  assert.equal(c1, 'QA_GUIA');
  assert.match(m1, /^\[seki-review\/qa\]/);
  assert.equal((await codigo(editarCeldas(llena, { hoja: '_seki', filaEncabezado: 0, celdas: [{ ref: 'C1', valor: 'otro' }] })))[0], 'QA_GUIA');
  assert.equal((await codigo(editarCeldas(llena, { hoja: '_seki', filaEncabezado: 0, celdas: [{ ref: 'A1', valor: 'seki-qa-9' }] })))[0], 'QA_GUIA');
  assert.equal((await codigo(escribirXlsx({ hojas: [{ nombre: 'QA', filas: [['ID'], ['X']] }] })))[0], 'QA_GUIA');
  const r = await importarQa(p, { buf: rellenar(buf, { 2: 'Maybe' }), ahora: T1 });
  assert.deepEqual(conMotivos(r), ['Unrecognised result']);
  assert.equal(r.nuevos, 0);
});

test('the same file twice adds no events', async () => {
  const { p, buf } = await escenario();
  const llena = rellenar(buf, { 2: 'OK', 3: 'OK', 4: 'OK', 5: 'OK' });
  assert.equal((await importarQa(p, { buf: llena, ahora: T1 })).nuevos, 4);
  const otra = await importarQa(p, { buf: llena, ahora: T2 });
  assert.equal(otra.nuevos, 0);
  assert.deepEqual(otra.rechazadas, []);
  assert.equal(leerEventos(p).filter((e) => e.tipo === 'qa_resultado').length, 4);
});

test('a corrected file (Fail then OK) turns the track from failed to ready', async () => {
  const { p, buf } = await escenario();
  await importarQa(p, { buf: rellenar(buf, { 2: 'Fail', 3: 'OK', 4: 'OK', 5: 'OK' }), ahora: T1 });
  assert.equal(etapas(p).p1, 'qa_fallo');
  await importarQa(p, { buf: rellenar(buf, { 2: 'OK', 3: 'OK', 4: 'OK', 5: 'OK' }), ahora: T2 });
  assert.deepEqual(etapas(p), { p1: 'listo_produccion', p2: 'listo_produccion' });
  const pista = { portal: 'p1', prs: ['r#1'] };
  const qa = qaDeEventos(leerEventos(p), leerGuias(p).guias)({}, pista);
  assert.equal(qa.resultado, 'ok');
  assert.equal(qa.ts, T2.toISOString());
});

test('a testing merge after the guide rejects the rows with the new-guide reason', async () => {
  const { p, foto, buf } = await escenario();
  foto.prs[0].mergeada = '2026-11-06T10:00:00Z';
  escribirJson(rutaInstantanea(p.salida), foto);
  const r = await importarQa(p, { buf: rellenar(buf, { 2: 'OK', 3: 'OK', 4: 'OK', 5: 'OK' }), ahora: T1 });
  assert.deepEqual(conMotivos(r), Array(2).fill('New testing merge after the guide: generate a new guide'));
  assert.deepEqual(r.rechazadas.map((x) => x.portal), ['p1', 'p1']);
  assert.equal(r.nuevos, 2);
});

test('a Blocked row keeps the delivery waiting and raises qa_bloqueada', async () => {
  const { p, buf } = await escenario();
  const r = await importarQa(p, { buf: rellenar(buf, { 2: 'Blocked', 3: 'OK', 4: 'OK', 5: 'OK' }), ahora: T1 });
  assert.equal(r.resumen.find((x) => x.portal === 'p1').resultado, 'bloqueado');
  assert.deepEqual(etapas(p), { p1: 'esperando_qa', p2: 'listo_produccion' });
  const pista = leerJson(rutaEntregas(p.salida)).entregas[0].pistas.find((x) => x.portal === 'p1');
  assert.ok(pista.alertas.some((a) => a.tipo === 'qa_bloqueada'));
});

test('qaDeEventos: only the newest guide counts and the newest import of a row wins', () => {
  const guias = [
    { id: 'g1', fecha: '2026-11-01T00:00:00Z', filas: [{ etiqueta: 'A', portal: 'p', prs: ['r#1'] }] },
    { id: 'g2', fecha: '2026-11-03T00:00:00Z', filas: [{ etiqueta: 'A', portal: 'p', prs: ['r#1'] }, { etiqueta: 'B', portal: 'p', prs: ['r#1'] }] },
  ];
  const ev = (id, guia, fila, resultado, ts) => ({ id, tipo: 'qa_resultado', prs: ['r#1'], portal: 'p', guia, fila, resultado, ts });
  const qa = (eventos) => qaDeEventos(eventos, guias)({}, { portal: 'p', prs: ['r#1'] });
  assert.equal(qa([]), null);
  assert.equal(qa([ev('a', 'g1', 'A', 'ok', '2026-11-02T00:00:00Z')]), null);
  assert.deepEqual(qa([ev('a', 'g2', 'A', 'ok', '2026-11-04T00:00:00Z')]), { resultado: null, ts: '2026-11-04T00:00:00Z', bloqueado: false });
  assert.equal(qa([ev('a', 'g2', 'A', 'ok', '2026-11-04T00:00:00Z'), ev('b', 'g2', 'B', 'na', '2026-11-04T00:00:00Z')]).resultado, 'ok');
  assert.equal(qa([ev('a', 'g2', 'A', 'fallo', '2026-11-04T00:00:00Z'), ev('b', 'g2', 'B', 'ok', '2026-11-04T00:00:00Z')]).resultado, 'fallo');
  assert.equal(qa([ev('a', 'g2', 'A', 'fallo', '2026-11-04T00:00:00Z'), ev('c', 'g2', 'A', 'ok', '2026-11-05T00:00:00Z'), ev('b', 'g2', 'B', 'ok', '2026-11-04T00:00:00Z')]).resultado, 'ok');
  assert.equal(qa([ev('a', 'g2', 'A', 'ok', '2026-11-04T00:00:00Z'), ev('b', 'g2', 'B', 'bloqueado', '2026-11-04T00:00:00Z')]).bloqueado, true);
  assert.equal(qaDeEventos([ev('a', 'g2', 'A', 'ok', '2026-11-04T00:00:00Z')], guias)({}, { portal: 'p', prs: ['r#9'] }), null);
});

test('analizarImportacion is pure over its inputs and returns the events it would register', async () => {
  const { p, buf } = await escenario();
  const entregas = leerJson(rutaEntregas(p.salida)).entregas;
  const r = analizarImportacion(p, rellenar(buf, { 2: 'OK' }), { entregas, guias: leerGuias(p).guias, ahora: T1 });
  assert.equal(r.eventos.length, 1);
  assert.equal(leerEventos(p).filter((e) => e.tipo === 'qa_resultado').length, 0);
  assert.equal(r.eventos[0].fila, 'X-001');
  assert.deepEqual(r.eventos[0].prs, ['r#1']);
});

test('path checks: allowed folder, outside folder, symlink escape, size and extension', async () => {
  const { p, buf, ruta } = await escenario();
  const llena = rellenar(buf, { 2: 'OK' });
  const fuera = mkdtempSync(join(tmpdir(), 'seki-qa-fuera-'));
  temporales.push(fuera);
  const codigo = async (o) => { try { await importarQa(p, { ahora: T1, ...o }); } catch (e) { return e.codigo; } return null; };

  writeFileSync(ruta, llena);
  assert.equal((await importarQa(p, { ruta, ahora: T1 })).nuevos, 1);

  const externo = join(fuera, 'guia.xlsx');
  writeFileSync(externo, llena);
  assert.equal(await codigo({ ruta: externo }), 'QA_RUTA');
  assert.equal(await codigo({ ruta: externo, confirmar: false }), 'QA_RUTA');
  assert.equal((await importarQa(p, { ruta: externo, confirmar: true, ahora: T2 })).nuevos, 0);

  const enlace = join(p.salida, 'qa', 'enlace.xlsx');
  symlinkSync(externo, enlace);
  assert.equal(await codigo({ ruta: enlace }), 'QA_RUTA');

  const grande = join(p.salida, 'qa', 'grande.xlsx');
  writeFileSync(grande, Buffer.alloc(6 * 1024 * 1024));
  assert.equal(await codigo({ ruta: grande }), 'QA_TAMANO');

  const xls = join(p.salida, 'qa', 'vieja.xls');
  writeFileSync(xls, llena);
  assert.equal(await codigo({ ruta: xls }), 'QA_RUTA');
  assert.equal(await codigo({ ruta: join(p.salida, 'qa', 'no-existe.xlsx') }), 'QA_RUTA');
  assert.equal(await codigo({ buf: Buffer.alloc(6 * 1024 * 1024) }), 'QA_TAMANO');
});

test('xlsx reader errors reach the caller with their code', async () => {
  const { p } = await escenario();
  await assert.rejects(importarQa(p, { buf: Buffer.from('not a zip file at all'), ahora: T1 }), (e) => typeof e.codigo === 'string' && e.codigo.length > 0 && /\[seki-review\/xlsx\]/.test(e.message));
});

test('distinct codes for missing content and missing deliveries', async () => {
  const { p } = await escenario();
  await assert.rejects(importarQa(p, {}), { codigo: 'QA_VACIA' });
  const vacio = { ...p, salida: mkdtempSync(join(tmpdir(), 'seki-qa-vacio-')) };
  temporales.push(vacio.salida);
  await assert.rejects(importarQa(vacio, { buf: Buffer.from('x') }), { codigo: 'QA_SIN_ENTREGAS' });
});

test('a single-line repo shared by two portals: p1 OK and p2 Fail do not contaminate each other', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seki-qa-imp-'));
  temporales.push(dir);
  const salida = join(dir, 'salida');
  mkdirSync(join(salida, 'datos'), { recursive: true });
  const p = {
    clave: 't', owner: 'o', salida, qa: structuredClone(QA_DEFECTO), entregas: { ...ENTREGAS_DEFECTO, patronId: 'X-\\d+' },
    repos: {
      f: { lineas: [{ portal: 'p1', prod: 'mp1', pruebas: 'tp1' }, { portal: 'p2', prod: 'mp2', pruebas: 'tp2' }] },
      b: { lineas: [{ portal: 'Back', prod: 'main', pruebas: 'dev' }] },
    },
  };
  const mk = (repo, n, portal) => ({ ...pr(n, portal), id: `${repo}#${n}`, repo });
  const foto = { prs: [mk('f', 1, 'p1'), mk('f', 2, 'p2'), mk('b', 9, 'Back')], recientes: [] };
  escribirJson(rutaInstantanea(salida), foto);
  await derivarEntregas(p, foto);
  const g = await generarGuia(p, { ahora: GUIA, chrome: null });
  const qa = leerXlsx(readFileSync(g.archivos.xlsx)).hojas.find((h) => h.nombre === 'QA').filas;
  const fila = (portal) => qa.findIndex((f, i) => i > 0 && f[1] === portal && f[0] === 'X-001') + 1;
  const buf = readFileSync(g.archivos.xlsx);
  const llena = (a, b) => editarCeldas(buf, { hoja: 'QA', celdas: [{ ref: `H${fila('p1')}`, valor: a }, { ref: `H${fila('p2')}`, valor: b }, ...qa.slice(1).map((f, i) => ({ ref: `H${i + 2}`, valor: 'OK' })).filter((c) => ![fila('p1'), fila('p2')].some((n) => c.ref === `H${n}`))] });
  const r = await importarQa(p, { buf: llena('OK', 'Fail'), ahora: T1 });
  assert.deepEqual(r.rechazadas, []);
  assert.deepEqual(etapas(p), { p1: 'listo_produccion', p2: 'qa_fallo' });
  // p2 rows are still accepted although p1 already reached listo_produccion (target track is looked up by portal).
  const r2 = await importarQa(p, { buf: llena('OK', 'OK'), ahora: T2 });
  assert.deepEqual(r2.rechazadas, []);
  assert.deepEqual(etapas(p), { p1: 'listo_produccion', p2: 'listo_produccion' });
});

test('corrections before production: OK then Fail moves listo_produccion back to qa_fallo; incremental imports keep p1 rows quiet', async () => {
  const { p, buf } = await escenario();
  const todo = { 2: 'OK', 3: 'OK', 4: 'OK', 5: 'OK' };
  await importarQa(p, { buf: rellenar(buf, todo), ahora: T1 });
  assert.equal(etapas(p).p1, 'listo_produccion');
  const r = await importarQa(p, { buf: rellenar(buf, { ...todo, 2: 'Fail' }), ahora: T2 });
  assert.deepEqual(r.rechazadas, []);
  assert.equal(r.nuevos, 4);
  assert.equal(etapas(p).p1, 'qa_fallo');
  assert.equal(etapas(p).p2, 'listo_produccion');
  const igual = await importarQa(p, { buf: rellenar(buf, { ...todo, 2: 'Fail' }), ahora: new Date('2026-11-05T12:00:00Z') });
  assert.equal(igual.nuevos, 0);
  assert.ok(igual.resumen.every((x) => x.ya_registradas === 2));
});

test('once in production an equal stored result is skipped silently and a different one is rejected', async () => {
  const { p, foto, buf } = await escenario();
  await importarQa(p, { buf: rellenar(buf, { 2: 'OK', 3: 'OK', 4: 'OK', 5: 'OK' }), ahora: T1 });
  foto.prs.push({ id: 'r#20', repo: 'r', numero: 20, portal: 'p1', ambiente: 'prod', estadoPr: 'MERGED', mergeada: '2026-11-06T10:00:00Z', titulo: 'Fix login X-001 X-002', ramaOrigen: 'fix/login', base: 'mp1', descripcion: '' });
  escribirJson(rutaInstantanea(p.salida), foto);
  await derivarEntregas(p, foto);
  assert.equal(etapas(p).p1, 'en_produccion');
  const r = await importarQa(p, { buf: rellenar(buf, { 2: 'OK', 3: 'Fail', 4: 'OK', 5: 'OK' }, 'Bo'), ahora: T2 });
  assert.deepEqual(r.rechazadas.map((x) => [x.etiqueta, x.motivo]), [['X-002', 'The delivery is already in production']]);
  assert.equal(r.nuevos, 2);
});

test('a guide without a recorded merge for a track that now has a testing merge counts as stale', async () => {
  const { p, buf, guia } = await escenario();
  const ruta = join(p.salida, 'datos', 'guias.json');
  const g = JSON.parse(readFileSync(ruta, 'utf8'));
  g.guias[0].fusiones = {};
  writeFileSync(ruta, JSON.stringify(g));
  const r = await importarQa(p, { buf: rellenar(buf, { 2: 'OK' }), ahora: T1 });
  assert.deepEqual(conMotivos(r), ['New testing merge after the guide: generate a new guide']);
  assert.ok(guia.id);
});

test('a title row above the header and a dropped hidden flag still import', async () => {
  const { p, buf } = await escenario();
  const libro = leerXlsx(rellenar(buf, { 2: 'OK' }));
  const qa = libro.hojas.find((h) => h.nombre === 'QA');
  const seki = libro.hojas.find((h) => h.nombre === '_seki');
  const r = await importarQa(p, { buf: escribirXlsx({ hojas: [{ nombre: 'Report', filas: [['Title'], ...qa.filas], encabezado: false }, { nombre: '_seki', filas: seki.filas, encabezado: false }] }), ahora: T1 });
  assert.equal(r.nuevos, 1);
});

test('since-last-cut and key-selected guides skip tracks already passed', async () => {
  const { p, buf } = await escenario();
  await importarQa(p, { buf: rellenar(buf, { 2: 'OK', 3: 'OK', 4: 'OK', 5: 'OK' }), ahora: T1 });
  const corte = await generarGuia(p, { ahora: GUIA, chrome: null, desde: 'ultimo-corte' });
  assert.equal(corte.vacia, true);
  const nueva = await generarGuia(p, { ahora: new Date('2026-11-04T13:00:00'), chrome: null, claves: leerJson(rutaEntregas(p.salida)).entregas.map((e) => e.clave) });
  assert.equal(nueva.vacia, true);
});

test('rows of an older guide are rejected once a newer guide covers the track', async () => {
  const { p, buf } = await escenario();
  await importarQa(p, { buf: rellenar(buf, { 2: 'Fail' }), ahora: T1 });
  const nueva = await generarGuia(p, { ahora: new Date('2026-11-04T13:00:00'), chrome: null });
  assert.equal(nueva.vacia, false);
  const r = await importarQa(p, { buf: rellenar(buf, { 3: 'OK' }), ahora: T2 });
  assert.deepEqual(conMotivos(r), ['A newer guide covers this delivery: use the newest guide']);
});

function conRastreador(p, extra = {}) {
  const ruta = join(p.salida, '..', 'tracker.xlsx');
  writeFileSync(ruta, trackerFixture());
  p.qa.rastreador = {
    tipo: 'xlsx', ruta, hoja: 'Sheet1', filaEncabezado: 1, columnaId: 'ID',
    lectura: { hallazgo: 'Finding', pasos: 'How to reproduce', esperado: 'Expected', pantalla: null, prioridad: null },
    columnas: { estado: 'State', prPruebas: 'Testing PR', prProd: null, enPruebas: 'In testing', enProd: null },
    estados: { listo_produccion: 'Closed' }, escribir: true, ...extra,
  };
  return ruta;
}

test('import with a tracker configured writes it and reports the cells', async () => {
  const { p, buf } = await escenario();
  const ruta = conRastreador(p);
  const r = await importarQa(p, { buf: rellenar(buf, { 2: 'OK', 3: 'OK', 4: 'OK', 5: 'OK' }), ahora: T1 });
  assert.equal(r.rastreador.escrito, true);
  assert.ok(r.rastreador.celdas > 0);
  const filas = leerXlsx(readFileSync(ruta)).hojas[0].filas;
  assert.equal(filas[1][4], 'Closed');
  assert.equal(filas[1][7], '2026-11-01');
});

test('a refused tracker write does not undo the recorded events', async () => {
  const { p, buf } = await escenario();
  const ruta = conRastreador(p);
  writeFileSync(join(p.salida, '..', '~$tracker.xlsx'), '');
  const r = await importarQa(p, { buf: rellenar(buf, { 2: 'OK', 3: 'OK', 4: 'OK', 5: 'OK' }), ahora: T1 });
  assert.equal(r.rastreador.escrito, false);
  assert.ok(r.nuevos > 0);
  assert.ok(leerEventos(p).some((e) => e.tipo === 'qa_resultado'));
  assert.ok(readFileSync(ruta).equals(trackerFixture()));
});

test('the guide reads tracker content and survives an unreadable tracker', async (t) => {
  const { p } = await escenario();
  const ruta = conRastreador(p);
  const g = await generarGuia(p, { ahora: new Date('2026-11-04T13:00:00'), chrome: null });
  const celdas = (guia) => leerXlsx(readFileSync(guia.archivos.xlsx)).hojas[0].filas.flat();
  assert.ok(celdas(g).includes('Open the page\nClick the button'));
  writeFileSync(ruta, 'not a workbook');
  const espia = t.mock.method(console, 'error', () => {});
  const g2 = await generarGuia(p, { ahora: new Date('2026-11-04T14:00:00'), chrome: null });
  assert.ok(g2.id);
  assert.ok(!celdas(g2).includes('Open the page\nClick the button'));
  assert.ok(espia.mock.calls.some((c) => /\[seki-review\/qa\] Tracker content was not read.*ZIP_CORRUPTO/.test(String(c.arguments[0]))));
});
