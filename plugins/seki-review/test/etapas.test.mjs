import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertasDePista, construirEntregas, etapaDeEntrega, etapaDePista, pistasDe } from '../mcp/lib/etapas.mjs';

const AHORA = new Date('2026-11-10T12:00:00Z');
const cfg = { alertaDias: 5, cerrarTrasDias: 7 };
const cfgRepos = {
  back: { lineas: [{ portal: 'Back', prod: 'main', pruebas: 'develop' }] },
  front: { lineas: [{ portal: 'portal-a', prod: 'a-prod', pruebas: 'a-test' }, { portal: 'portal-b', prod: 'b-prod', pruebas: 'b-test' }] },
};
let n = 0;
const pr = (repo, portal, ambiente, estado = 'OPEN', mergeada = null, extra = {}) => ({
  id: `${repo}#${++n}`, repo, portal, ambiente, estadoPr: estado, mergeada, cerrada: estado === 'CLOSED' ? '2026-11-01T00:00:00Z' : null, creada: '2026-11-01T00:00:00Z', ...extra,
});
const mapa = (...prs) => new Map(prs.flat().map((x) => [x.id, x]));
const pista = (...prs) => ({ portal: 'portal-a', prs: prs.map((x) => x.id) });
const etapa = (prs, opciones = {}) => etapaDePista(pista(...prs), mapa(prs), { ahora: AHORA, cfg, ...opciones });
const reciente = '2026-11-09T00:00:00Z';

test('stage table: descartada when every PR is closed without merge', () => {
  assert.equal(etapa([pr('back', 'Back', 'pruebas', 'CLOSED'), pr('back', 'Back', 'prod', 'CLOSED')]), 'descartada');
});
test('stage table: en_produccion when every production PR is merged, cerrada after cerrarTrasDias or when marked', () => {
  const prods = [pr('back', 'Back', 'prod', 'MERGED', reciente), pr('back', 'Back', 'pruebas', 'MERGED', reciente)];
  assert.equal(etapa(prods), 'en_produccion');
  assert.equal(etapa(prods, { cerrada: true }), 'cerrada');
  assert.equal(etapa([pr('back', 'Back', 'prod', 'MERGED', '2026-10-20T00:00:00Z')]), 'cerrada');
});
test('stage table: qa_fallo, listo_produccion, esperando_qa and por_mergear_pruebas', () => {
  const fusionada = [pr('back', 'Back', 'pruebas', 'MERGED', '2026-11-05T00:00:00Z'), pr('back', 'Back', 'prod')];
  assert.equal(etapa(fusionada, { qa: { resultado: 'fallo', ts: '2026-11-06T00:00:00Z' } }), 'qa_fallo');
  assert.equal(etapa(fusionada, { qa: { resultado: 'ok', ts: '2026-11-06T00:00:00Z' } }), 'listo_produccion');
  assert.equal(etapa(fusionada), 'esperando_qa');
  assert.equal(etapa([pr('back', 'Back', 'pruebas'), pr('back', 'Back', 'prod')]), 'por_mergear_pruebas');
});
test('a delivery without testing PR is listo_produccion with the sin_pruebas alert', () => {
  const prs = [pr('back', 'Back', 'prod')];
  assert.equal(etapa(prs), 'listo_produccion');
  const a = alertasDePista(pista(...prs), mapa(prs), { etapa: 'listo_produccion', ahora: AHORA, cfg, cfgRepos });
  assert.ok(a.some((x) => x.tipo === 'sin_pruebas'));
});
test('a QA result older than the newest testing merge is ignored', () => {
  const prs = [pr('back', 'Back', 'pruebas', 'MERGED', '2026-11-07T00:00:00Z'), pr('back', 'Back', 'prod')];
  assert.equal(etapa(prs, { qa: { resultado: 'ok', ts: '2026-11-06T00:00:00Z' } }), 'esperando_qa');
});

