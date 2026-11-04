import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buscarGemela, parecido, tokensTitulo } from '../mcp/lib/gemelas.mjs';

test('tokensTitulo strips the conventional prefix and brackets', () => {
  assert.deepEqual(tokensTitulo('fix(lotes): Fecha [pruebas]'), new Set(['fecha']));
  assert.deepEqual(tokensTitulo('[Pruebas] feat: Cargue masivo de lotes'), new Set(['cargue', 'masivo', 'lotes']));
});

test('parecido is 1 for identical titles and 0 for disjoint ones', () => {
  assert.equal(parecido('fix: Fecha de corte', 'fix: Fecha de corte'), 1);
  assert.equal(parecido('fix: Fecha de corte', 'feat: Reporte mensual'), 0);
});

test('buscarGemela returns the best candidate at or above the threshold, else null', () => {
  const candidatas = [
    { number: 7, state: 'OPEN', title: 'feat: Reporte mensual' },
    { number: 9, state: 'OPEN', title: 'fix(lotes): Fecha de corte [pruebas]' },
  ];
  const g = buscarGemela('fix(lotes): Fecha de corte', candidatas);
  assert.equal(g.numero, 9);
  assert.equal(g.parecido, 1);
  assert.equal(buscarGemela('chore: Actualizar dependencias', candidatas), null);
});
