import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secretoQa } from '../mcp/lib/acceso.mjs';
import { escribirJson, rutaEntregas, rutaInstantanea } from '../mcp/lib/cache.mjs';
import { QA_DEFECTO } from '../mcp/lib/config.mjs';
import { firmaFila, leerGuias } from '../mcp/lib/qa-guia.mjs';
import { COLUMNAS_SEKI, FORMATO_SEKI, generarGuia, htmlGuia } from '../mcp/lib/qa-salida.mjs';
import { leerXlsx } from '../mcp/lib/xlsx.mjs';
import { leerZip } from '../mcp/lib/zip.mjs';
import { chromeFalso, limpiarChrome, llamadasChrome } from './util/chrome.mjs';

after(limpiarChrome);
const temporales = [];
after(() => { for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true }); });

const AHORA = new Date('2026-11-04T12:00:00');
const pr = (n, portal) => ({ id: `r#${n}`, repo: 'r', numero: n, portal, ambiente: 'pruebas', estadoPr: 'MERGED', mergeada: '2026-11-01T10:00:00Z', descripcion: `## How to test\n- Open the screen ${n}` });

function proyecto({ entregas = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'seki-qa-salida-'));
  temporales.push(dir);
  const salida = join(dir, 'salida');
  mkdirSync(join(salida, 'datos'), { recursive: true });
  const prs = [pr(1, 'p1'), pr(2, 'p2')];
  escribirJson(rutaInstantanea(salida), { prs, recientes: [] });
  if (entregas) {
    escribirJson(rutaEntregas(salida), {
      generado: AHORA.toISOString(),
      entregas: [{ clave: 'k1', titulo: 'Fix login', ids: ['X-001', 'X-002'], prs: ['r#1', 'r#2'], pistas: prs.map((x) => ({ portal: x.portal, prs: [x.id], etapa: 'esperando_qa', alertas: [] })) }],
    });
  }
  return { clave: 't', salida, qa: structuredClone(QA_DEFECTO) };
}

test('generarGuia writes xlsx, html and pdf, signs rows and registers the guide', async () => {
  const p = proyecto();
  const chrome = chromeFalso({ modo: 'ok' });
  const r = await generarGuia(p, { ahora: AHORA, chrome });
  assert.equal(r.id, 'guia-2026-11-04-1');
  assert.equal(r.filas, 4);
  assert.equal(r.vacia, false);
  assert.equal(r.avisoPdf, null);
  assert.deepEqual(r.pendientes, []);
  for (const ruta of Object.values(r.archivos)) assert.ok(existsSync(ruta), ruta);
  assert.equal(readFileSync(r.archivos.pdf, 'utf8').startsWith('%PDF-1.4'), true);

  const libro = leerXlsx(readFileSync(r.archivos.xlsx));
  const qa = libro.hojas.find((h) => h.nombre === 'QA');
  const seki = libro.hojas.find((h) => h.nombre === '_seki');
  assert.ok(!qa.oculta);
  assert.ok(seki.oculta);
  assert.deepEqual(qa.filas[0], QA_DEFECTO.columnas);
  assert.equal(qa.filas.length, 5);
  assert.deepEqual(qa.filas[1].slice(0, 2), ['X-001', 'p1']);
  assert.match(qa.filas[1][4], /Open the screen 1/);
  assert.deepEqual(seki.filas[0].slice(0, 3), [FORMATO_SEKI, r.id, 't']);
  assert.equal(FORMATO_SEKI, 'seki-qa-1');
  assert.equal(seki.filas.length, 5);
  const secreto = secretoQa(p);
  for (const f of seki.filas.slice(1)) {
    const { etiqueta, portal, entrega, prs, firma } = Object.fromEntries(COLUMNAS_SEKI.map((c, i) => [c, f[i]]));
    assert.equal(firma, firmaFila(secreto, { guia: r.id, etiqueta, portal, prs: JSON.parse(prs), entrega }));
  }
  const guias = leerGuias(p).guias;
  assert.equal(guias.length, 1);
  assert.equal(guias[0].id, r.id);
  assert.deepEqual(Object.keys(guias[0].fusiones).sort(), ['["r#1"]', '["r#2"]']);
});

