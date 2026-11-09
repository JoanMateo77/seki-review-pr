import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archivosDeDiff } from '../mcp/lib/verificar.mjs';
import { leerCostos } from '../mcp/lib/ia.mjs';
import { escribirJson, rutaPlantillas } from '../mcp/lib/cache.mjs';
import { lentesCubiertas, leerUltra, parcheUnido, revisarUltra } from '../mcp/lib/ultra.mjs';

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
    guias: () => guias, copiarComprobacion: async () => ({ dir: copia, baseSha: SHA }), comprobarFn: comprobarFn ?? (async () => ({ reglas: { hallazgos: [], resumen: {}, bloqueantes: 0 }, tipos: null, tests: null })),
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
  assert.deepEqual(registros[0].detalle.map((d) => d.paso), ['correccion', 'seguridad', 'lineamientos', 'verificar']);
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
  assert.deepEqual(args[5], {});
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

const regla = (dir) => `Read(/${realpathSync(dir)}/**/*.env)`;

test('citations that point outside the copy are dropped: sibling directory, absolute path, symlink out, directory', async () => {
  const lentes = {};
  const x = entorno({ lentes, verificar: veredictosDe({}) });
  mkdirSync(join(x.p.salida, 'copia-hermana'));
  writeFileSync(join(x.p.salida, 'copia-hermana/secreto.ts'), 'a\nb\n');
  writeFileSync(join(x.p.salida, 'fuera.ts'), 'a\nb\n');
  symlinkSync(join(x.p.salida, 'fuera.ts'), join(x.p.salida, 'copia/enlace.ts'));
  symlinkSync(join(x.p.salida, 'copia-hermana'), join(x.p.salida, 'copia/dir-enlace'));
  lentes.correccion = { hallazgos: [h('../copia-hermana/secreto.ts', 1), h(join(x.p.salida, 'copia-hermana/secreto.ts'), 1), h('enlace.ts', 1), h('dir-enlace/secreto.ts', 1), h('src', 1), h('src/a.ts', 1)] };
  const r = await revisarUltra(x.p, pr, x.deps);
  assert.deepEqual(r.resultado.hallazgos.map((f) => f.id), ['correccion-6']);
  assert.equal(r.resultado.descartadas.length, 5);
});

test('every directory given to the AI has its secret rule, and the guidelines directory is opened only for that lens', async () => {
  const registro = [];
  const guiasDir = mkdtempSync(join(tmpdir(), 'seki-guias-'));
  const otro = mkdtempSync(join(tmpdir(), 'seki-otro-'));
  const e = entorno({ registro, lentes: { correccion: { hallazgos: [h('src/a.ts', 1)] } }, verificar: veredictosDe({}), dirs: [{ repo: 'web', portal: 'w', rama: 'main', sha: 'c'.repeat(40), dir: otro }] });
  e.p.lineamientos = guiasDir;
  await revisarUltra(e.p, pr, e.deps);
  assert.equal(registro.length, 4);
  for (const c of registro) {
    for (const d of [join(e.p.salida, 'copia'), otro, guiasDir]) assert.ok(c.args.includes(regla(d)), `rule for ${d}`);
    const conGuias = c.args.includes(guiasDir);
    assert.equal(conGuias, c.prompt.startsWith('Lens: lineamientos'));
    assert.ok(c.args.includes(otro));
  }
});

test('findings in another repository directory are accepted with the same containment rule and record the repo', async () => {
  const otro = mkdtempSync(join(tmpdir(), 'seki-otro-'));
  writeFileSync(join(otro, 'x.ts'), 'a\nb\n');
  const e = entorno({ lentes: { seguridad: { hallazgos: [h('x.ts', 2, { repo: 'web' }), h('x.ts', 3, { repo: 'web' }), h('x.ts', 1, { repo: 'nadie' }), h('../x.ts', 1, { repo: 'web' })] } }, verificar: veredictosDe({}), dirs: [{ repo: 'web', portal: 'w', rama: 'main', sha: 'c'.repeat(40), dir: otro }] });
  const r = await revisarUltra(e.p, pr, e.deps);
  assert.deepEqual(r.resultado.hallazgos.map((f) => [f.id, f.repo]), [['seguridad-1', 'web']]);
  assert.equal(r.resultado.descartadas.length, 3);
});

