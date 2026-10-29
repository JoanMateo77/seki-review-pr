import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avances, contarHerramienta, fijarAvance, quitarAvance } from '../mcp/lib/avance.mjs';

test('counts reads, searches and edits and records the last file relative to its root', () => {
  fijarAvance('c:1', { fase: 'leyendo' });
  contarHerramienta('c:1', { nombre: 'Read', entrada: { file_path: '/copias/web/src/a.ts' } }, ['/copias/api', '/copias/web']);
  contarHerramienta('c:1', { nombre: 'Read', entrada: { file_path: '/otro/lugar/x/y/z.ts' } }, ['/copias/web']);
  contarHerramienta('c:1', { nombre: 'Grep', entrada: { pattern: 'x' } });
  contarHerramienta('c:1', { nombre: 'Edit', entrada: {} });
  const a = avances()['c:1'];
  assert.equal(a.fase, 'leyendo');
  assert.equal(a.archivos, 2);
  assert.equal(a.busquedas, 1);
  assert.equal(a.ediciones, 1);
  assert.equal(a.ultimo, 'x/y/z.ts');
  quitarAvance('c:1');
  assert.equal(avances()['c:1'], undefined);
});

test('changing phase keeps the counters', () => {
  fijarAvance('pr:a#1', { fase: 'preparando' });
  contarHerramienta('pr:a#1', { nombre: 'Read', entrada: { file_path: '/r/b.ts' } }, '/r');
  fijarAvance('pr:a#1', { fase: 'leyendo' });
  assert.deepEqual([avances()['pr:a#1'].fase, avances()['pr:a#1'].archivos, avances()['pr:a#1'].ultimo], ['leyendo', 1, 'b.ts']);
  quitarAvance('pr:a#1');
});