test('xlsx has frozen header, widths and Result validation over the data rows', async () => {
  const p = proyecto();
  const r = await generarGuia(p, { ahora: AHORA, chrome: null });
  const hoja = leerZip(readFileSync(r.archivos.xlsx)).get('xl/worksheets/sheet1.xml').toString();
  assert.match(hoja, /state="frozen"/);
  assert.match(hoja, /<dataValidation type="list"[^>]*sqref="H2:H5"><formula1>"OK,Fail,Blocked,Pending,N\/A"<\/formula1>/);
  const anchos = [...hoja.matchAll(/<col min="\d+" max="\d+" width="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(anchos, [14, 12, 24, 28, 48, 36, 10, 12, 28, 20, 12, 14]);
});

test('second call the same day takes -2', async () => {
  const p = proyecto();
  const a = await generarGuia(p, { ahora: AHORA, chrome: null });
  const b = await generarGuia(p, { ahora: AHORA, chrome: null });
  assert.equal(a.id, 'guia-2026-11-04-1');
  assert.equal(b.id, 'guia-2026-11-04-2');
  assert.equal(leerGuias(p).guias.length, 2);
});

test('concurrent calls take different numbers', async () => {
  const p = proyecto();
  const [a, b] = await Promise.all([generarGuia(p, { ahora: AHORA, chrome: null }), generarGuia(p, { ahora: AHORA, chrome: null })]);
  assert.notEqual(a.id, b.id);
  assert.equal(leerGuias(p).guias.length, 2);
});

test('nothing waiting gives vacia and writes nothing', async () => {
  const p = proyecto({ entregas: false });
  const r = await generarGuia(p, { ahora: AHORA, chrome: null });
  assert.equal(r.vacia, true);
  assert.equal(existsSync(join(p.salida, 'qa')), false);
  assert.equal(leerGuias(p).guias.length, 0);
});

test('desde ultimo-corte skips tracks already covered', async () => {
  const p = proyecto();
  await generarGuia(p, { ahora: AHORA, chrome: null });
  const r = await generarGuia(p, { ahora: AHORA, chrome: null, desde: 'ultimo-corte' });
  assert.equal(r.vacia, true);
  assert.equal(leerGuias(p).guias.length, 1);
});

test('claves selects deliveries', async () => {
  const p = proyecto();
  assert.equal((await generarGuia(p, { ahora: AHORA, chrome: null, claves: ['otra'] })).vacia, true);
  assert.equal((await generarGuia(p, { ahora: AHORA, chrome: null, claves: ['k1'] })).filas, 4);
});

test('htmlGuia escapes values and carries the CSP meta', () => {
  const h = htmlGuia({ titulo: 'QA guide <x>', columnas: ['A<script>'], filas: [['<script>alert(1)</script>']] });
  assert.ok(!h.includes('<script'));
  assert.ok(h.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(h.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`));
  assert.ok(h.includes('@page { size: A4 landscape; margin: 10mm }'));
});

test('failing Chrome leaves html only, with a notice', async () => {
  const p = proyecto();
  const chrome = chromeFalso({ modo: 'falla' });
  const r = await generarGuia(p, { ahora: AHORA, chrome });
  assert.equal(r.archivos.pdf, null);
  assert.match(r.avisoPdf, /PDF not generated/);
  assert.ok(existsSync(r.archivos.html));
  assert.deepEqual(readdirSync(join(p.salida, 'qa')).filter((n) => n.endsWith('.pdf') || n.includes('.tmp')), []);
  assert.equal(llamadasChrome(chrome).length, 1);
});

test('QA sheet and HTML show no PR ids, branches or file paths', async () => {
  const p = proyecto();
  const foto = JSON.parse(readFileSync(join(p.salida, 'datos', 'prs.json'), 'utf8'));
  foto.prs[0].descripcion = '## How to test\n- Open r#2 from fix/login-bug and src/a.mjs';
  writeFileSync(join(p.salida, 'datos', 'prs.json'), JSON.stringify(foto));
  const r = await generarGuia(p, { ahora: AHORA, chrome: null });
  const qa = leerXlsx(readFileSync(r.archivos.xlsx)).hojas.find((h) => h.nombre === 'QA');
  const texto = qa.filas.flat().join('\n') + readFileSync(r.archivos.html, 'utf8');
  assert.doesNotMatch(texto, /r#\d|fix\/|\.mjs|github\.com|origin\//);
});

test('a configured Chrome path that does not exist gives no PDF and says so', async () => {
  const p = proyecto();
  p.qa.chrome = join(tmpdir(), 'seki-no-existe-chrome');
  const r = await generarGuia(p, { ahora: AHORA });
  assert.equal(r.archivos.pdf, null);
  assert.match(r.avisoPdf, /The configured Chrome path does not exist/);
});

test('key fields with XML-invalid characters are signed as written', async () => {
  const p = proyecto();
  const e = JSON.parse(readFileSync(rutaEntregas(p.salida), 'utf8'));
  e.entregas[0].ids = ['X-\u0001001'];
  escribirJson(rutaEntregas(p.salida), e);
  const r = await generarGuia(p, { ahora: AHORA, chrome: null });
  const seki = leerXlsx(readFileSync(r.archivos.xlsx)).hojas.find((h) => h.nombre === '_seki');
  const [etiqueta, portal, entrega, prs, firma] = seki.filas[1];
  assert.equal(etiqueta, 'X-001');
  assert.equal(firma, firmaFila(secretoQa(p), { guia: r.id, etiqueta, portal, prs: JSON.parse(prs), entrega }));
  assert.equal(leerGuias(p).guias[0].filas[0].etiqueta, 'X-001');
});

test('a failure after the reservation leaves no file behind', async () => {
  const p = proyecto();
  mkdirSync(join(p.salida, 'datos', 'secreto-qa'));
  await assert.rejects(generarGuia(p, { ahora: AHORA, chrome: null }));
  assert.deepEqual(readdirSync(join(p.salida, 'qa')), []);
  assert.equal(leerGuias(p).guias.length, 0);
});

test('two concurrent cuts never share tracks', async () => {
  const p = proyecto();
  const [a, b] = await Promise.all([
    generarGuia(p, { ahora: AHORA, chrome: null, desde: 'ultimo-corte' }),
    generarGuia(p, { ahora: AHORA, chrome: null, desde: 'ultimo-corte' }),
  ]);
  assert.deepEqual([a.vacia, b.vacia].sort(), [false, true]);
  assert.equal(leerGuias(p).guias.length, 1);
});

test('no Chrome found gives html only with a notice', async () => {
  const p = proyecto();
  const r = await generarGuia(p, { ahora: AHORA, chrome: null });
  assert.equal(r.archivos.pdf, null);
  assert.match(r.avisoPdf, /Chrome was not found/);
  assert.ok(existsSync(r.archivos.html));
});

test('rows without steps are listed as pending PRs', async () => {
  const p = proyecto();
  const foto = JSON.parse(readFileSync(join(p.salida, 'datos', 'prs.json'), 'utf8'));
  foto.prs[0].descripcion = '';
  writeFileSync(join(p.salida, 'datos', 'prs.json'), JSON.stringify(foto));
  const r = await generarGuia(p, { ahora: AHORA, chrome: null });
  assert.deepEqual(r.pendientes, ['r#1']);
});