test('a file over the size cap is dropped as too large to verify', async () => {
  const e = entorno({ lentes: { correccion: { hallazgos: [h('src/grande.ts', 1)] } }, verificar: veredictosDe({}) });
  writeFileSync(join(e.p.salida, 'copia/src/grande.ts'), 'x\n'.repeat(1.2 * 1024 * 1024));
  const r = await revisarUltra(e.p, pr, e.deps);
  assert.equal(r.resultado.descartadas[0].motivo, 'The cited file is too large to verify');
});

test('each lens gets its own system prompt and the guidelines text only goes to the guidelines lens', async () => {
  const registro = [];
  const e = entorno({ registro, guias: 'GUIDELINE-TEXT', verificar: veredictosDe({}) });
  await revisarUltra(e.p, pr, e.deps);
  const sistema = (c) => c.args[c.args.indexOf('--system-prompt') + 1];
  const por = Object.fromEntries(registro.map((c) => [/^Lens: (\w+)/.exec(c.prompt)?.[1], c]));
  assert.match(sistema(por.correccion), /correctness/);
  assert.match(sistema(por.seguridad), /OWASP/);
  assert.match(sistema(por.lineamientos), /guidelines/);
  assert.equal(new Set(Object.values(por).map(sistema)).size, 3);
  assert.match(por.lineamientos.prompt, /GUIDELINE-TEXT/);
  assert.doesNotMatch(por.correccion.prompt, /GUIDELINE-TEXT/);
  assert.doesNotMatch(por.seguridad.prompt, /GUIDELINE-TEXT/);
});

test('ejecutar throwing gives a generic reason and still records the job with cost 0', async () => {
  const e = entorno();
  e.deps.ejecutar = async () => { throw new Error('secret stderr /home/x'); };
  const r = await revisarUltra(e.p, pr, e.deps);
  assert.deepEqual([r.ok, r.costo, r.motivo], [false, 0, 'The job failed']);
  const [rec] = leerCostos(e.p).filter((x) => x.tipo === 'revisar_ultra');
  assert.deepEqual([rec.ok, rec.costo, rec.motivo], [false, 0, 'The job failed']);
});

test('the cost record is written even if something after the lenses throws', async () => {
  const e = entorno({ lentes: { correccion: { hallazgos: [h('src/a.ts', 1)] } } });
  e.deps.copiarComprobacion = async () => { throw new Error('x'); };
  e.deps.diff = async () => [{ filename: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }];
  const original = e.deps.ejecutar;
  e.deps.ejecutar = async (a, o) => { const r = await original(a, o); if (!/^Lens:/.test(a[a.indexOf('-p') + 1])) throw new Error('verifier crashed'); return r; };
  const r = await revisarUltra(e.p, pr, e.deps);
  assert.equal(r.ok, false);
  const [rec] = leerCostos(e.p).filter((x) => x.tipo === 'revisar_ultra');
  assert.equal(rec.costo, 1.5);
});

test('without a head commit the job fails before spending', async () => {
  const e = entorno();
  await assert.rejects(revisarUltra(e.p, { ...pr, headSha: undefined }, e.deps), /no head commit/);
  assert.equal(leerCostos(e.p).length, 0);
});

test('an invalid concurrency falls back to 1', async () => {
  for (const v of [0, -1, NaN, 'x', 1.5]) {
    const e = entorno({ verificar: veredictosDe({}) });
    await revisarUltra(e.p, pr, { ...e.deps, paralelo: v });
    assert.equal(e.maximo(), 1);
  }
});

test('unavailable other repositories are told to the AI and flagged in the result', async () => {
  const registro = [];
  const e = entorno({ registro, verificar: veredictosDe({}) });
  e.deps.otras = async () => { throw new Error('no checkout'); };
  const r = await revisarUltra(e.p, pr, e.deps);
  assert.equal(r.resultado.otrosRepos, 'no_disponibles');
  assert.ok(registro.every((c) => /Other repositories: unavailable/.test(c.prompt)));
});

