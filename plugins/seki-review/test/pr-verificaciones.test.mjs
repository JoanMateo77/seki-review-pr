import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { descartar, huellaHallazgo } from '../mcp/lib/descartes.mjs';
import { leerCostos } from '../mcp/lib/ia.mjs';
import { proyecto as cargarProyecto } from '../mcp/lib/config.mjs';
import { guardarTriaje } from '../mcp/lib/triaje.mjs';
import herramienta from '../mcp/tools/pr_verificaciones.mjs';

const temporales = [];
after(() => { for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true }); });
const SHA = 'a'.repeat(40);

const parche = '@@ -0,0 +1,2 @@\n+<%- item.name %>\n+<%- item.bio %>';
const acceso = (llamadas) => ({
  ghJson: async (args) => { llamadas.push('pr'); return { headRefOid: SHA }; },
  archivosPr: async (owner, repo, numero, sha) => { llamadas.push(`archivos:${sha}`); return [{ filename: 'views/list.ejs', status: 'added', patch: parche }]; },
  commitsPr: async () => { llamadas.push('commits'); return []; },
});

function entorno() {
  const clave = 'pv1';
  const dir = mkdtempSync(join(tmpdir(), 'seki-pr-verif-'));
  temporales.push(dir);
  const salida = join(dir, 'salida');
  mkdirSync(salida, { recursive: true });
  const ruta = join(dir, 'proyectos.json');
  writeFileSync(ruta, JSON.stringify({ [clave]: { owner: 'o', salida, repos: {} } }));
  process.env.SEKI_REVIEW_CONFIG = ruta;
  return { clave, p: cargarProyecto(clave) };
}

test('the PR form returns findings with huella, dismissals, stored triage and the board link, and starts no AI', async () => {
  const e = entorno();
  const llamadas = [];
  const primera = await herramienta.handler({ proyecto: e.clave, repo: 'api', numero: 7 }, acceso(llamadas));
  assert.deepEqual(llamadas, ['pr', `archivos:${SHA}`, 'commits']);
  const ejs = primera.hallazgos.filter((h) => h.regla === 'ejs-sin-escapar');
  assert.equal(ejs.length, 2);
  assert.ok(ejs.every((h) => h.huella === huellaHallazgo(h)));
  assert.deepEqual(primera.descartados, []);
  assert.equal(primera.triaje, null);
  assert.equal(primera.tablero, '#/pr/api/7?checks=1');

  descartar(e.p, 'api', 7, ejs[0], { motivo: 'Escaped upstream', propuestoPor: 'persona' });
  guardarTriaje(e.p, { repo: 'api', numero: 7, headSha: SHA }, { origen: 'checks', modelo: 'm', modo: 'normal', costo: 0.1, veredictos: [{ huella: ejs[1].huella, veredicto: 'real', razon: 'From the request' }] });
  const segunda = await herramienta.handler({ proyecto: e.clave, repo: 'api', numero: 7 }, acceso([]));
  assert.deepEqual(segunda.descartados.map((h) => h.huella), [ejs[0].huella]);
  assert.equal(segunda.descartados[0].descarte.motivo, 'Escaped upstream');
  assert.deepEqual(segunda.hallazgos.filter((h) => h.regla === 'ejs-sin-escapar').map((h) => h.huella), [ejs[1].huella]);
  assert.equal(segunda.triaje.veredictos[0].veredicto, 'real');
  assert.equal(segunda.triaje.desactualizado, false);
  assert.deepEqual(leerCostos(e.p), []);
});
