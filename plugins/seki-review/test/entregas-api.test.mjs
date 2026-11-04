import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escribirJson, leerJson, rutaAjustes, rutaInstantanea, rutaVisita } from '../mcp/lib/cache.mjs';
import { proyecto as cargarProyecto } from '../mcp/lib/config.mjs';
import { leerEventos } from '../mcp/lib/eventos.mjs';
import { derivarEntregas } from '../mcp/lib/recolectar.mjs';
import { iniciarServidor } from '../mcp/lib/servidor-web.mjs';
import { construirHtml } from '../mcp/lib/tablero.mjs';
import herramienta from '../mcp/tools/entregas.mjs';

const hace = (dias) => new Date(Date.now() - dias * 86400000).toISOString();
const pr = (repo, numero, ambiente, estadoPr, rama, extra = {}) => ({
  id: `${repo}#${numero}`, repo, numero, titulo: `Change ${numero}`, url: `https://example.test/${repo}/${numero}`,
  base: ambiente === 'prod' ? 'main' : 'develop', rama, portal: 'P', ambiente, estadoPr, mergeada: null, creada: hace(3), body: '', ...extra,
});

// Three deliveries: alpha (back, merged in both environments), beta (front, open) and gamma (back, production only).
const FOTO = () => ({
  proyecto: 'demo', generado: new Date().toISOString(), owner: 'o',
  prs: [pr('front', 3, 'pruebas', 'OPEN', 'feat/beta-pruebas'), pr('front', 4, 'prod', 'OPEN', 'feat/beta'), pr('back', 5, 'prod', 'OPEN', 'feat/gamma')],
  recientes: [
    pr('back', 1, 'prod', 'MERGED', 'feat/alpha', { mergeada: hace(1) }),
    pr('back', 2, 'pruebas', 'MERGED', 'feat/alpha-pruebas', { mergeada: hace(2) }),
  ],
});

let n = 0;
async function entorno({ servir = true } = {}) {
  const clave = `ent${++n}`;
  const dir = mkdtempSync(join(tmpdir(), 'seki-entregas-api-'));
  const salida = join(dir, 'salida');
  mkdirSync(join(salida, 'datos'), { recursive: true });
  const linea = { portal: 'P', prod: 'main', pruebas: 'develop' };
  const ruta = join(dir, 'proyectos.json');
  writeFileSync(ruta, JSON.stringify({ [clave]: { owner: 'o', salida, repos: { back: { lineas: [linea] }, front: { lineas: [linea] } } } }));
  process.env.SEKI_REVIEW_CONFIG = ruta;
  const p = cargarProyecto(clave);
  const foto = FOTO();
  escribirJson(rutaInstantanea(salida), foto);
  await derivarEntregas(p, foto);
  if (!servir) return { p, clave };
  const { url } = await iniciarServidor({ proyecto: clave, puerto: 0, abrir: false });
  const u = new URL(url);
  const token = u.searchParams.get('t');
  const llamar = (ruta, { cuerpo, metodo = cuerpo === undefined ? 'GET' : 'POST', cabeceras = {}, crudo } = {}) => fetch(`${u.origin}${ruta}`, {
    method: metodo,
    headers: { 'x-seki-token': token, 'content-type': 'application/json', ...cabeceras },
    body: crudo ?? (cuerpo === undefined ? undefined : JSON.stringify(cuerpo)),
  });
  const cerrar = () => llamar('/api/ceder', { cuerpo: {} });
  return { p, clave, token, origen: u.origin, llamar, cerrar };
}

const deClave = (datos, prefijo) => datos.entregas.find((e) => e.prs.includes(prefijo));

test('deliveries endpoints require the token', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  for (const [ruta, metodo] of [['/api/entregas', 'GET'], ['/api/entregas/ajuste', 'POST'], ['/api/entregas/cerrar', 'POST'], ['/api/visita', 'POST']]) {
    const r = await fetch(`${e.origen}${ruta}`, { method: metodo, headers: { 'content-type': 'application/json' }, body: metodo === 'POST' ? '{}' : undefined });
    assert.equal(r.status, 401, ruta);
  }
  assert.equal((await e.llamar('/api/entregas', { cabeceras: { 'x-seki-token': 'otro' } })).status, 403);
});