test('verifier output: duplicate id keeps the first verdict, unknown ids are ignored, a missing verdict drops the finding', async () => {
  const e = entorno({ lentes: { correccion: { hallazgos: [h('src/a.ts', 1), h('src/a.ts', 2), h('src/a.ts', 3)] } }, verificar: () => ({ ok: true, costo: 0.1, modelo: 'm', salida: { veredictos: [
    { id: 'correccion-1', veredicto: 'CONFIRMED', razon: 'ok' }, { id: 'correccion-1', veredicto: 'REJECTED', razon: 'dup' },
    { id: 'zzz-9', veredicto: 'CONFIRMED', razon: 'unknown' }, { id: 'correccion-2', veredicto: 'MAYBE', razon: 'bad' }] } }) });
  const r = await revisarUltra(e.p, pr, e.deps);
  assert.deepEqual(r.resultado.hallazgos.map((f) => f.id), ['correccion-1']);
  assert.deepEqual(r.resultado.descartadas.map((f) => [f.id, f.motivo]), [['correccion-2', 'The verification gave no verdict'], ['correccion-3', 'The verification gave no verdict']]);
});

test('malformed verifier output fails the job with the format reason; malformed lens output fails that lens', async () => {
  const e = entorno({ lentes: { correccion: { hallazgos: [h('src/a.ts', 1)] } }, verificar: () => ({ ok: true, costo: 0.1, modelo: 'm', salida: { veredictos: 'x' } }) });
  const r = await revisarUltra(e.p, pr, e.deps);
  assert.deepEqual([r.ok, r.motivo], [false, 'The response did not arrive in the expected format']);
  const f = entorno({ lentes: { correccion: { hallazgos: 'x' } }, verificar: veredictosDe({}) });
  const r2 = await revisarUltra(f.p, pr, f.deps);
  assert.equal(r2.resultado.lentes[0].motivo, 'The response did not arrive in the expected format');
});

test('costos.jsonl carries no finding text, reasons, prompts or stderr, and detalle only has paso, modelo, costo and ok', async () => {
  const comunes = { lentes: { correccion: { hallazgos: [h('src/a.ts', 1, { titulo: 'TITULO-SECRETO', detalle: 'DETALLE-SECRETO' })] }, seguridad: new Error('x') } };
  const bien = entorno({ ...comunes, verificar: () => ({ ok: true, costo: 0.1, modelo: 'm', salida: { veredictos: [{ id: 'correccion-1', veredicto: 'CONFIRMED', razon: 'RAZON-SECRETA' }] } }) });
  await revisarUltra(bien.p, pr, bien.deps);
  const mal = entorno({ ...comunes, verificar: () => ({ ok: false, costo: 0.1, modelo: 'm', salida: null, motivo: 'STDERR-SECRETO', motivoSeguro: 'The job reached its turn limit' }) });
  await revisarUltra(mal.p, pr, mal.deps);
  for (const e of [bien, mal]) {
    const crudo = readFileSync(join(e.p.salida, 'datos/costos.jsonl'), 'utf8');
    assert.doesNotMatch(crudo, /SECRET|Lens:|Verify these/);
    for (const rec of leerCostos(e.p)) for (const d of rec.detalle) assert.deepEqual(Object.keys(d).sort(), ['costo', 'modelo', 'ok', 'paso']);
  }
});

test('a long file list is capped and the diff is cut at file boundaries in priority order', async () => {
  const registro = [];
  const e = entorno({ registro });
  const parche = (n) => `@@ -1 +1 @@\n-${'a'.repeat(n)}\n+b`;
  const muchos = Array.from({ length: 350 }, (_, i) => ({ filename: `src/f${i}.ts`, status: 'modified', additions: 1, deletions: 1, patch: parche(300) }));
  e.deps.diff = async () => [{ filename: 'src/x.test.ts', status: 'modified', patch: parche(300) }, ...muchos];
  await revisarUltra(e.p, pr, e.deps);
  const prompt = registro[0].prompt;
  assert.match(prompt, /- and 51 more/);
  assert.match(prompt, /Not included in this message/);
  assert.match(prompt, /\+\+\+ b\/src\/f0\.ts/);
  assert.match(prompt, /Not included in this message[^]*src\/x\.test\.ts/);
  assert.ok(prompt.length < 90000);
  assert.doesNotMatch(prompt, /\n\+\+\+ b\/src\/f3\d\d\.ts\n@@/);
});

