import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escribirJson, leerJson, rutaAjustes, rutaInstantanea, rutaVisita } from '../mcp/lib/cache.mjs';
import { proyecto as cargarProyecto } from '../mcp/lib/config.mjs';
import { leerEventos, registrarEventos } from '../mcp/lib/eventos.mjs';
import { derivarEntregas } from '../mcp/lib/recolectar.mjs';
import { detenerServidores, iniciarServidor } from '../mcp/lib/servidor-web.mjs';
import { construirHtml } from '../mcp/lib/tablero.mjs';
import { compactarAjustes } from '../mcp/lib/tablero-entregas.mjs';
import herramienta from '../mcp/tools/entregas.mjs';
import { falsoGhRutas, limpiarGhRutas } from './util/gh-rutas.mjs';

after(limpiarGhRutas);
// A failed test may leave a server that /api/ceder refuses to close (refresh in progress).
after(detenerServidores);
const temporales = [];
const temporal = (prefijo) => {
  const dir = mkdtempSync(join(tmpdir(), prefijo));
  temporales.push(dir);
  return dir;
};
after(() => { for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true }); });


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
  const dir = temporal('seki-entregas-api-');
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
  const visita = new Date();
  escribirJson(rutaVisita(e.p.salida), { ts: visita.toISOString() });
  assert.deepEqual((await (await e.llamar('/api/entregas')).json()).desdeVisita, []);
  // Merged on GitHub before the visit, first seen by a refresh after it.
  const visto = new Date(visita.getTime() + 1);
  await registrarEventos(e.p, [{ id: 'tarde', ts: hace(2), tipo: 'pr_mergeada', pr: 'back#1', ambiente: 'prod', origen: 'github' }], { ahora: visto });
  // The next mark must fall after the registration (ISO times have millisecond resolution).
  while (Date.now() <= visto.getTime());
  const d = await (await e.llamar('/api/entregas')).json();
  assert.deepEqual(d.desdeVisita.map((x) => x.id), ['tarde']);
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
  const marca = new Date().toISOString();
  escribirJson(rutaVisita(p.salida), { ts: marca });
  await registrarEventos(p, [{ id: 'tarde', ts: hace(1), tipo: 'pr_mergeada', pr: 'back#1', ambiente: 'prod', origen: 'github' }], { ahora: new Date(Date.now() + 1000) });
  const texto = await herramienta.handler({ proyecto: clave, desde: 'ultima-visita' });
  assert.match(texto, /## Since the last visit .*: 1 events/);
  assert.match(texto, /Merged: back#1 Change 1 into production/);
  assert.match(texto, /## To merge in testing \(1\)\n- Change 3: front#3, front#4\. Next: Merge testing PR front#3\./);
  assert.match(texto, /## Ready for production \(1\)\n- Change 5: back#5\. Next: Merge production PR back#5\./);
  assert.match(texto, /## In production \(1\)\n- Change 2: back#1, back#2\. Next: Verify in production and close the delivery\./);
  assert.equal(leerJson(rutaVisita(p.salida)).ts, marca);
  assert.doesNotMatch(await herramienta.handler({ proyecto: clave }), /Since the last visit/);
});

test('the entregas tool asks to refresh when entregas.json is missing', async () => {
  const dir = temporal('seki-entregas-vacio-');
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

test('a chunked body over the cap without content-length is 413', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  const u = new URL(e.origen);
  const estado = await new Promise((ok, falla) => {
    const req = request({ host: u.hostname, port: u.port, path: '/api/entregas/ajuste', method: 'POST', headers: { 'x-seki-token': e.token, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); ok(res.statusCode); });
    req.on('error', falla);
    req.write('{"tipo":"titulo","clave":"x","titulo":"');
    for (let i = 0; i < 20; i++) req.write('y'.repeat(1024));
    req.end('"}');
  });
  assert.equal(estado, 413);
});

test('two concurrent adjustments (unir and titulo) both persist', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  const clave = deClave(await (await e.llamar('/api/entregas')).json(), 'back#1').clave;
  const [a, b] = await Promise.all([
    e.llamar('/api/entregas/ajuste', { cuerpo: { tipo: 'unir', prs: ['back#5', 'front#3'] } }),
    e.llamar('/api/entregas/ajuste', { cuerpo: { tipo: 'titulo', clave, titulo: 'Alpha release' } }),
  ]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  const ajustes = leerJson(rutaAjustes(e.p.salida));
  assert.deepEqual(ajustes.unir, [['back#5', 'front#3']]);
  assert.equal(ajustes.titulo[clave], 'Alpha release');
  const d = await (await e.llamar('/api/entregas')).json();
  assert.equal(deClave(d, 'back#1').titulo, 'Alpha release');
  assert.ok(deClave(d, 'back#5').prs.includes('front#3'));
});

test('desdeVisita keeps the newest 200 events and totalDesdeVisita counts them all', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  escribirJson(rutaVisita(e.p.salida), { ts: new Date().toISOString() });
  const base = Date.now() - 3600000;
  await registrarEventos(e.p, [{ id: 'primero', ts: hace(1), tipo: 'pr_cerrada', pr: 'back#5', origen: 'prueba' }], { ahora: new Date(Date.now() + 1000) });
  await registrarEventos(e.p, Array.from({ length: 250 }, (_, i) => ({ id: `x${i}`, ts: new Date(base + i * 1000).toISOString(), tipo: 'pr_cerrada', pr: 'back#5', origen: 'prueba' })), { ahora: new Date(Date.now() + 2000) });
  const d = await (await e.llamar('/api/entregas')).json();
  assert.equal(d.totalDesdeVisita, 251);
  assert.equal(d.desdeVisita.length, 200);
  assert.equal(d.desdeVisita.at(-1).id, 'x249');
  const html = construirHtml(e.p, leerJson(rutaInstantanea(e.p.salida)), null);
  assert.match(html, /"totalDesdeVisita":251/);
  assert.match(await herramienta.handler({ proyecto: e.clave, desde: 'ultima-visita' }), /: 251 events\n\(51 earlier events not listed\)/);
});

test('a refresh that was already running does not undo a join made meanwhile', async (t) => {
  const dir = temporal('seki-entregas-carrera-');
  const salida = join(dir, 'salida');
  mkdirSync(join(salida, 'datos'), { recursive: true });
  const clave = `carrera${++n}`;
  const linea = { portal: 'P', prod: 'main', pruebas: 'testing' };
  writeFileSync(join(dir, 'p.json'), JSON.stringify({ [clave]: { owner: 'o', autor: 'yo', salida, repos: { a: { lineas: [linea] } } } }));
  process.env.SEKI_REVIEW_CONFIG = join(dir, 'p.json');
  const rest = (num, titulo, rama) => ({ number: num, title: titulo, state: 'closed', user: { login: 'yo' }, html_url: `u/${num}`, created_at: hace(5), merged_at: hace(1), closed_at: hace(1), base: { sha: 'b' }, head: { sha: 'h', ref: rama }, body: null });
  const pulls = (base, lista) => ({ patron: `^api repos/o/a/pulls\\?base=${base}&state=(all&sort=created|closed&sort=updated)&direction=desc&per_page=100&page=1$`, json: lista });
  const gh = falsoGhRutas([
    { patron: '^api user$', json: { login: 'yo' } },
    { patron: '^pr list ', json: [] },
    pulls('main', [rest(1, 'Payment limits', 'feat/alpha'), rest(2, 'Report export', 'feat/zeta')]),
    pulls('testing', []),
  ]);
  // While the hold file exists every gh call waits, so the second refresh is still querying when the join arrives.
  const retener = join(dir, 'retener');
  const lento = join(dir, 'gh-lento');
  writeFileSync(lento, `#!/bin/sh\nwhile [ -f "${retener}" ]; do sleep 0.02; done\nexec "${gh.ruta}" "$@"\n`);
  chmodSync(lento, 0o755);
  const previoGh = process.env.SEKI_GH;
  process.env.SEKI_GH = lento;
  t.after(() => { if (previoGh === undefined) delete process.env.SEKI_GH; else process.env.SEKI_GH = previoGh; });
  writeFileSync(join(salida, 'datos', 'prs.json'), JSON.stringify({ prs: [], recientes: [], generado: new Date().toISOString(), owner: 'o' }));
  const { url } = await iniciarServidor({ proyecto: clave, puerto: 0, abrir: false });
  const u = new URL(url);
  const llamar = (ruta, cuerpo) => fetch(`${u.origin}${ruta}`, { method: cuerpo === undefined ? 'GET' : 'POST', headers: { 'x-seki-token': u.searchParams.get('t'), 'content-type': 'application/json' }, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  t.after(() => { rmSync(retener, { force: true }); return llamar('/api/ceder', {}); });
  // Generous deadline: it only turns a refresh that never ends into a failure instead of a hang.
  const terminar = async () => { const fin = Date.now() + 30_000; while (Date.now() < fin) { if (!(await (await llamar('/api/estado')).json()).refrescando) return; await new Promise((ok) => setTimeout(ok, 50)); } throw new Error('refresh did not finish'); };
  await llamar('/api/refrescar', {});
  await terminar();
  assert.equal((await (await llamar('/api/entregas')).json()).entregas.length, 2);
  writeFileSync(retener, '');
  await llamar('/api/refrescar', {});
  const r = await llamar('/api/entregas/ajuste', { tipo: 'unir', prs: ['a#1', 'a#2'] });
  assert.equal(r.status, 200);
  assert.equal((await (await llamar('/api/estado')).json()).refrescando, true);
  rmSync(retener);
  await terminar();
  const final = leerJson(join(salida, 'datos', 'entregas.json'));
  assert.deepEqual(final.entregas.map((x) => [...x.prs].sort()), [['a#1', 'a#2']]);
});

test('compactarAjustes merges overlapping joins and drops unknown PRs and titles', () => {
  const foto = { prs: ['a#1', 'a#2', 'b#3', 'b#4', 'c#5'].map((id) => ({ id })), recientes: [{ id: 'c#6' }] };
  const r = compactarAjustes({
    unir: [['a#1', 'a#2'], ['b#3', 'b#4'], ['a#2', 'b#3', 'zz#9'], ['c#5', 'viejo#1'], ['c#6', 'c#5']],
    separar: ['a#1', 'viejo#2', 'a#1'],
    titulo: { actual: 'Kept', ida: 'Dropped' },
  }, foto, [{ clave: 'actual', prs: [] }]);
  assert.deepEqual(r.unir, [['a#1', 'a#2', 'b#3', 'b#4'], ['c#5', 'c#6']]);
  assert.deepEqual(r.separar, ['a#1']);
  assert.deepEqual(r.titulo, { actual: 'Kept' });
});

test('repeated overlapping joins through the API keep ajustes.json bounded', async (t) => {
  const e = await entorno();
  t.after(e.cerrar);
  escribirJson(rutaAjustes(e.p.salida), { unir: [['back#5', 'gone#1']], separar: ['gone#2'], titulo: { 'no-longer-exists': 'x' } });
  for (const prs of [['back#5', 'front#3'], ['front#3', 'front#4'], ['back#5', 'front#4']]) {
    assert.equal((await e.llamar('/api/entregas/ajuste', { cuerpo: { tipo: 'unir', prs } })).status, 200);
  }
  assert.deepEqual(leerJson(rutaAjustes(e.p.salida)), { unir: [['back#5', 'front#3', 'front#4']], separar: [], titulo: {} });
});
