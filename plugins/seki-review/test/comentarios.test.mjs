import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actualizarComentario, fusionarComentarios, guardarComentarios, leerComentarios, recuperarInterrumpidos, rescatarPendientes, separarEnviables } from '../mcp/lib/comentarios.mjs';

const p = () => ({ salida: mkdtempSync(join(tmpdir(), 'seki-com-')) });
const base = { tipo: 'pregunta', archivo: 'a.ts', lado: 'nuevo', desde: 1, hasta: 1, claves: ['n1'], textoOriginal: 'x', texto: 'Why?', headSha: 'abc' };

test('merge: the most recent wins', () => {
  const r = fusionarComentarios(
    [{ ...base, id: 'c-0001', estado: 'borrador', texto: 'old', actualizado: '2026-10-27T10:00:00Z' }],
    [{ ...base, id: 'c-0001', estado: 'borrador', texto: 'new', actualizado: '2026-10-27T11:00:00Z' }],
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].texto, 'new');
});

test('merge: the browser does not revert to draft what the server advanced', () => {
  const r = fusionarComentarios(
    [{ ...base, id: 'c-0001', estado: 'respondido', respuesta: 'Just because.', actualizado: '2026-10-27T10:00:00Z' }],
    [{ ...base, id: 'c-0001', estado: 'borrador', actualizado: '2026-10-27T11:00:00Z' }],
  );
  assert.equal(r[0].estado, 'respondido');
  assert.equal(r[0].respuesta, 'Just because.');
});

test('save and read survive reopening', () => {
  const pr = p();
  guardarComentarios(pr, 'api', 7, [{ ...base, id: 'c-0001', estado: 'borrador', actualizado: '2026-10-27T10:00:00Z' }]);
  const leidos = leerComentarios({ salida: pr.salida }, 'api', 7);
  assert.equal(leidos.length, 1);
  assert.equal(leidos[0].id, 'c-0001');
});

test('save rejects an unknown type', () => {
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ ...base, id: 'c-0001', tipo: 'otro', estado: 'borrador' }]), /type/);
});

test('save rejects text that is too long', () => {
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ ...base, id: 'c-0001', estado: 'borrador', texto: 'x'.repeat(4001) }]), /text/);
});

test('actualizarComentario changes only that comment and stamps the date', () => {
  const pr = p();
  guardarComentarios(pr, 'r', 1, [{ ...base, id: 'c-0001', estado: 'borrador' }, { ...base, id: 'c-0002', estado: 'borrador' }]);
  actualizarComentario(pr, 'r', 1, 'c-0002', { estado: 'en_cola' });
  const c = actualizarComentario(pr, 'r', 1, 'c-0001', { estado: 'respondido', respuesta: 'Ok.' });
  assert.equal(c.estado, 'respondido');
  assert.ok(c.actualizado);
  assert.equal(leerComentarios(pr, 'r', 1).find((x) => x.id === 'c-0002').estado, 'en_cola');
});

test('save deletes only drafts and notes requested by the browser', () => {
  const pr = p();
  guardarComentarios(pr, 'r', 1, [{ ...base, id: 'c-0001', estado: 'borrador' }, { ...base, id: 'c-0002', estado: 'borrador' }]);
  actualizarComentario(pr, 'r', 1, 'c-0002', { estado: 'respondido' });
  const r = guardarComentarios(pr, 'r', 1, [], ['c-0001', 'c-0002']);
  assert.deepEqual(r.map((c) => c.id), ['c-0002']);
});

test('save from the browser only accepts draft or note', () => {
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ ...base, id: 'c-0001', estado: '<img src=x onerror=alert(1)>' }]), /state/);
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ ...base, id: 'c-0001', estado: 'respondido' }]), /state/);
});

test('save validates side, range and keys', () => {
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ ...base, id: 'c-0001', estado: 'borrador', lado: 'x' }]), /side/);
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ ...base, id: 'c-0001', estado: 'borrador', desde: '1<b>' }]), /range/);
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ ...base, id: 'c-0001', estado: 'borrador', claves: ['<x>'] }]), /keys/);
});

test('save drops fields only the server sets', () => {
  const [c] = guardarComentarios(p(), 'r', 1, [{ ...base, id: 'c-0001', estado: 'borrador', respuesta: 'fake', propuestaId: 'p-x', costo: '<b>' }]);
  assert.equal(c.respuesta, undefined);
  assert.equal(c.propuestaId, undefined);
  assert.equal(c.costo, undefined);
});

