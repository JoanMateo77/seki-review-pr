import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { construirHtml, leerPlantilla } from '../mcp/lib/tablero.mjs';

const PARTES = new URL('../mcp/tablero/partes/', import.meta.url);

test('every part listed in orden.json exists', () => {
  const orden = JSON.parse(readFileSync(new URL('orden.json', PARTES), 'utf8'));
  assert.ok(orden.length > 0);
  for (const nombre of orden) assert.ok(existsSync(new URL(nombre, PARTES)), `missing part ${nombre}`);
});

test('the assembled template is a complete page', () => {
  const html = leerPlantilla();
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.endsWith('</html>\n'));
});

test('the built page keeps no data marker', () => {
  const html = construirHtml({ salida: '/nonexistent' }, { prs: [] }, null);
  assert.ok(!html.includes('/*DATOS*/'));
  assert.ok(!html.includes('/*ANCLAJE*/'));
});