test('orden alert: front merged in testing before back', () => {
  const back = pr('back', 'Back', 'pruebas');
  const front = pr('front', 'portal-a', 'pruebas', 'MERGED', '2026-11-08T00:00:00Z');
  const p = pista(back, front);
  const a = alertasDePista(p, mapa(back, front), { etapa: 'por_mergear_pruebas', ahora: AHORA, cfg, cfgRepos });
  const orden = a.find((x) => x.tipo === 'orden');
  assert.deepEqual(orden.prs.sort(), [back.id, front.id].sort());
  const backOk = pr('back', 'Back', 'pruebas', 'MERGED', '2026-11-07T00:00:00Z');
  const frontOk = pr('front', 'portal-a', 'pruebas', 'MERGED', '2026-11-08T00:00:00Z');
  assert.ok(!alertasDePista(pista(backOk, frontOk), mapa(backOk, frontOk), { etapa: 'esperando_qa', ahora: AHORA, cfg, cfgRepos }).some((x) => x.tipo === 'orden'));
});
test('gemela_faltante when a line has only a testing PR', () => {
  const t = pr('back', 'Back', 'pruebas');
  const a = alertasDePista(pista(t), mapa(t), { etapa: 'por_mergear_pruebas', ahora: AHORA, cfg, cfgRepos });
  assert.deepEqual(a.find((x) => x.tipo === 'gemela_faltante').prs, [t.id]);
});
test('estancada after alertaDias in esperando_qa, qa_fallo alert on failure', () => {
  const prs = [pr('back', 'Back', 'pruebas', 'MERGED', '2026-11-01T00:00:00Z'), pr('back', 'Back', 'prod')];
  const a = alertasDePista(pista(...prs), mapa(prs), { etapa: 'esperando_qa', ahora: AHORA, cfg, cfgRepos });
  assert.ok(a.some((x) => x.tipo === 'estancada'));
  assert.ok(alertasDePista(pista(...prs), mapa(prs), { etapa: 'qa_fallo', ahora: AHORA, cfg, cfgRepos }).some((x) => x.tipo === 'qa_fallo'));
});

test('two portal tracks plus a shared back: one in production, the other open, the delivery shows the other stage', () => {
  const back = pr('back', 'Back', 'prod', 'MERGED', reciente);
  const fa = pr('front', 'portal-a', 'prod', 'MERGED', reciente);
  const fb = pr('front', 'portal-b', 'pruebas');
  const fbProd = pr('front', 'portal-b', 'prod');
  const ent = { clave: 'x', prs: [back.id, fa.id, fb.id, fbProd.id] };
  const m = mapa(back, fa, fb, fbProd);
  const pistas = pistasDe(ent, m, cfgRepos);
  assert.deepEqual(pistas.map((x) => x.portal), ['portal-a', 'portal-b']);
  assert.ok(pistas.every((x) => x.prs.includes(back.id)));
  const [res] = construirEntregas({ entregas: [ent], prsPorId: m, cfgRepos, cfg, ahora: AHORA });
  assert.deepEqual(res.pistas.map((x) => x.etapa), ['en_produccion', 'por_mergear_pruebas']);
  assert.equal(res.etapa, 'por_mergear_pruebas');
  assert.equal(res.ultimoEvento, null);
});
test('without a multi-line repo there is one track "main"', () => {
  const b = pr('back', 'Back', 'prod');
  assert.deepEqual(pistasDe({ clave: 'x', prs: [b.id] }, mapa(b), cfgRepos), [{ portal: 'main', prs: [b.id] }]);
});
test('etapaDeEntrega ranks and ignores discarded tracks unless all are', () => {
  assert.equal(etapaDeEntrega([{ etapa: 'descartada' }, { etapa: 'en_produccion' }]), 'en_produccion');
  assert.equal(etapaDeEntrega([{ etapa: 'descartada' }, { etapa: 'descartada' }]), 'descartada');
  assert.equal(etapaDeEntrega([{ etapa: 'listo_produccion' }, { etapa: 'qa_fallo' }, { etapa: 'esperando_qa' }]), 'qa_fallo');
  assert.equal(etapaDeEntrega([{ etapa: 'cerrada' }, { etapa: 'en_produccion' }]), 'en_produccion');
});
test('ultimoEvento is the newest event touching a PR of the delivery', () => {
  const a = pr('back', 'Back', 'prod', 'MERGED', reciente);
  const eventos = [{ id: '1', ts: '2026-11-01T00:00:00Z', pr: a.id }, { id: '2', ts: '2026-11-03T00:00:00Z', pr: a.id }, { id: '3', ts: '2026-11-09T00:00:00Z', pr: 'otro#1' }];
  const [res] = construirEntregas({ entregas: [{ clave: 'x', prs: [a.id] }], prsPorId: mapa(a), cfgRepos, cfg, eventos, ahora: AHORA });
  assert.equal(res.ultimoEvento.id, '2');
});