test('rescatarPendientes moves to error only those still pending', () => {
  const pr = p();
  guardarComentarios(pr, 'r', 1, [{ ...base, id: 'c-0001', estado: 'borrador' }, { ...base, id: 'c-0002', estado: 'borrador' }]);
  actualizarComentario(pr, 'r', 1, 'c-0001', { estado: 'en_curso' });
  actualizarComentario(pr, 'r', 1, 'c-0002', { estado: 'respondido', respuesta: 'ok' });
  rescatarPendientes(pr, 'r', 1, ['c-0001', 'c-0002'], { estado: 'error', motivo: 'git failed' });
  const [a, b] = leerComentarios(pr, 'r', 1);
  assert.deepEqual([a.estado, a.motivo], ['error', 'git failed']);
  assert.equal(b.estado, 'respondido');
});

test('recuperarInterrumpidos marks as error whatever was left queued or in progress', () => {
  const pr = p();
  guardarComentarios(pr, 'r', 1, [{ ...base, id: 'c-0001', estado: 'borrador' }, { ...base, id: 'c-0002', estado: 'borrador' }]);
  actualizarComentario(pr, 'r', 1, 'c-0001', { estado: 'en_cola' });
  assert.equal(recuperarInterrumpidos(pr), 1);
  const [a, b] = leerComentarios(pr, 'r', 1);
  assert.equal(a.estado, 'error');
  assert.match(a.motivo, /restarted/);
  assert.equal(b.estado, 'borrador');
});

test('separarEnviables sets aside comments from another commit', () => {
  const lista = [
    { ...base, id: 'c-0001', estado: 'borrador', tipo: 'pregunta' },
    { ...base, id: 'c-0002', estado: 'error', tipo: 'cambio' },
    { ...base, id: 'c-0003', estado: 'borrador', tipo: 'cambio', headSha: 'old' },
    { ...base, id: 'c-0004', estado: 'respondido', tipo: 'pregunta' },
  ];
  const r = separarEnviables(lista, ['c-0001', 'c-0002', 'c-0003', 'c-0004'], 'abc');
  assert.deepEqual(r.preguntas, ['c-0001']);
  assert.deepEqual(r.cambios, ['c-0002']);
  assert.deepEqual(r.desactualizados, ['c-0003']);
});

test('a question about the PR needs no file or lines', () => {
  const [c] = guardarComentarios(p(), 'r', 1, [{ id: 'c-0001', tipo: 'pregunta', estado: 'borrador', ambito: 'pr', seccion: 'por_que', texto: 'Why 404?', headSha: 'abc' }]);
  assert.equal(c.ambito, 'pr');
  assert.equal(c.seccion, 'por_que');
});

test('a question about the PR only accepts known sections', () => {
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ id: 'c-0001', tipo: 'pregunta', estado: 'borrador', ambito: 'pr', seccion: '<x>', texto: 'x' }]), /section/);
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ id: 'c-0001', tipo: 'cambio', estado: 'borrador', ambito: 'pr', texto: 'x' }]), /question/);
});

test('a question about the PR stores the quoted text and limits it', () => {
  const [c] = guardarComentarios(p(), 'r', 1, [{ id: 'c-0001', tipo: 'pregunta', estado: 'borrador', ambito: 'pr', seccion: 'orden_lectura', citado: 'Webhook PostPaymentInfo disabled.', texto: 'How is it enabled?' }]);
  assert.equal(c.citado, 'Webhook PostPaymentInfo disabled.');
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ id: 'c-0002', tipo: 'pregunta', estado: 'borrador', ambito: 'pr', citado: 'x'.repeat(2001), texto: 'x' }]), /quoted/);
});

test('a question can reply to another and ask to inspect the code', () => {
  const [c] = guardarComentarios(p(), 'r', 1, [{ id: 'c-0002', tipo: 'pregunta', estado: 'borrador', ambito: 'pr', respondeA: 'c-0001', investigar: true, texto: 'And in the code?' }]);
  assert.equal(c.respondeA, 'c-0001');
  assert.equal(c.investigar, true);
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ id: 'c-0003', tipo: 'pregunta', estado: 'borrador', ambito: 'pr', respondeA: '../x', texto: 'x' }]), /replies/);
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ id: 'c-0003', tipo: 'pregunta', estado: 'borrador', ambito: 'pr', investigar: 'si', texto: 'x' }]), /investigar/);
});

test('an answer quote requires the quoted text and the thread it replies to', () => {
  const base = { tipo: 'pregunta', estado: 'borrador', ambito: 'pr', texto: 'Why?' };
  const [c] = guardarComentarios(p(), 'r', 1, [{ ...base, id: 'c-0003', respondeA: 'c-0001', citado: 'fragment', citadoDe: 'respuesta' }]);
  assert.equal(c.citadoDe, 'respuesta');
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ ...base, id: 'c-0004', citado: 'fragment', citadoDe: 'respuesta' }]), /answer quote/);
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ ...base, id: 'c-0005', respondeA: 'c-0001', citado: 'f', citadoDe: 'otro' }]), /answer quote/);
});
