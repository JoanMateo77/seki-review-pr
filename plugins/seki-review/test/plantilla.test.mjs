import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { construirHtml, leerPlantilla } from '../mcp/lib/tablero.mjs';

const HASH_PLANTILLA_0_20 = '18f5d3c0f11624719214f59322c1285b5d60dff53203fd597f32f34e2efe07cd';

test('the assembled template is byte-identical to the original single file', () => {
  assert.equal(createHash('sha256').update(leerPlantilla()).digest('hex'), HASH_PLANTILLA_0_20);
});

test('the built page keeps no data marker', () => {
  const html = construirHtml({ salida: '/nonexistent' }, { prs: [] }, null);
  assert.ok(!html.includes('/*DATOS*/'));
  assert.ok(!html.includes('/*ANCLAJE*/'));
});