test('production is decided per line: a shared merged back does not put a track with only a testing PR in production', () => {
  const back = pr('back', 'Back', 'prod', 'MERGED', reciente);
  for (const [estado, merg, esperada] of [['OPEN', null, 'por_mergear_pruebas'], ['MERGED', reciente, 'esperando_qa']]) {
    const fb = pr('front', 'portal-b', 'pruebas', estado, merg);
    const p = { portal: 'portal-b', prs: [back.id, fb.id] };
    const m = mapa(back, fb);
    assert.equal(etapaDePista(p, m, { ahora: AHORA, cfg }), esperada);
    assert.ok(alertasDePista(p, m, { etapa: esperada, ahora: AHORA, cfg, cfgRepos }).some((x) => x.tipo === 'gemela_faltante' && x.prs.includes(fb.id)));
  }
});
test('two-track delivery where portal-b has no prod PR is not in production', () => {
  const back = pr('back', 'Back', 'prod', 'MERGED', reciente);
  const fa = pr('front', 'portal-a', 'prod', 'MERGED', reciente);
  const fb = pr('front', 'portal-b', 'pruebas');
  const ent = { clave: 'x', prs: [back.id, fa.id, fb.id] };
  const [res] = construirEntregas({ entregas: [ent], prsPorId: mapa(back, fa, fb), cfgRepos, cfg, ahora: AHORA });
  assert.deepEqual(res.pistas.map((x) => x.etapa), ['en_produccion', 'por_mergear_pruebas']);
  assert.equal(res.etapa, 'por_mergear_pruebas');
});
test('deliveries and tracks without prod or testing PRs are dropped', () => {
  const o = pr('back', 'x', 'otra');
  const i = pr('back', 'y', 'inactiva');
  const real = pr('back', 'Back', 'prod');
  const res = construirEntregas({ entregas: [{ clave: 'a', prs: [o.id, i.id] }, { clave: 'b', prs: [real.id, o.id] }], prsPorId: mapa(o, i, real), cfgRepos, cfg, ahora: AHORA });
  assert.deepEqual(res.map((e) => e.clave), ['b']);
});
test('ahora is required and validated', () => {
  const b = pr('back', 'Back', 'prod');
  assert.throws(() => etapaDePista(pista(b), mapa(b), {}), TypeError);
  assert.throws(() => etapaDePista(pista(b), mapa(b), { ahora: new Date('x') }), TypeError);
  assert.throws(() => construirEntregas({ entregas: [], prsPorId: mapa(), cfgRepos }), TypeError);
});
test('estancada in listo_produccion measures from the later of the QA result and the last testing merge', () => {
  const prs = [pr('back', 'Back', 'pruebas', 'MERGED', '2026-11-01T00:00:00Z'), pr('back', 'Back', 'prod')];
  const args = (qa) => ({ etapa: 'listo_produccion', qa, ahora: AHORA, cfg, cfgRepos });
  assert.ok(alertasDePista(pista(...prs), mapa(prs), args({ resultado: 'ok', ts: '2026-11-02T00:00:00Z' })).some((x) => x.tipo === 'estancada'));
  assert.ok(!alertasDePista(pista(...prs), mapa(prs), args({ resultado: 'ok', ts: '2026-11-09T00:00:00Z' })).some((x) => x.tipo === 'estancada'));
});
