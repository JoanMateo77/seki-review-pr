import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aplicarDescartes, descartar, huellaHallazgo, leerDescartes, reabrir, REGLAS_NO_TRIABLES, TRIABLES, triablesOrdenados } from '../mcp/lib/descartes.mjs';
import { resumir, verificar } from '../mcp/lib/verificar.mjs';

const p = () => ({ salida: mkdtempSync(join(tmpdir(), 'seki-desc-')) });
const h = { regla: 'ejs-sin-escapar', titulo: 'Unescaped output', severidad: 'alto', archivo: 'views/list.ejs', linea: 4, texto: '<%- item.name %>', mensaje: 'm', origen: 'regla' };

test('fingerprint ignores line and inner spaces, follows the text', () => {
  assert.equal(huellaHallazgo({ ...h, linea: 90 }), huellaHallazgo(h));
  assert.equal(huellaHallazgo({ ...h, texto: '<%-   item.name   %>' }), huellaHallazgo({ ...h, texto: '<%- item.name %>' }));
  assert.notEqual(huellaHallazgo({ ...h, texto: '<%- item.id %>' }), huellaHallazgo(h));
  assert.notEqual(huellaHallazgo({ ...h, regla: 'otra-regla' }), huellaHallazgo(h));
  assert.notEqual(huellaHallazgo({ ...h, archivo: 'views/other.ejs' }), huellaHallazgo(h));
  assert.match(huellaHallazgo(h), /^[0-9a-f]{16}$/);
});

test('lines over 200 characters that differ only after column 200 get different fingerprints and dismissals', () => {
  const cola = 'x'.repeat(250);
  const archivos = [{ filename: 'views/list.ejs', status: 'added', patch: `@@ -0,0 +1,2 @@\n+<%- item.name %>${cola}A\n+<%- item.name %>${cola}B` }];
  const [a, b] = verificar({ repo: 'demo', archivos }).hallazgos.filter((x) => x.regla === 'ejs-sin-escapar');
  assert.equal(a.texto, b.texto);
  assert.match(a.hashLinea, /^[0-9a-f]{16}$/);
  assert.notEqual(huellaHallazgo(a), huellaHallazgo(b));
  const pr = p();
  descartar(pr, 'api', 1, a, { motivo: 'Literal', propuestoPor: 'persona' });
  assert.equal(leerDescartes(pr, 'api', 1)[0].hashLinea, a.hashLinea);
  const r = aplicarDescartes({ hallazgos: [a, b] }, leerDescartes(pr, 'api', 1));
  assert.deepEqual(r.descartados.map((x) => x.huella), [huellaHallazgo(a)]);
  assert.deepEqual(r.hallazgos.map((x) => x.huella), [huellaHallazgo(b)]);
});

test('a cached finding without hashLinea keeps the fingerprint of its text', () => {
  assert.equal(huellaHallazgo({ ...h, hashLinea: undefined }), huellaHallazgo(h));
  assert.notEqual(huellaHallazgo({ ...h, hashLinea: '0123456789abcdef' }), huellaHallazgo(h));
});

test('descartar validates motivo and propuestoPor', () => {
  const pr = p();
  assert.throws(() => descartar(pr, 'api', 1, h, { motivo: '', propuestoPor: 'persona' }), /motivo/);
  assert.throws(() => descartar(pr, 'api', 1, h, { motivo: '  ', propuestoPor: 'persona' }), /motivo/);
  assert.throws(() => descartar(pr, 'api', 1, h, { motivo: 'x'.repeat(501), propuestoPor: 'persona' }), /motivo/);
  assert.throws(() => descartar(pr, 'api', 1, h, { motivo: 'ok', propuestoPor: 'otro' }), /propuestoPor/);
  assert.deepEqual(leerDescartes(pr, 'api', 1), []);
});

test('dismissing twice keeps one entry with the last motivo', () => {
  const pr = p();
  const d = descartar(pr, 'api', 1, h, { motivo: ' first ', propuestoPor: 'ia' });
  assert.equal(d.autor, 'persona');
  assert.equal(d.propuestoPor, 'ia');
  assert.equal(d.motivo, 'first');
  descartar(pr, 'api', 1, h, { motivo: 'second', propuestoPor: 'persona' });
  const todos = leerDescartes(pr, 'api', 1);
  assert.equal(todos.length, 1);
  assert.equal(todos[0].motivo, 'second');
  assert.equal(todos[0].huella, huellaHallazgo(h));
});