test('GET /api/entregas returns the deliveries with next action and no banner before the first visit', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  const d = await (await e.llamar('/api/entregas')).json();
  assert.equal(d.visita, null);
  assert.deepEqual(d.desdeVisita, []);
  assert.equal(deClave(d, 'front#3').siguiente, 'Merge testing PR front#3');
  assert.equal(deClave(d, 'back#5').siguiente, 'Merge production PR back#5');
  assert.equal(d.prs['back#1'].url, 'https://example.test/back/1');
});

test('desdeVisita lists only the events after visita.json, and POST /api/visita moves the mark', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  escribirJson(rutaVisita(e.p.salida), { ts: hace(1.5) });
  const d = await (await e.llamar('/api/entregas')).json();
  assert.deepEqual(d.desdeVisita.map((x) => x.pr), ['back#1']);
  const r = await e.llamar('/api/visita', { cuerpo: {} });
  assert.equal(r.status, 200);
  assert.ok(leerJson(rutaVisita(e.p.salida)).ts > hace(0.01));
  assert.deepEqual((await (await e.llamar('/api/entregas')).json()).desdeVisita, []);
});

test('unir with an unknown PR id is 400 and writes nothing', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  const r = await e.llamar('/api/entregas/ajuste', { cuerpo: { tipo: 'unir', prs: ['back#1', 'back#999'] } });
  assert.equal(r.status, 400);
  assert.equal(leerJson(rutaAjustes(e.p.salida)), null);
  assert.equal((await e.llamar('/api/entregas/ajuste', { cuerpo: { tipo: 'unir', prs: ['back#1', 'back#1'] } })).status, 400);
});

test('valid unir joins two deliveries and records entrega_ajustada', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  const antes = (await (await e.llamar('/api/entregas')).json()).entregas.length;
  const r = await e.llamar('/api/entregas/ajuste', { cuerpo: { tipo: 'unir', prs: ['back#5', 'front#3', 'front#4'] } });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.entregas.length, antes - 1);
  assert.deepEqual(deClave(d, 'back#5').prs.sort(), ['back#5', 'front#3', 'front#4']);
  const ev = leerEventos(e.p).filter((x) => x.tipo === 'entrega_ajustada');
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].ajuste, { tipo: 'unir', prs: ['back#5', 'front#3', 'front#4'] });
});

test('titulo over 200 characters or blank is 400; a valid one renames the delivery', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  const clave = deClave(await (await e.llamar('/api/entregas')).json(), 'front#3').clave;
  assert.equal((await e.llamar('/api/entregas/ajuste', { cuerpo: { tipo: 'titulo', clave, titulo: 'x'.repeat(201) } })).status, 400);
  assert.equal((await e.llamar('/api/entregas/ajuste', { cuerpo: { tipo: 'titulo', clave, titulo: '   ' } })).status, 400);
  assert.equal((await e.llamar('/api/entregas/ajuste', { cuerpo: { tipo: 'titulo', clave: 'nada', titulo: 'x' } })).status, 404);
  const d = await (await e.llamar('/api/entregas/ajuste', { cuerpo: { tipo: 'titulo', clave, titulo: '  Beta release  ' } })).json();
  assert.equal(deClave(d, 'front#3').titulo, 'Beta release');
});

test('valid separar returns one more delivery', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  const antes = (await (await e.llamar('/api/entregas')).json()).entregas.length;
  const d = await (await e.llamar('/api/entregas/ajuste', { cuerpo: { tipo: 'separar', pr: 'back#2' } })).json();
  assert.equal(d.entregas.length, antes + 1);
  assert.deepEqual(deClave(d, 'back#2').prs, ['back#2']);
});

