import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actualizarComentario, fusionarComentarios, guardarComentarios, leerComentarios, recuperarInterrumpidos, rescatarPendientes, separarEnviables } from '../mcp/lib/comentarios.mjs';

const p = () => ({ salida: mkdtempSync(join(tmpdir(), 'pw-com-')) });
const base = { tipo: 'pregunta', archivo: 'a.ts', lado: 'nuevo', desde: 1, hasta: 1, claves: ['n1'], textoOriginal: 'x', texto: '¿Por qué?', headSha: 'abc' };

test('fusionar: gana el más reciente', () => {
  const r = fusionarComentarios(
    [{ ...base, id: 'c-0001', estado: 'borrador', texto: 'viejo', actualizado: '2026-10-27T10:00:00Z' }],
    [{ ...base, id: 'c-0001', estado: 'borrador', texto: 'nuevo', actualizado: '2026-10-27T11:00:00Z' }],
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].texto, 'nuevo');
});

test('fusionar: el navegador no devuelve a borrador lo que el servidor avanzó', () => {
  const r = fusionarComentarios(
    [{ ...base, id: 'c-0001', estado: 'respondido', respuesta: 'Porque sí.', actualizado: '2026-10-27T10:00:00Z' }],
    [{ ...base, id: 'c-0001', estado: 'borrador', actualizado: '2026-10-27T11:00:00Z' }],
  );
  assert.equal(r[0].estado, 'respondido');
  assert.equal(r[0].respuesta, 'Porque sí.');
});

test('guardar y leer sobreviven a reabrir', () => {
  const pr = p();
  guardarComentarios(pr, 'api', 7, [{ ...base, id: 'c-0001', estado: 'borrador', actualizado: '2026-10-27T10:00:00Z' }]);
  const leidos = leerComentarios({ salida: pr.salida }, 'api', 7);
  assert.equal(leidos.length, 1);
  assert.equal(leidos[0].id, 'c-0001');
});

test('guardar rechaza tipo desconocido', () => {
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ ...base, id: 'c-0001', tipo: 'otro', estado: 'borrador' }]), /tipo/);
});

test('guardar rechaza texto demasiado largo', () => {
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ ...base, id: 'c-0001', estado: 'borrador', texto: 'x'.repeat(4001) }]), /texto/);
});

test('actualizarComentario cambia solo ese comentario y marca la fecha', () => {
  const pr = p();
  guardarComentarios(pr, 'r', 1, [{ ...base, id: 'c-0001', estado: 'borrador' }, { ...base, id: 'c-0002', estado: 'borrador' }]);
  actualizarComentario(pr, 'r', 1, 'c-0002', { estado: 'en_cola' });
  const c = actualizarComentario(pr, 'r', 1, 'c-0001', { estado: 'respondido', respuesta: 'Ok.' });
  assert.equal(c.estado, 'respondido');
  assert.ok(c.actualizado);
  assert.equal(leerComentarios(pr, 'r', 1).find((x) => x.id === 'c-0002').estado, 'en_cola');
});

test('guardar borra solo borradores y notas pedidos por el navegador', () => {
  const pr = p();
  guardarComentarios(pr, 'r', 1, [{ ...base, id: 'c-0001', estado: 'borrador' }, { ...base, id: 'c-0002', estado: 'borrador' }]);
  actualizarComentario(pr, 'r', 1, 'c-0002', { estado: 'respondido' });
  const r = guardarComentarios(pr, 'r', 1, [], ['c-0001', 'c-0002']);
  assert.deepEqual(r.map((c) => c.id), ['c-0002']);
});

test('guardar desde el navegador solo acepta borrador o nota', () => {
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ ...base, id: 'c-0001', estado: '<img src=x onerror=alert(1)>' }]), /estado/);
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ ...base, id: 'c-0001', estado: 'respondido' }]), /estado/);
});