test('aplicarDescartes moves the finding and leaves the input untouched', () => {
  const pr = p();
  const otro = { ...h, regla: 'otra', severidad: 'medio', texto: 'x' };
  const hallazgos = [h, otro];
  const entrada = { headSha: 'abc', hallazgos, resumen: resumir(hallazgos) };
  const copia = structuredClone(entrada);
  descartar(pr, 'api', 1, h, { motivo: 'Safe here', propuestoPor: 'persona' });
  const r = aplicarDescartes(entrada, leerDescartes(pr, 'api', 1));
  assert.deepEqual(entrada, copia);
  assert.equal(r.headSha, 'abc');
  assert.equal(r.hallazgos.length, 1);
  assert.equal(r.hallazgos[0].huella, huellaHallazgo(otro));
  assert.equal(r.descartados.length, 1);
  assert.equal(r.descartados[0].descarte.motivo, 'Safe here');
  assert.equal(r.resumen.alto, entrada.resumen.alto - 1);
  assert.equal(r.resumen.medio, 1);
});

test('reabrir removes an entry and returns false for an unknown huella', () => {
  const pr = p();
  descartar(pr, 'api', 1, h, { motivo: 'ok', propuestoPor: 'persona' });
  assert.equal(reabrir(pr, 'api', 1, 'nope'), false);
  assert.equal(reabrir(pr, 'api', 1, huellaHallazgo(h)), true);
  assert.deepEqual(leerDescartes(pr, 'api', 1), []);
});

test('TRIABLES holds the three upper severities', () => {
  assert.deepEqual([...TRIABLES].sort(), ['alto', 'bloqueante', 'medio']);
});

test('triablesOrdenados keeps triable severities, highest first, at most 40, each with its fingerprint', () => {
  const f = (severidad, texto) => ({ regla: 'r', archivo: 'a', severidad, texto });
  const lista = [f('bajo', 'l'), f('medio', 'm'), f('alto', 'a'), f('bloqueante', 'b'), ...Array.from({ length: 45 }, (_, i) => f('medio', `x${i}`))];
  const r = triablesOrdenados(lista);
  assert.equal(r.length, 40);
  assert.deepEqual(r.slice(0, 3).map((h) => h.severidad), ['bloqueante', 'alto', 'medio']);
  assert.ok(r.every((h) => h.huella === huellaHallazgo(h)));
  assert.deepEqual(triablesOrdenados(undefined), []);
});

test('findings of a rule that is not triable are never selected for the AI', () => {
  assert.deepEqual([...REGLAS_NO_TRIABLES], ['atribucion-ia']);
  const atribucion = { regla: 'atribucion-ia', archivo: 'commit abc1234', severidad: 'alto', texto: 'feat: x' };
  assert.deepEqual(triablesOrdenados([atribucion, h]).map((x) => x.regla), ['ejs-sin-escapar']);
});

test('two processes dismissing at once do not lose entries', async () => {
  const pr = p();
  const guion = `
    import { descartar } from ${JSON.stringify(new URL('../mcp/lib/descartes.mjs', import.meta.url).href)};
    const [salida, id] = process.argv.slice(1);
    for (let i = 0; i < 25; i++) descartar({ salida }, 'api', 1, { regla: 'r', archivo: 'a', texto: id + i }, { motivo: 'ok', propuestoPor: 'persona' });
  `;
  const correr = (id) => new Promise((resolver, rechazar) => {
    const hijo = spawn(process.execPath, ['--input-type=module', '-e', guion, pr.salida, id], { stdio: 'inherit' });
    hijo.on('exit', (codigo) => (codigo === 0 ? resolver() : rechazar(new Error(`child ${id} exited with ${codigo}`))));
  });
  await Promise.all([correr('a'), correr('b')]);
  assert.equal(leerDescartes(pr, 'api', 1).length, 50);
});
