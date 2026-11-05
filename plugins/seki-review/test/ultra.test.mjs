import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leerCostos } from '../mcp/lib/ia.mjs';
import { leerUltra, parcheUnido, revisarUltra } from '../mcp/lib/ultra.mjs';

const SHA = 'a'.repeat(40);
const pr = { id: 'api#7', repo: 'api', numero: 7, titulo: 'fix: algo', headSha: SHA };
const h = (archivo, linea, extra = {}) => ({ archivo, linea, severidad: 'alta', titulo: `Problem in ${archivo}`, detalle: 'Evidence.', ...extra });

function entorno({ lentes = {}, verificar, guias = 'RULES', comprobarFn, registro = [], dirs } = {}) {
  const salida = mkdtempSync(join(tmpdir(), 'seki-ultra-'));
  const copia = join(salida, 'copia');
  mkdirSync(join(copia, 'src'), { recursive: true });
  writeFileSync(join(copia, 'src/a.ts'), 'l1\nl2\nl3\nl4\nl5\n');
  const p = { salida, repos: { api: {} } };
  let activos = 0;
  let maximo = 0;
  const ejecutar = async (args, { cwd }) => {
    const prompt = args[args.indexOf('-p') + 1];
    registro.push({ args, cwd, prompt });
    activos++; maximo = Math.max(maximo, activos);
    await new Promise((r) => setTimeout(r, 5));
    activos--;
    const lente = /^Lens: (\w+)/.exec(prompt)?.[1];
    if (lente) {
      const x = lentes[lente] ?? { hallazgos: [] };
      return x instanceof Error ? { ok: false, costo: 0.5, modelo: 'claude-sonnet-5-5', salida: null, motivoSeguro: 'The job exceeded the maximum time' }
        : { ok: true, costo: 0.5, modelo: 'claude-sonnet-5-5', salida: x };
    }
    return verificar ? verificar(prompt) : { ok: true, costo: 0.25, modelo: 'claude-sonnet-5-5', salida: { veredictos: [] } };
  };
  const deps = {
    ejecutar, copiar: async () => copia, otras: async () => ({ ambiente: 'pruebas', lista: dirs ?? [] }),
    diff: async () => [{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n l1\n+l2' }],
    guias: () => guias, comprobarFn: comprobarFn ?? (async () => ({ reglas: { hallazgos: [], resumen: {}, bloqueantes: 0 }, tipos: null, tests: null })),
    paralelo: 2,
  };
  return { p, deps, maximo: () => maximo };
}
const veredictosDe = (mapa) => (prompt) => {
  const ids = [...prompt.matchAll(/"id": "([\w-]+)"/g)].map((m) => m[1]);
  return { ok: true, costo: 0.25, modelo: 'claude-sonnet-5-5', salida: { veredictos: ids.map((id) => ({ id, veredicto: mapa[id] ?? 'CONFIRMED', razon: 'Seen in src/a.ts:1' })) } };
};

test('findings citing a missing file or a line beyond the file never reach the verifier or the result', async () => {
  const registro = [];
  const { p, deps } = entorno({ registro, lentes: { correccion: { hallazgos: [h('src/a.ts', 2), h('src/nope.ts', 1), h('src/a.ts', 99), h('../fuera.ts', 1)] } }, verificar: veredictosDe({}) });
  const r = await revisarUltra(p, pr, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(r.resultado.hallazgos.map((x) => x.id), ['correccion-1']);
  assert.deepEqual(r.resultado.descartadas.map((x) => x.id).sort(), ['correccion-2', 'correccion-3', 'correccion-4']);
  assert.ok(r.resultado.descartadas.every((d) => d.motivo));
  const verif = registro.find((x) => !x.prompt.startsWith('Lens:'));
  assert.doesNotMatch(verif.prompt, /nope\.ts/);
});

test('a finding the verifier rejects is kept out of the result and PLAUSIBLE is kept', async () => {
  const { p, deps } = entorno({ lentes: { seguridad: { hallazgos: [h('src/a.ts', 1), h('src/a.ts', 3)] } }, verificar: veredictosDe({ 'seguridad-1': 'REJECTED', 'seguridad-2': 'PLAUSIBLE' }) });
  const r = await revisarUltra(p, pr, deps);
  assert.deepEqual(r.resultado.hallazgos.map((x) => [x.id, x.veredicto]), [['seguridad-2', 'PLAUSIBLE']]);
  assert.equal(r.resultado.descartadas[0].id, 'seguridad-1');
  assert.match(r.resultado.descartadas[0].motivo, /Rejected by the verification/);
  assert.deepEqual(leerUltra(p, 'api', 7, SHA).hallazgos.map((x) => x.id), ['seguridad-2']);
});

test('a lens that fails does not stop the others; it is listed and its cost is summed in one record', async () => {
  const { p, deps } = entorno({ lentes: { correccion: new Error('x'), seguridad: { hallazgos: [h('src/a.ts', 1)] } }, verificar: veredictosDe({}) });
  const r = await revisarUltra(p, pr, deps);
  assert.equal(r.ok, true);
  const falla = r.resultado.lentes.find((l) => l.nombre === 'correccion');
  assert.deepEqual([falla.ok, falla.motivo], [false, 'The job exceeded the maximum time']);
  assert.equal(r.resultado.hallazgos.length, 1);
  const registros = leerCostos(p).filter((x) => x.tipo === 'revisar_ultra');
  assert.equal(registros.length, 1);
  assert.equal(registros[0].modo, 'ultra');
  assert.equal(registros[0].costo, 0.5 * 3 + 0.25);
  assert.deepEqual(registros[0].detalle.map((d) => d.paso).sort(), ['correccion', 'lineamientos', 'seguridad', 'verificar']);
  assert.equal(registros[0].ok, true);
});

test('the same commit is answered from the stored result without spending; repetir spends; a newer commit marks it outdated', async () => {
  const registro = [];
  const { p, deps } = entorno({ registro, lentes: { correccion: { hallazgos: [h('src/a.ts', 1)] } }, verificar: veredictosDe({}) });
  await revisarUltra(p, pr, deps);
  const antes = registro.length;
  const otra = await revisarUltra(p, pr, deps);
  assert.deepEqual([otra.desdeCache, otra.costo, registro.length], [true, 0, antes]);
  await revisarUltra(p, pr, { ...deps, repetir: true });
  assert.ok(registro.length > antes);
  const nueva = 'b'.repeat(40);
  assert.equal(leerUltra(p, 'api', 7, nueva).desactualizada, true);
  assert.equal(leerUltra(p, 'api', 7, SHA).desactualizada, undefined);
  const r = await revisarUltra(p, { ...pr, headSha: nueva }, deps);
  assert.equal(r.desdeCache, undefined);
  assert.equal(leerUltra(p, 'api', 7, nueva).headSha, nueva);
});

test('without guidelines the lens is skipped and reported, not failed, and spends nothing', async () => {
  const registro = [];
  const { p, deps } = entorno({ registro, guias: null, lentes: { correccion: { hallazgos: [h('src/a.ts', 1)] } }, verificar: veredictosDe({}) });
  const r = await revisarUltra(p, pr, deps);
  const l = r.resultado.lentes.find((x) => x.nombre === 'lineamientos');
  assert.deepEqual([l.omitida, l.ok, l.costo], [true, false, 0]);
  assert.equal(registro.filter((x) => x.prompt.startsWith('Lens: lineamientos')).length, 0);
  assert.equal(r.ok, true);
  assert.equal(r.costo, 0.5 * 2 + 0.25);
});

test('a failed verification keeps no findings, stores nothing and reports a safe reason', async () => {
  const { p, deps } = entorno({ lentes: { correccion: { hallazgos: [h('src/a.ts', 1)] } }, verificar: () => ({ ok: false, costo: 0.3, modelo: 'm', salida: null, motivo: 'secret stderr', motivoSeguro: 'The job reached its turn limit' }) });
  const r = await revisarUltra(p, pr, deps);
  assert.deepEqual([r.ok, r.resultado, r.motivo], [false, null, 'The job reached its turn limit']);
  assert.equal(leerUltra(p, 'api', 7), null);
  const [rec] = leerCostos(p).filter((x) => x.tipo === 'revisar_ultra');
  assert.deepEqual([rec.ok, rec.motivo, rec.costo], [false, 'The job reached its turn limit', 0.5 * 3 + 0.3]);
});

test('all lenses failing ends the job without a verification call', async () => {
  const registro = [];
  const { p, deps } = entorno({ registro, lentes: { correccion: new Error('x'), seguridad: new Error('x'), lineamientos: new Error('x') } });
  const r = await revisarUltra(p, pr, deps);
  assert.equal(r.ok, false);
  assert.equal(registro.length, 3);
  assert.equal(leerCostos(p).at(-1).ok, false);
});

test('every call is read-only, runs in the copy, blocks secrets, and ids, text and count are capped', async () => {
  const registro = [];
  const muchos = Array.from({ length: 40 }, () => h('src/a.ts', 1, { titulo: 't'.repeat(500), detalle: 'd'.repeat(5000) }));
  const { p, deps } = entorno({ registro, lentes: { correccion: { hallazgos: muchos } }, verificar: veredictosDe({}), dirs: [{ repo: 'web', portal: 'w', rama: 'main', sha: 'c'.repeat(40), dir: '/otro/web' }] });
  const r = await revisarUltra(p, pr, deps);
  for (const c of registro) {
    assert.equal(c.args[c.args.indexOf('--tools') + 1], 'Read,Grep,Glob');
    assert.ok(c.args.includes('/otro/web'));
    assert.ok(c.args.some((x) => x.startsWith('Read(/') && x.endsWith('/**/*.env)')));
    assert.ok(c.args.includes('--json-schema'));
    assert.equal(c.cwd, join(p.salida, 'copia'));
  }
  assert.equal(r.resultado.hallazgos.length, 30);
  assert.equal(r.resultado.hallazgos[29].id, 'correccion-30');
  assert.equal(r.resultado.hallazgos[0].titulo.length, 200);
  assert.equal(r.resultado.hallazgos[0].detalle.length, 2000);
});

test('lenses respect the concurrency limit', async () => {
  const uno = entorno({ verificar: veredictosDe({}) });
  await revisarUltra(uno.p, pr, { ...uno.deps, paralelo: 1 });
  assert.equal(uno.maximo(), 1);
  const dos = entorno({ verificar: veredictosDe({}) });
  await revisarUltra(dos.p, pr, { ...dos.deps, paralelo: 2 });
  assert.equal(dos.maximo(), 2);
});

test('project checks run on the copy with the PR patch and head commit; a crash is reported, not fatal', async () => {
  let args;
  const e = entorno({ comprobarFn: async (...a) => { args = a; return { reglas: { hallazgos: [], resumen: {}, bloqueantes: 0 }, tipos: null, tests: null }; } });
  const r = await revisarUltra(e.p, pr, e.deps);
  assert.equal(args[1], 'api');
  assert.equal(args[2], join(e.p.salida, 'copia'));
  assert.match(args[3], /^diff --git a\/src\/a\.ts b\/src\/a\.ts\n--- a\/src\/a\.ts\n\+\+\+ b\/src\/a\.ts\n@@/);
  assert.equal(args[4], SHA);
  assert.equal(r.resultado.comprobacion.reglas.bloqueantes, 0);
  const f = entorno({ comprobarFn: async () => { throw new Error('boom'); } });
  const r2 = await revisarUltra(f.p, pr, f.deps);
  assert.equal(r2.ok, true);
  assert.equal(r2.resultado.comprobacion.error, 'The project checks could not run');
});

test('parcheUnido marks added and removed files with /dev/null', () => {
  const t = parcheUnido([{ filename: 'n.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+x' }, { filename: 'o.ts', status: 'removed', patch: '@@ -1 +0,0 @@\n-x' }, { filename: 'i.png', status: 'added' }]);
  assert.match(t, /--- \/dev\/null\n\+\+\+ b\/n\.ts/);
  assert.match(t, /--- a\/o\.ts\n\+\+\+ \/dev\/null/);
  assert.doesNotMatch(t, /i\.png/);
});
