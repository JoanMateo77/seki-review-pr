import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actualizarComentario, fusionarComentarios, guardarComentarios, leerComentarios } from '../mcp/lib/comentarios.mjs';

const p = () => ({ salida: mkdtempSync(join(tmpdir(), 'pw-com-')) });
const base = { tipo: 'pregunta', archivo: 'a.ts', lado: 'nuevo', desde: 1, hasta: 1, textoOriginal: 'x', texto: '¿Por qué?', headSha: 'abc' };

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
  guardarComentarios(pr, 'r', 1, [{ ...base, id: 'c-0001', estado: 'en_cola' }, { ...base, id: 'c-0002', estado: 'en_cola' }]);
  const c = actualizarComentario(pr, 'r', 1, 'c-0001', { estado: 'respondido', respuesta: 'Ok.' });
  assert.equal(c.estado, 'respondido');
  assert.ok(c.actualizado);
  assert.equal(leerComentarios(pr, 'r', 1).find((x) => x.id === 'c-0002').estado, 'en_cola');
});

test('guardar borra solo borradores y notas pedidos por el navegador', () => {
  const pr = p();
  guardarComentarios(pr, 'r', 1, [{ ...base, id: 'c-0001', estado: 'borrador' }, { ...base, id: 'c-0002', estado: 'respondido' }]);
  const r = guardarComentarios(pr, 'r', 1, [], ['c-0001', 'c-0002']);
  assert.deepEqual(r.map((c) => c.id), ['c-0002']);
});
