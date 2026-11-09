import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comentariosDePlantillas } from '../mcp/lib/comentarios-plantilla.mjs';

const falla = (o = {}) => ({
  id: 'S1', pregunta: 'q', siFalla: { etiqueta: 'issue', bloqueante: true, tema: 'security' },
  estado: 'falla', origen: 'ia', archivo: 'src/a.ts', linea: 12, cita: 'const x = 1;',
  titulo: 'Secret in code', detalle: 'Move it to env.', veredicto: 'CONFIRMED', ...o,
});
const res = (items, o = {}) => ({ plantillas: [{ id: 't', version: 1, titulo: 'T', idioma: 'en', ok: true, costo: 0, items, ...o }] });

test('a confirmed blocking failure renders as issue (blocking, security) with file, quote and reference', () => {
  const r = comentariosDePlantillas(res([falla()]));
  assert.equal(r.comentarios.length, 1);
  assert.equal(r.comentarios[0].bloqueante, true);
  assert.equal(r.markdown, '**issue (blocking, security): Secret in code**\n`src/a.ts:12`\n> const x = 1;\n\nMove it to env.\n_[t/S1]_');
  assert.equal(r.recortados, 0);
});

test('an unverified blocking failure is non-blocking', () => {
  const r = comentariosDePlantillas(res([falla({ veredicto: null }), falla({ id: 'S2', veredicto: 'PLAUSIBLE' })]));
  assert.deepEqual(r.comentarios.map((c) => c.decoraciones), [['non-blocking', 'security'], ['non-blocking', 'security']]);
  assert.ok(r.comentarios.every((c) => !c.bloqueante));
});

test('a deterministic failure is blocking without verification and uses the rule message as subject', () => {
  const r = comentariosDePlantillas(res([falla({
    origen: 'determinista', veredicto: undefined, titulo: undefined, cita: undefined,
    hallazgos: [{ regla: 'r', mensaje: 'Rule says no', archivo: 'src/a.ts', linea: 12, texto: 'bad()' }],
  })]));
  const c = r.comentarios[0];
  assert.equal(c.asunto, 'Rule says no');
  assert.equal(c.cita, 'bad()');
  assert.equal(c.bloqueante, true);
  assert.deepEqual(c.decoraciones, ['blocking', 'security']);
});

test('nitpick has no blocking decoration and no parentheses without decorations', () => {
  const r = comentariosDePlantillas(res([falla({ siFalla: { etiqueta: 'nitpick', bloqueante: false }, cita: 'a\nb' })]));
  assert.deepEqual(r.comentarios[0].decoraciones, []);
  assert.equal(r.markdown.split('\n')[0], '**nitpick: Secret in code**');
  assert.ok(r.markdown.includes('\n> a b\n'));
});

test('blocking comments come first, at most five per template, and the cut is counted', () => {
  const nb = (i) => falla({ id: `N${i}`, veredicto: null, titulo: `n${i}` });
  const items = [nb(1), nb(2), nb(3), nb(4), nb(5), nb(6), falla({ id: 'B1', titulo: 'b1' })];
  const r = comentariosDePlantillas(res(items));
  assert.equal(r.comentarios.length, 5);
  assert.equal(r.comentarios[0].ref, 't/B1');
  assert.deepEqual(r.comentarios.slice(1).map((c) => c.ref), ['t/N1', 't/N2', 't/N3', 't/N4']);
  assert.equal(r.recortados, 2);
});