test('cerrar makes a delivery in production cerrada; unknown is 404, not in production is 409', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  const d0 = await (await e.llamar('/api/entregas')).json();
  const alfa = deClave(d0, 'back#1');
  assert.equal(alfa.etapa, 'en_produccion');
  assert.equal((await e.llamar('/api/entregas/cerrar', { cuerpo: { clave: 'no-existe' } })).status, 404);
  assert.equal((await e.llamar('/api/entregas/cerrar', { cuerpo: { clave: deClave(d0, 'front#3').clave } })).status, 409);
  const r = await e.llamar('/api/entregas/cerrar', { cuerpo: { clave: alfa.clave } });
  assert.equal(r.status, 200);
  assert.equal(deClave(await r.json(), 'back#1').etapa, 'cerrada');
  const [ev] = leerEventos(e.p).filter((x) => x.tipo === 'entrega_cerrada');
  assert.deepEqual(ev.prs, ['back#1', 'back#2']);
  assert.match(ev.id, /^[0-9a-f]{64}$/);
});

test('bodies that are not JSON are 415, oversized ones 413, unknown tipo and malformed JSON 400', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  assert.equal((await e.llamar('/api/entregas/ajuste', { crudo: 'tipo=unir', metodo: 'POST', cabeceras: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await e.llamar('/api/visita', { crudo: '{}', metodo: 'POST', cabeceras: { 'content-type': 'text/plain' } })).status, 415);
  const grande = JSON.stringify({ tipo: 'titulo', clave: 'x', titulo: 'y'.repeat(20 * 1024) });
  assert.equal((await e.llamar('/api/entregas/ajuste', { crudo: grande, metodo: 'POST' })).status, 413);
  assert.equal((await e.llamar('/api/entregas/ajuste', { cuerpo: { tipo: 'borrar' } })).status, 400);
  assert.equal((await e.llamar('/api/entregas/ajuste', { crudo: '{"tipo":', metodo: 'POST' })).status, 400);
  assert.equal((await e.llamar('/api/entregas/ajuste', { crudo: '[1,2]', metodo: 'POST' })).status, 400);
});

test('the entregas tool summarizes by stage with next actions and events since the last visit, without moving the mark', async () => {
  const { p, clave } = await entorno({ servir: false });
  const marca = hace(1.5);
  escribirJson(rutaVisita(p.salida), { ts: marca });
  const texto = await herramienta.handler({ proyecto: clave, desde: 'ultima-visita' });
  assert.match(texto, /## Since the last visit .*: 1 events/);
  assert.match(texto, /Merged: back#1 Change 1 into production/);
  assert.match(texto, /## To merge in testing \(1\)\n- Change 3: front#3, front#4\. Next: Merge testing PR front#3\./);
  assert.match(texto, /## Ready for production \(1\)\n- Change 5: back#5\. Next: Merge production PR back#5\./);
  assert.match(texto, /## In production \(1\)\n- Change 1: back#1, back#2\. Next: Verify in production and close the delivery\./);
  assert.equal(leerJson(rutaVisita(p.salida)).ts, marca);
  assert.doesNotMatch(await herramienta.handler({ proyecto: clave }), /Since the last visit/);
});

test('the entregas tool asks to refresh when entregas.json is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seki-entregas-vacio-'));
  const ruta = join(dir, 'proyectos.json');
  writeFileSync(ruta, JSON.stringify({ vacio: { owner: 'o', salida: join(dir, 'salida'), repos: {} } }));
  process.env.SEKI_REVIEW_CONFIG = ruta;
  assert.match(await herramienta.handler({ proyecto: 'vacio' }), /refresh the state first/);
});

test('construirHtml embeds the deliveries inertly: a title with </script><script> cannot close the script', async () => {
  const { p } = await entorno({ servir: false });
  const foto = leerJson(rutaInstantanea(p.salida));
  const malo = '</script><script>alert(1)</script>\u2028';
  escribirJson(rutaAjustes(p.salida), { titulo: { beta: malo } });
  await derivarEntregas(p, foto);
  const html = construirHtml(p, foto, null);
  assert.ok(!html.includes('/*ENTREGAS*/'));
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(html.includes('\\u003c/script>\\u003cscript>alert(1)\\u003c/script>\\u2028'));
  const cuenta = (s) => s.split('</script>').length;
  assert.equal(cuenta(html), cuenta(construirHtml({ salida: '/nonexistent' }, foto, null)));
});