test('parcheUnido round-trips a rename through archivosDeDiff', () => {
  const t = parcheUnido([{ filename: 'nuevo.ts', previous_filename: 'viejo.ts', status: 'renamed', patch: '@@ -1 +1 @@\n-a\n+b' }]);
  assert.deepEqual(archivosDeDiff(t).map((a) => [a.filename, a.status]), [['nuevo.ts', 'modified']]);
});

// A stored template result of the PR: `plantillas` is the list of [id, ok] entries.
const guardarPlantillas = (p, plantillas, headSha = SHA) => escribirJson(rutaPlantillas(p.salida, 'api', 7), { headSha, plantillas: plantillas.map(([id, ok]) => ({ id, ok })) });
const lentesLlamadas = (registro) => registro.filter((x) => x.prompt.startsWith('Lens:')).map((x) => /^Lens: (\w+)/.exec(x.prompt)[1]).sort();

test('a template result of the same commit with owasp-web ok skips the security lens and runs the others', async () => {
  const registro = [];
  const { p, deps } = entorno({ registro, lentes: { correccion: { hallazgos: [h('src/a.ts', 1)] } }, verificar: veredictosDe({}) });
  guardarPlantillas(p, [['ligera', true], ['owasp-web', true]]);
  assert.deepEqual(lentesCubiertas(p, 'api', 7, SHA), ['seguridad']);
  const r = await revisarUltra(p, pr, deps);
  assert.deepEqual(lentesLlamadas(registro), ['correccion', 'lineamientos']);
  const l = r.resultado.lentes.find((x) => x.nombre === 'seguridad');
  assert.deepEqual([l.omitida, l.ok, l.costo, l.motivo, l.hallazgos], [true, false, 0, 'Covered by the template review of this commit', 0]);
  assert.equal(r.ok, true);
  assert.equal(r.costo, 0.5 * 2 + 0.25);
  const [rec] = leerCostos(p).filter((x) => x.tipo === 'revisar_ultra');
  assert.deepEqual(rec.detalle.map((x) => x.paso), ['correccion', 'lineamientos', 'verificar']);
});

test('repetir does not bring a covered lens back', async () => {
  const registro = [];
  const { p, deps } = entorno({ registro });
  guardarPlantillas(p, [['pci-dss', true]]);
  await revisarUltra(p, pr, deps);
  await revisarUltra(p, pr, { ...deps, repetir: true });
  assert.equal(registro.filter((x) => x.prompt.startsWith('Lens: seguridad')).length, 0);
});

test('a template result of another commit, or whose template failed, does not cover the lens', async () => {
  for (const [plantillas, sha] of [[[['owasp-web', true]], 'b'.repeat(40)], [[['owasp-web', false]], SHA], [[['ligera', true]], SHA]]) {
    const registro = [];
    const { p, deps } = entorno({ registro });
    guardarPlantillas(p, plantillas, sha);
    assert.deepEqual(lentesCubiertas(p, 'api', 7, SHA), []);
    await revisarUltra(p, pr, deps);
    assert.deepEqual(lentesLlamadas(registro), ['correccion', 'lineamientos', 'seguridad'], JSON.stringify(plantillas));
  }
});

test('a result of the same commit with moved branches still covers the lens', () => {
  const { p } = entorno();
  escribirJson(rutaPlantillas(p.salida, 'api', 7), { headSha: SHA, ramasMovidas: [{ repo: 'web', rama: 'main' }], plantillas: [{ id: 'owasp-web', ok: true }] });
  assert.deepEqual(lentesCubiertas(p, 'api', 7, SHA), ['seguridad']);
});

test('all other lenses failing with the security lens covered ends the job on that failure', async () => {
  const { p, deps } = entorno({ lentes: { correccion: new Error('x'), lineamientos: new Error('x') } });
  guardarPlantillas(p, [['owasp-web', true]]);
  const r = await revisarUltra(p, pr, deps);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'The job exceeded the maximum time');
});