test('one praise from the first quoted cumple and one not-verifiable block in the template language', () => {
  const r = comentariosDePlantillas(res([
    { id: 'A', pregunta: 'a?', siFalla: { etiqueta: 'issue', bloqueante: false }, estado: 'cumple', origen: 'ia', titulo: 'Sin cita' },
    { id: 'B', pregunta: 'b?', siFalla: { etiqueta: 'issue', bloqueante: false }, estado: 'cumple', origen: 'ia', archivo: 'x.ts', linea: 3, cita: 'ok()', titulo: 'Bien hecho' },
    { id: 'C', pregunta: 'c?', siFalla: { etiqueta: 'issue', bloqueante: false }, estado: 'cumple', origen: 'ia', cita: 'z', titulo: 'Otro' },
    { id: 'D', pregunta: 'd?', siFalla: { etiqueta: 'issue', bloqueante: false }, estado: 'no_verificable', origen: 'ia', pedido: 'Show the config', motivo: 'm' },
    { id: 'E', pregunta: 'e?', siFalla: { etiqueta: 'issue', bloqueante: false }, estado: 'no_verificable', origen: 'ia', motivo: 'No access' },
  ], { idioma: 'es' }));
  assert.equal(r.markdown, [
    '**praise: Bien hecho**\n`x.ts:3`\n> ok()\n_[t/B]_',
    '**No se pudo verificar desde el diff**\n- d? — Show the config',
  ].join('\n\n'));
  assert.equal(r.comentarios.length, 0);
});

test('not-verifiable heading is English by default', () => {
  const r = comentariosDePlantillas(res([
    { id: 'D', pregunta: 'd?', siFalla: { etiqueta: 'issue', bloqueante: false }, estado: 'no_verificable', origen: 'ia', pedido: 'p' },
  ], { idioma: undefined }));
  assert.equal(r.markdown, '**Not verifiable from the diff**\n- d? — p');
});

test('not-verifiable items with only an internal reason are left out of the Markdown', () => {
  const r = comentariosDePlantillas(res([
    { id: 'E', pregunta: 'e?', siFalla: { etiqueta: 'issue', bloqueante: false }, estado: 'no_verificable', origen: 'ia', motivo: 'The template review failed' },
    { id: 'F', pregunta: 'f?', siFalla: { etiqueta: 'issue', bloqueante: false }, estado: 'no_verificable', origen: 'ia', pedido: '  ', motivo: 'x' },
  ]));
  assert.equal(r.markdown, '');
});

test('an empty result produces empty markdown', () => {
  assert.deepEqual(comentariosDePlantillas({ plantillas: [] }), { comentarios: [], markdown: '', recortados: 0 });
  assert.deepEqual(comentariosDePlantillas({}), { comentarios: [], markdown: '', recortados: 0 });
  assert.equal(comentariosDePlantillas(res([falla({ estado: 'no_aplica' })])).markdown, '');
});

test('a nitpick never blocks even when flagged blocking and confirmed', () => {
  const nit = falla({ id: 'N', siFalla: { etiqueta: 'nitpick', bloqueante: true } });
  const r = comentariosDePlantillas(res([nit, falla({ id: 'B' })]));
  assert.equal(r.comentarios.find((c) => c.ref === 't/N').bloqueante, false);
  assert.deepEqual(r.comentarios.find((c) => c.ref === 't/N').decoraciones, []);
  assert.equal(r.comentarios[0].ref, 't/B');
});

test('the cap of five applies per template', () => {
  const seis = (pre) => Array.from({ length: 6 }, (_, i) => falla({ id: `${pre}${i}`, veredicto: null }));
  const r = comentariosDePlantillas({ plantillas: [
    { id: 'a', idioma: 'en', ok: true, items: seis('A') },
    { id: 'b', idioma: 'en', ok: true, items: seis('B') },
  ] });
  assert.equal(r.comentarios.length, 10);
  assert.equal(r.recortados, 2);
});

test('a file without line renders only the file', () => {
  const r = comentariosDePlantillas(res([falla({ linea: undefined })]));
  assert.equal(r.markdown.split('\n')[1], '`src/a.ts`');
});

test('praise falls back to the question when there is no title', () => {
  const r = comentariosDePlantillas(res([
    { id: 'A', pregunta: 'Is it fine?', siFalla: { etiqueta: 'issue', bloqueante: false }, estado: 'cumple', origen: 'ia', cita: 'ok()' },
  ]));
  assert.equal(r.markdown.split('\n')[0], '**praise: Is it fine?**');
});
