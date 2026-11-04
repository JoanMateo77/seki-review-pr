// Dedicated file: the time zone is fixed before any Date is built, so the local-date rule is deterministic.
process.env.TZ = 'America/Bogota';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cambiosPendientes } from '../mcp/lib/rastreador-xlsx.mjs';
import { trackerFixture } from './util/xlsx-fixture.mjs';

const dir = mkdtempSync(join(tmpdir(), 'seki-zona-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('merge dates are written as local calendar days', () => {
  assert.equal(new Date('2026-03-02T01:30:00Z').getDate(), 1);
  const ruta = join(dir, 'tracker.xlsx');
  writeFileSync(ruta, trackerFixture());
  const cfg = {
    tipo: 'xlsx', ruta, hoja: 'Sheet1', filaEncabezado: 1, columnaId: 'ID', lectura: {},
    columnas: { estado: null, prPruebas: null, prProd: null, enPruebas: 'In testing', enProd: null }, estados: {}, escribir: true,
  };
  const prs = new Map([['r#1', { id: 'r#1', ambiente: 'pruebas', url: 'u', mergeada: '2026-03-02T01:30:00Z' }]]);
  const c = cambiosPendientes(cfg, [{ ids: ['X-001'], etapa: 'esperando_qa', prs: ['r#1'] }], prs);
  assert.equal(c[0].nuevo, '2026-03-01');
});
