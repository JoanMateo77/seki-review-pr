import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leerCostos } from '../mcp/lib/ia.mjs';
import { rutaTriaje } from '../mcp/lib/cache.mjs';
import { aplicarDescartes } from '../mcp/lib/descartes.mjs';
import { datosChecks, guardarTriaje, leerTriaje, triarChecks } from '../mcp/lib/triaje.mjs';

const SHA = 'a'.repeat(40);
const pr = { id: 'api#7', repo: 'acme/api', numero: 7, titulo: 'feat: list view', headSha: SHA };
const hallazgo = (i, severidad = 'medio', extra = {}) => ({ regla: 'ejs-sin-escapar', titulo: 'Unescaped output', severidad, archivo: 'views/list.ejs', linea: 1 + (i % 3), texto: `<%- item${i} %>`, mensaje: 'Escape it', origen: 'base', ...extra });

function entorno({ n = 3, severidad = 'medio', respuesta, extra = [] } = {}) {
  const salida = mkdtempSync(join(tmpdir(), 'seki-triaje-'));
  const copia = join(salida, 'copia');
  mkdirSync(join(copia, 'views'), { recursive: true });
  writeFileSync(join(copia, 'views/list.ejs'), '<%- a %>\n<%- b %>\n<%- c %>\n');
  const p = { salida, repos: {} };
  const verificaciones = aplicarDescartes({ hallazgos: [...Array.from({ length: n }, (_, i) => hallazgo(i, severidad)), ...extra] }, []);
  const llamadas = [];
  const ejecutar = async (args, { cwd }) => {
    const prompt = args[args.indexOf('-p') + 1];
    llamadas.push({ args, cwd, prompt });
    const huellas = [...prompt.matchAll(/"huella": "([0-9a-f]{16})"/g)].map((m) => m[1]);
    const salidaIa = respuesta ? respuesta(huellas) : { veredictos: huellas.map((huella) => ({ huella, veredicto: 'real', razon: 'The value comes from the request at views/list.ejs:1' })) };
    return { ok: true, costo: 0.2, modelo: 'claude-sonnet-5-5', salida: salidaIa };
  };
  return { p, verificaciones, llamadas, deps: { ejecutar, copiar: async () => copia, verificaciones } };
}

test('a stored triage of the same commit is returned without calling the model; repetir calls once', async () => {
  const { p, deps, llamadas } = entorno();
  const a = await triarChecks(p, pr, deps);
  assert.equal(a.ok, true);
  assert.equal(llamadas.length, 1);
  const b = await triarChecks(p, pr, deps);
  assert.equal(b.desdeCache, true);
  assert.equal(llamadas.length, 1);
  const c = await triarChecks(p, pr, { ...deps, repetir: true });
  assert.equal(c.desdeCache, undefined);
  assert.equal(llamadas.length, 2);
});

test('aviso findings and dismissed ones are not sent', async () => {
  const { p, deps, llamadas } = entorno({ n: 2, extra: [hallazgo(99, 'aviso', { texto: 'SOLO_AVISO' })] });
  await triarChecks(p, pr, deps);
  assert.doesNotMatch(llamadas[0].prompt, /SOLO_AVISO/);
  assert.equal((llamadas[0].prompt.match(/"huella"/g) ?? []).length, 2);
});

test('with no triable finding nothing is called', async () => {
  const { p, deps, llamadas } = entorno({ n: 0, extra: [hallazgo(1, 'aviso')] });
  const r = await triarChecks(p, pr, deps);
  assert.deepEqual(r, { ok: false, motivo: 'No findings to triage', costo: 0 });
  assert.equal(llamadas.length, 0);
});

test('verdicts are normalised: empty reason, missing evidence, skipped, unknown and repeated', async () => {
  const { p, deps, verificaciones } = entorno({
    n: 5,
    respuesta: (h) => ({ veredictos: [
      { huella: h[0], veredicto: 'falso_positivo', razon: '', evidencia: { archivo: 'views/list.ejs', linea: 1 } },
      { huella: h[1], veredicto: 'falso_positivo', razon: 'Literal', evidencia: { archivo: 'views/nope.ejs', linea: 1 } },
      { huella: h[2], veredicto: 'falso_positivo', razon: 'x'.repeat(400), evidencia: { archivo: 'views/list.ejs', linea: 2 } },
      { huella: 'f'.repeat(16), veredicto: 'real', razon: 'unknown' },
      { huella: h[2], veredicto: 'real', razon: 'repeated' },
      { huella: h[4], veredicto: 'real', razon: 'Reaches the page' },
    ] }),
  });
  const r = await triarChecks(p, pr, deps);
  const [h0, h1, h2, h3, h4] = verificaciones.hallazgos.map((h) => h.huella);
  const por = new Map(r.resultado.veredictos.map((v) => [v.huella, v]));
  assert.equal(r.resultado.veredictos.length, 5);
  assert.equal(por.get(h0).veredicto, 'dudoso');
  assert.equal(por.get(h1).veredicto, 'dudoso');
  assert.equal(por.get(h2).veredicto, 'falso_positivo');
  assert.equal(por.get(h2).razon.length, 300);
  assert.deepEqual(por.get(h3), { huella: h3, veredicto: 'dudoso', razon: 'The triage gave no verdict' });
  assert.equal(por.get(h4).veredicto, 'real');
  assert.equal(leerTriaje(p, 'acme/api', 7, SHA).veredictos.length, 5);
});

test('a failed call writes no file and records a failed cost entry', async () => {
  const { p, deps } = entorno();
  const r = await triarChecks(p, pr, { ...deps, ejecutar: async () => ({ ok: false, costo: 0.1, salida: null, motivoSeguro: 'The job exceeded the maximum time' }) });
  assert.equal(r.ok, false);
  assert.equal(existsSync(rutaTriaje(p.salida, 'acme/api', 7)), false);
  const reg = leerCostos(p).filter((x) => x.tipo === 'triar_checks');
  assert.equal(reg.length, 1);
  assert.equal(reg[0].ok, false);
});

test('45 triable findings send 40, highest severity first', async () => {
  const { p, deps, llamadas, verificaciones } = entorno({ n: 40, severidad: 'medio', extra: Array.from({ length: 5 }, (_, i) => hallazgo(100 + i, 'bloqueante')) });
  const r = await triarChecks(p, pr, deps);
  assert.equal((llamadas[0].prompt.match(/"huella"/g) ?? []).length, 40);
  for (const h of verificaciones.hallazgos.filter((x) => x.severidad === 'bloqueante')) assert.ok(llamadas[0].prompt.includes(h.huella));
  assert.equal(r.resultado.veredictos.length, 40);
});

test('a triage of an older commit is read as outdated; datosChecks reports counts and cap', async () => {
  const { p, verificaciones } = entorno();
  assert.equal(leerTriaje(p, 'acme/api', 7, SHA), null);
  guardarTriaje(p, { ...pr, headSha: 'b'.repeat(40) }, { origen: 'checks', modelo: 'sonnet', modo: 'normal', costo: 0.1, veredictos: [] });
  assert.equal(leerTriaje(p, 'acme/api', 7, SHA).desactualizado, true);
  const d = datosChecks(p, pr, verificaciones);
  assert.equal(d.triables, 3);
  assert.equal(d.topeUsd, 1);
  assert.deepEqual(d.estimacion, { usd: 1, base: 'topes', muestras: 0 });
  assert.deepEqual(d.descartes, []);
  assert.equal(d.triaje.desactualizado, true);
});
