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

const scripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test('the built page scripts compile and include the AI mode parts', async () => {
  const { Script } = await import('node:vm');
  const html = construirHtml({ salida: '/nonexistent' }, { prs: [] }, { token: 't' });
  for (const s of scripts(html)) assert.doesNotThrow(() => new Script(s));
  for (const marca of ['id="selModo"', 'data-ultra-abrir', 'data-forzar', 'Blocked by the daily budget', 'Not compared with the base branch', 'Other repositories were not available', '?ultra=1']) {
    assert.ok(html.includes(marca) || leerPlantilla().includes(marca), `missing ${marca}`);
  }
});

test('the AI mode part is evaluated before the script that paints for the first time', () => {
  const orden = JSON.parse(readFileSync(new URL('orden.json', PARTES), 'utf8'));
  assert.ok(orden.indexOf('07b-modos.js') > orden.indexOf('07-script-4.js'));
  assert.ok(orden.indexOf('07b-modos.js') < orden.indexOf('08-script-5.js'));
});
