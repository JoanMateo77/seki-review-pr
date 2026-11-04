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

test('near the 0.6 threshold: 5/9 shared tokens is not a twin, 5/8 and exactly 3/5 are', () => {
  const base = 'alpha bravo charlie delta echo';
  const debajo = parecido(`${base} foxtrot golf`, `${base} hotel india`);
  const encima = parecido(`${base} foxtrot`, `${base} hotel india`);
  assert.equal(+debajo.toFixed(3), 0.556);
  assert.equal(encima, 0.625);
  assert.equal(parecido('alpha bravo charlie delta', 'alpha bravo charlie echo'), 0.6);
  assert.equal(buscarGemela(`${base} foxtrot golf`, [{ number: 1, state: 'OPEN', title: `${base} hotel india` }]), null);
  assert.equal(buscarGemela(`${base} foxtrot`, [{ number: 2, state: 'OPEN', title: `${base} hotel india` }]).numero, 2);
  assert.equal(buscarGemela('alpha bravo charlie delta', [{ number: 3, state: 'OPEN', title: 'alpha bravo charlie echo' }]).parecido, 0.6);
});