test('guardar valida lado, rango y claves', () => {
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ ...base, id: 'c-0001', estado: 'borrador', lado: 'x' }]), /lado/);
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ ...base, id: 'c-0001', estado: 'borrador', desde: '1<b>' }]), /rango/);
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ ...base, id: 'c-0001', estado: 'borrador', claves: ['<x>'] }]), /claves/);
});

test('guardar descarta campos que solo pone el servidor', () => {
  const [c] = guardarComentarios(p(), 'r', 1, [{ ...base, id: 'c-0001', estado: 'borrador', respuesta: 'falsa', propuestaId: 'p-x', costo: '<b>' }]);
  assert.equal(c.respuesta, undefined);
  assert.equal(c.propuestaId, undefined);
  assert.equal(c.costo, undefined);
});

test('rescatarPendientes pasa a error solo los que siguen pendientes', () => {
  const pr = p();
  guardarComentarios(pr, 'r', 1, [{ ...base, id: 'c-0001', estado: 'borrador' }, { ...base, id: 'c-0002', estado: 'borrador' }]);
  actualizarComentario(pr, 'r', 1, 'c-0001', { estado: 'en_curso' });
  actualizarComentario(pr, 'r', 1, 'c-0002', { estado: 'respondido', respuesta: 'ok' });
  rescatarPendientes(pr, 'r', 1, ['c-0001', 'c-0002'], { estado: 'error', motivo: 'falló git' });
  const [a, b] = leerComentarios(pr, 'r', 1);
  assert.deepEqual([a.estado, a.motivo], ['error', 'falló git']);
  assert.equal(b.estado, 'respondido');
});

test('recuperarInterrumpidos marca en error lo que quedó en cola o en curso', () => {
  const pr = p();
  guardarComentarios(pr, 'r', 1, [{ ...base, id: 'c-0001', estado: 'borrador' }, { ...base, id: 'c-0002', estado: 'borrador' }]);
  actualizarComentario(pr, 'r', 1, 'c-0001', { estado: 'en_cola' });
  assert.equal(recuperarInterrumpidos(pr), 1);
  const [a, b] = leerComentarios(pr, 'r', 1);
  assert.equal(a.estado, 'error');
  assert.match(a.motivo, /reinició/);
  assert.equal(b.estado, 'borrador');
});

test('separarEnviables aparta los comentarios de otro commit', () => {
  const lista = [
    { ...base, id: 'c-0001', estado: 'borrador', tipo: 'pregunta' },
    { ...base, id: 'c-0002', estado: 'error', tipo: 'cambio' },
    { ...base, id: 'c-0003', estado: 'borrador', tipo: 'cambio', headSha: 'viejo' },
    { ...base, id: 'c-0004', estado: 'respondido', tipo: 'pregunta' },
  ];
  const r = separarEnviables(lista, ['c-0001', 'c-0002', 'c-0003', 'c-0004'], 'abc');
  assert.deepEqual(r.preguntas, ['c-0001']);
  assert.deepEqual(r.cambios, ['c-0002']);
  assert.deepEqual(r.desactualizados, ['c-0003']);
});

test('una pregunta sobre la PR no necesita archivo ni líneas', () => {
  const [c] = guardarComentarios(p(), 'r', 1, [{ id: 'c-0001', tipo: 'pregunta', estado: 'borrador', ambito: 'pr', seccion: 'por_que', texto: '¿Por qué 404?', headSha: 'abc' }]);
  assert.equal(c.ambito, 'pr');
  assert.equal(c.seccion, 'por_que');
});

test('una pregunta sobre la PR solo acepta secciones conocidas', () => {
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ id: 'c-0001', tipo: 'pregunta', estado: 'borrador', ambito: 'pr', seccion: '<x>', texto: 'x' }]), /sección/);
  assert.throws(() => guardarComentarios(p(), 'r', 1, [{ id: 'c-0001', tipo: 'cambio', estado: 'borrador', ambito: 'pr', texto: 'x' }]), /pregunta/);
});
