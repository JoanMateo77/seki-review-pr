import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { comentariosDePlantillas } from '../mcp/lib/comentarios-plantilla.mjs';
import { leerCostos, registrarCosto } from '../mcp/lib/ia.mjs';
import { estimarCostoPlantillas, topeRevisarPlantillas } from '../mcp/lib/perfiles.mjs';
import { datosPlantillas, leerPlantillasPr, revisarPlantillas } from '../mcp/lib/revision-plantillas.mjs';

const SHA = 'a'.repeat(40);
const pr = { id: 'api#7', repo: 'api', numero: 7, titulo: 'feat: algo', headSha: SHA };
const it = (id, extra = {}) => ({ id, pregunta: `Question ${id}?`, evidencia: `Evidence ${id}`, reglas: [], siFalla: { etiqueta: 'issue', bloqueante: true }, ...extra });
const tpl = (id, items, extra = {}) => ({ id, version: 1, titulo: `Template ${id}`, idioma: 'en', siempre: true, aplicaA: ['**'], excluir: [], items, ...extra });
const ARCHIVO = ['import { suma } from "./suma";', 'const valor = suma(1,   2);', '  return valor;', 'l4', 'l5', 'l6', 'l7', ''].join('\n');
const DIFF = [{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n l1\n+const valor = suma(1,   2);' }];
const USO = { entrada: 10, cacheCreada: 5, cacheLeida: 2, salida: 3 };
const ok = (salida, costo = 0.5) => ({ ok: true, costo, modelo: 'claude-sonnet-5-5', uso: USO, salida });
const cita = (id, estado, linea, texto, extra = {}) => ({ id, estado, archivo: 'src/a.ts', linea, cita: texto, titulo: `Title ${id}`, detalle: `Detail ${id}`, ...extra });

function entorno({ plantillas, respuestas = {}, verificar, registro = [], diff = DIFF, otras, grep, commits } = {}) {
  const salida = mkdtempSync(join(tmpdir(), 'seki-plantillas-'));
  const copia = join(salida, 'copia');
  mkdirSync(join(copia, 'src'), { recursive: true });
  writeFileSync(join(copia, 'src/a.ts'), ARCHIVO);
  const p = { salida, owner: 'org', repos: { api: {} } };
  let activos = 0;
  let maximo = 0;
  const ejecutar = async (args, { cwd }) => {
    const prompt = args[args.indexOf('-p') + 1];
    const llamada = { args, cwd, prompt, anteriorTerminada: registro.length ? registro[registro.length - 1].terminada : null, terminada: false };
    registro.push(llamada);
    activos++; maximo = Math.max(maximo, activos);
    await new Promise((r) => setTimeout(r, 5));
    activos--;
    llamada.terminada = true;
    const id = /^Template: ([\w-]+)/m.exec(prompt)?.[1];
    if (id) {
      const x = respuestas[id] ?? { items: [] };
      return x instanceof Error ? { ok: false, costo: 0.5, modelo: 'claude-sonnet-5-5', salida: null, motivoSeguro: 'The job exceeded the maximum time' } : ok(x);
    }
    return verificar ? verificar(prompt) : ok({ veredictos: [] }, 0.25);
  };
  const deps = {
    ejecutar, copiar: async () => copia, otras: otras ?? (async () => ({ ambiente: 'pruebas', lista: [] })),
    diff: async () => diff, commits: commits ?? (async () => []), grep: grep ?? (async () => []),
    cargar: () => ({ plantillas, invalidas: [] }), paralelo: 2,
  };
  return { p, deps, copia, maximo: () => maximo };
}
const veredictosDe = (mapa) => (prompt) => {
  const ids = [...prompt.matchAll(/"id": "([\w/-]+)"/g)].map((m) => m[1]);
  return ok({ veredictos: ids.map((id) => ({ id, veredicto: mapa[id] ?? 'CONFIRMED', razon: `Reason ${id}` })) }, 0.25);
};
const item = (r, plantilla, id) => r.resultado.plantillas.find((t) => t.id === plantilla).items.find((i) => i.id === id);

test('only the AI items of each active template are sent and deterministic items never are', async () => {
  const registro = [];
  const plantillas = [
    tpl('ligera', [it('L1'), it('L7', { reglas: ['as-any', 'tipo-any'] }), it('L2')]),
    tpl('solo-reglas', [it('R1', { reglas: ['tipo-any'] })]),
    tpl('otra', [it('O1')], { siempre: false, aplicaA: ['docs/**'] }),
  ];
  const { p, deps } = entorno({ plantillas, registro });
  const r = await revisarPlantillas(p, pr, deps);
  assert.equal(r.ok, true);
  assert.equal(registro.length, 1);
  const { prompt } = registro[0];
  assert.match(prompt, /^PR #7 of api: feat: algo\n/);
  assert.match(prompt, /\n\nTemplate: ligera v1\. Language: en\.\n\nItems:\n/);
  const enviados = JSON.parse(/Items:\n(\[[^]*?\n\])/.exec(prompt)[1]);
  assert.deepEqual(enviados.map((x) => x.id), ['L1', 'L2']);
  assert.ok(enviados.every((x) => !('reglas' in x)));
  assert.deepEqual(Object.keys(enviados[0]).sort(), ['evidencia', 'id', 'pregunta']);
  assert.match(prompt, /Changed files:\n- src\/a\.ts/);
  assert.match(prompt, /Diff:\ndiff --git a\/src\/a\.ts/);
  assert.deepEqual(r.resultado.plantillas.map((t) => t.id), ['ligera', 'solo-reglas']);
  assert.deepEqual(r.resultado.seleccion.omitidas.map((t) => t.id), ['otra']);
  const c = registro[0];
  assert.equal(c.args[c.args.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.match(c.args[c.args.indexOf('--system-prompt') + 1], /no_verificable/);
});

test('a quote that is not in the cited lines turns the item into no_verificable', async () => {
  const plantillas = [tpl('ligera', [it('L1'), it('L2'), it('L3'), it('L4')])];
  const { p, deps } = entorno({ plantillas, verificar: veredictosDe({}), respuestas: { ligera: { items: [
    cita('L1', 'falla', 2, 'const valor = resta(1, 2);'),
    cita('L2', 'cumple', 7, 'const valor = suma(1, 2);'),
    cita('L3', 'falla', 2, 'x', { archivo: 'src/nope.ts' }),
    cita('L4', 'cumple', 2, ''),
  ] } } });
  const r = await revisarPlantillas(p, pr, deps);
  for (const id of ['L1', 'L2', 'L3', 'L4']) {
    const i = item(r, 'ligera', id);
    assert.equal(i.estado, 'no_verificable', id);
    assert.equal(i.motivo, 'The quote does not match the cited code', id);
    assert.equal(i.origen, 'ia');
  }
});

test('a quote with different whitespace still matches within two lines', async () => {
  const registro = [];
  const plantillas = [tpl('ligera', [it('L1'), it('L2')])];
  const { p, deps } = entorno({ plantillas, registro, verificar: veredictosDe({}), respuestas: { ligera: { items: [
    cita('L1', 'falla', 2, 'suma(1, 2);\n return    valor;'),
    cita('L2', 'cumple', 4, 'const valor = suma(1, 2);'),
  ] } } });
  const r = await revisarPlantillas(p, pr, deps);
  const l1 = item(r, 'ligera', 'L1');
  assert.deepEqual([l1.estado, l1.archivo, l1.linea, l1.veredicto], ['falla', 'src/a.ts', 2, 'CONFIRMED']);
  assert.equal(l1.cita, 'suma(1, 2); return valor;');
  assert.equal(item(r, 'ligera', 'L2').estado, 'cumple');
  assert.equal(item(r, 'ligera', 'L2').veredicto, undefined);
});

test('items the AI omitted are not verifiable and unknown ids are dropped', async () => {
  const plantillas = [tpl('ligera', [it('L1'), it('L2'), it('L3'), it('L5')])];
  const { p, deps } = entorno({ plantillas, respuestas: { ligera: { items: [
    { id: 'L1', estado: 'no_aplica', titulo: 'Not touched', detalle: 'No route changes.' },
    { id: 'ZZ-inventado', estado: 'falla', archivo: 'src/a.ts', linea: 1, cita: 'import { suma }', titulo: 't', detalle: 'd' },
    { id: 'L3', estado: 'quizas', titulo: 't', detalle: 'd' },
    { id: 'L5', estado: 'no_verificable', titulo: 'Unknown', detalle: 'd', pedido: 'Which client calls this route?' },
    { id: 'L5', estado: 'cumple', archivo: 'src/a.ts', linea: 1, cita: 'import { suma }', titulo: 't', detalle: 'd' },
  ] } } });
  const r = await revisarPlantillas(p, pr, deps);
  const t = r.resultado.plantillas[0];
  assert.deepEqual(t.items.map((i) => [i.id, i.estado]), [['L1', 'no_aplica'], ['L2', 'no_verificable'], ['L3', 'no_verificable'], ['L5', 'no_verificable']]);
  assert.equal(item(r, 'ligera', 'L2').motivo, 'The review did not cover this item');
  assert.equal(item(r, 'ligera', 'L3').motivo, 'The review did not cover this item');
  assert.equal(item(r, 'ligera', 'L5').pedido, 'Which client calls this route?');
  assert.deepEqual(item(r, 'ligera', 'L1').siFalla, { etiqueta: 'issue', bloqueante: true });
  assert.equal(item(r, 'ligera', 'L1').pregunta, 'Question L1?');
  // Ruling Q: only items with a question for the author reach the pasted Markdown.
  assert.equal(r.resultado.markdown, '**Not verifiable from the diff**\n- Question L5? — Which client calls this route?');
});

test('deterministic items fail from fixed rule findings and pass with no finding', async () => {
  const L7 = it('L7', { reglas: ['as-any', 'tipo-any'], siFalla: { etiqueta: 'suggestion', bloqueante: false } });
  const L9 = it('L9', { reglas: ['atribucion-ia'] });
  const plantillas = [tpl('ligera', [L7, L9], { aplicaA: ['docs/**'] })];
  const conAny = [{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n l1\n+const x: any = 1;' }];
  const registro = [];
  const e = entorno({ plantillas, registro, diff: conAny, commits: async () => [{ oid: 'b'.repeat(40), messageHeadline: 'feat: x', messageBody: 'Co-Authored-By: Claude <x>' }] });
  const r = await revisarPlantillas(e.p, pr, e.deps);
  assert.equal(registro.length, 0);
  const l7 = item(r, 'ligera', 'L7');
  assert.deepEqual([l7.estado, l7.origen, l7.archivo, l7.linea, l7.cita], ['falla', 'determinista', 'src/a.ts', 2, 'const x: any = 1;']);
  assert.deepEqual(l7.hallazgos.map((h) => h.regla), ['tipo-any']);
  assert.equal(item(r, 'ligera', 'L9').estado, 'falla');
  assert.match(r.resultado.markdown, /\*\*suggestion \(non-blocking\): Use `unknown` and narrow it/);
  assert.match(r.resultado.markdown, /\*\*issue \(blocking\): Remove the Co-Authored-By/);

  const limpio = entorno({ plantillas });
  const r2 = await revisarPlantillas(limpio.p, pr, limpio.deps);
  const l7b = item(r2, 'ligera', 'L7');
  assert.deepEqual([l7b.estado, l7b.origen, l7b.detalle], ['cumple', 'determinista', 'No added line matches the rules as-any, tipo-any']);
  assert.equal(item(r2, 'ligera', 'L9').estado, 'cumple');
});

test('a deterministic item whose rules are all unavailable, or whose commits could not be read, is not verifiable', async () => {
  const plantillas = [tpl('ligera', [it('L7', { reglas: ['as-any'] }), it('L8', { reglas: ['no-existe'] }), it('L9', { reglas: ['atribucion-ia'] })])];
  const e = entorno({ plantillas, commits: async () => { throw new Error('gh down'); } });
  e.p.repos.api.reglas_omitidas = ['as-any'];
  const r = await revisarPlantillas(e.p, pr, e.deps);
  for (const id of ['L7', 'L8', 'L9']) assert.equal(item(r, 'ligera', id).estado, 'no_verificable', id);
  assert.equal(item(r, 'ligera', 'L8').motivo, 'The rules no-existe are not available in this project');
  assert.ok(item(r, 'ligera', 'L9').pedido);
});

test('without the other repositories the deployment item is not verifiable', async () => {
  const L4 = it('L4-despliegue', { reglas: ['rutas-en-otros-repos'] });
  const plantillas = [tpl('ligera', [L4])];
  const quita = [{ filename: 'src/rutas.js', status: 'modified', additions: 0, deletions: 1, patch: "@@ -3,1 +3,0 @@\n-router.get('/v1/pagos/lista', h);" }];
  const sin = entorno({ plantillas, diff: quita, otras: async () => { throw new Error('no checkout'); } });
  const r = await revisarPlantillas(sin.p, pr, sin.deps);
  const l4 = item(r, 'ligera', 'L4-despliegue');
  assert.deepEqual([l4.estado, l4.origen, l4.pedido], ['no_verificable', 'determinista', 'Check the other repositories by hand: they could not be loaded']);
  assert.equal(r.resultado.otrosRepos, 'no_disponibles');

  const otro = mkdtempSync(join(tmpdir(), 'seki-otro-'));
  const busquedas = [];
  const con = entorno({ plantillas, diff: quita, otras: async () => ({ ambiente: 'pruebas', lista: [{ repo: 'web', portal: 'w', rama: 'develop', sha: 'c'.repeat(40), dir: otro }] }),
    grep: async (dir, ruta) => { busquedas.push([dir, ruta]); return [{ archivo: 'src/cliente.js', linea: 9, texto: `get('${ruta}')` }]; } });
  const r2 = await revisarPlantillas(con.p, pr, con.deps);
  const l4b = item(r2, 'ligera', 'L4-despliegue');
  assert.deepEqual(busquedas, [[otro, '/v1/pagos/lista']]);
  assert.deepEqual([l4b.estado, l4b.archivo, l4b.linea, l4b.cita], ['falla', 'src/rutas.js', 3, '/v1/pagos/lista']);
  assert.equal(l4b.hallazgos[0].repoOtro, 'web');
  assert.equal(r2.resultado.otrosRepos, undefined);

  const parcial = entorno({ plantillas, diff: quita, otras: async () => ({ ambiente: 'pruebas', lista: [{ repo: 'web', portal: 'w', rama: 'develop', falla: 'fetch failed' }] }) });
  const r3 = await revisarPlantillas(parcial.p, pr, parcial.deps);
  assert.equal(item(r3, 'ligera', 'L4-despliegue').estado, 'no_verificable');
});

test('a removed route used only in the other repository spec fails the item without blocking', async () => {
  const L4 = it('L4-despliegue', { reglas: ['rutas-en-otros-repos'], siFalla: { etiqueta: 'issue', bloqueante: true } });
  const quita = [{ filename: 'src/rutas.js', status: 'modified', additions: 0, deletions: 1, patch: "@@ -3,1 +3,0 @@\n-router.get('/v2/orders', h);" }];
  const otro = mkdtempSync(join(tmpdir(), 'seki-otro-'));
  const e = entorno({ plantillas: [tpl('ligera', [L4])], diff: quita,
    otras: async () => ({ ambiente: 'pruebas', lista: [{ repo: 'web', portal: 'w', rama: 'develop', sha: 'c'.repeat(40), dir: otro }] }),
    grep: async () => [{ archivo: 'test/orders.spec.ts', linea: 4, texto: "get('/v2/orders')" }, { archivo: 'src/bulk.ts', linea: 2, texto: "get('/v2/ordersBulk')" }] });
  const r = await revisarPlantillas(e.p, pr, e.deps);
  const l4 = item(r, 'ligera', 'L4-despliegue');
  assert.equal(l4.estado, 'falla');
  assert.deepEqual(l4.hallazgos.map((h) => h.soloPruebas), [true]);
  assert.equal(r.resultado.comentarios[0].bloqueante, false);
  assert.ok(r.resultado.comentarios[0].detalle.startsWith('Only in tests or docs.'));
});

test('a rejected failure becomes not verifiable with the reason and a confirmed blocking one stays blocking', async () => {
  const registro = [];
  const plantillas = [tpl('ligera', [it('L1'), it('L2'), it('L3'), it('L5'), it('L6')])];
  const { p, deps } = entorno({ plantillas, registro, verificar: veredictosDe({ 'ligera/L2': 'REJECTED', 'ligera/L3': 'PLAUSIBLE' }), respuestas: { ligera: { items: [
    cita('L1', 'falla', 2, 'suma(1,   2)'), cita('L2', 'falla', 3, 'return valor;'), cita('L3', 'falla', 1, 'import { suma }'),
    cita('L5', 'falla', 2, 'not there'), cita('L6', 'cumple', 1, 'import { suma }'),
  ] } } });
  const r = await revisarPlantillas(p, pr, deps);
  const verif = registro.find((c) => !/^Template: /m.test(c.prompt));
  const fichas = JSON.parse(/Findings:\n([^]*)$/.exec(verif.prompt)[1]);
  assert.deepEqual(fichas.map((f) => f.id), ['ligera/L1', 'ligera/L2', 'ligera/L3']);
  assert.match(verif.args[verif.args.indexOf('--system-prompt') + 1], /verify the findings/);
  const l2 = item(r, 'ligera', 'L2');
  assert.deepEqual([l2.estado, l2.motivo, l2.pedido], ['no_verificable', 'Rejected by the verification: Reason ligera/L2', 'Title L2']);
  assert.equal(item(r, 'ligera', 'L1').veredicto, 'CONFIRMED');
  assert.equal(item(r, 'ligera', 'L3').veredicto, 'PLAUSIBLE');
  assert.match(r.resultado.markdown, /\*\*issue \(blocking\): Title L1\*\*/);
  assert.match(r.resultado.markdown, /\*\*issue \(non-blocking\): Title L3\*\*/);
  assert.match(r.resultado.markdown, /\*\*praise: Title L6\*\*/);
  assert.equal(r.resultado.verificacion, undefined);
});

test('no verdict keeps the failure non-blocking; a failed verification call marks the result', async () => {
  const plantillas = [tpl('ligera', [it('L1'), it('L2')])];
  const respuestas = { ligera: { items: [cita('L1', 'falla', 2, 'suma(1, 2)'), cita('L2', 'falla', 1, 'import { suma }')] } };
  const a = entorno({ plantillas, respuestas, verificar: () => ok({ veredictos: [{ id: 'ligera/L1', veredicto: 'CONFIRMED', razon: 'r' }, { id: 'ligera/L1', veredicto: 'REJECTED', razon: 'dup' }] }, 0.1) });
  const r = await revisarPlantillas(a.p, pr, a.deps);
  assert.deepEqual([item(r, 'ligera', 'L1').veredicto, item(r, 'ligera', 'L2').veredicto], ['CONFIRMED', null]);
  assert.match(r.resultado.markdown, /\*\*issue \(non-blocking\): Title L2\*\*/);

  const b = entorno({ plantillas, respuestas, verificar: () => ({ ok: false, costo: 0.1, modelo: 'm', salida: null, motivoSeguro: 'The job reached its turn limit' }) });
  const r2 = await revisarPlantillas(b.p, pr, b.deps);
  assert.equal(r2.ok, true);
  assert.equal(r2.resultado.verificacion, 'fallida');
  assert.deepEqual(r2.resultado.plantillas[0].items.map((i) => [i.estado, i.veredicto]), [['falla', null], ['falla', null]]);
  assert.doesNotMatch(r2.resultado.markdown, /\(blocking/);
});

test('one failed template does not fail the job; all failed does', async () => {
  const plantillas = [tpl('ligera', [it('L1'), it('L7', { reglas: ['tipo-any'] })]), tpl('owasp-web', [it('W1')])];
  const e = entorno({ plantillas, verificar: veredictosDe({}), respuestas: { ligera: new Error('x'), 'owasp-web': { items: [cita('W1', 'falla', 1, 'import { suma }')] } } });
  const r = await revisarPlantillas(e.p, pr, e.deps);
  assert.equal(r.ok, true);
  const t = r.resultado.plantillas[0];
  assert.deepEqual([t.ok, t.motivo, t.costo], [false, 'The job exceeded the maximum time', 0.5]);
  assert.deepEqual(t.items.map((i) => [i.id, i.estado, i.motivo]), [['L1', 'no_verificable', 'The template review failed'], ['L7', 'cumple', undefined]]);
  assert.equal(r.resultado.plantillas[1].ok, true);
  assert.equal(item(r, 'owasp-web', 'W1').veredicto, 'CONFIRMED');
  assert.ok(leerPlantillasPr(e.p, 'api', 7));

  const registro = [];
  const todas = entorno({ plantillas, registro, respuestas: { ligera: new Error('x'), 'owasp-web': new Error('x') } });
  const r2 = await revisarPlantillas(todas.p, pr, todas.deps);
  assert.deepEqual([r2.ok, r2.resultado, r2.motivo], [false, null, 'The job exceeded the maximum time']);
  assert.equal(registro.length, 2);
  assert.equal(leerPlantillasPr(todas.p, 'api', 7), null);
  const [rec] = leerCostos(todas.p);
  assert.deepEqual([rec.ok, rec.motivo, rec.costo], [false, 'The job exceeded the maximum time', 1]);
});

test('the result is stored per commit, read back as outdated after a new head, and a second run for the same head spends nothing', async () => {
  const registro = [];
  const plantillas = [tpl('ligera', [it('L1')])];
  const { p, deps } = entorno({ plantillas, registro, verificar: veredictosDe({}), respuestas: { ligera: { items: [cita('L1', 'falla', 1, 'import { suma }')] } } });
  const r = await revisarPlantillas(p, pr, deps);
  const crudo = JSON.parse(readFileSync(join(p.salida, 'plantillas', 'api-7.json'), 'utf8'));
  assert.deepEqual(Object.keys(crudo).sort(), ['comentarios', 'fecha', 'headSha', 'markdown', 'plantillas', 'ramas', 'recortados', 'seleccion']);
  assert.deepEqual(Object.keys(crudo.plantillas[0]).sort(), ['costo', 'huella', 'id', 'idioma', 'items', 'ok', 'titulo', 'version']);
  assert.equal(crudo.headSha, SHA);
  assert.deepEqual(crudo.seleccion.activas, [{ id: 'ligera', version: 1, titulo: 'Template ligera', motivo: 'siempre' }]);
  assert.equal(r.resultado.comentarios.length, 1);
  const antes = registro.length;
  const otra = await revisarPlantillas(p, pr, deps);
  assert.deepEqual([otra.ok, otra.desdeCache, otra.costo, registro.length], [true, true, 0, antes]);
  await revisarPlantillas(p, pr, { ...deps, repetir: true });
  assert.ok(registro.length > antes);
  const nueva = 'b'.repeat(40);
  assert.equal(leerPlantillasPr(p, 'api', 7, nueva).desactualizada, true);
  assert.equal(leerPlantillasPr(p, 'api', 7, SHA).desactualizada, undefined);
  const r3 = await revisarPlantillas(p, { ...pr, headSha: nueva }, deps);
  assert.equal(r3.desdeCache, undefined);
  assert.equal(leerPlantillasPr(p, 'api', 7, nueva).headSha, nueva);
});

test('the cost record has tipo revisar_plantillas and one detail per step', async () => {
  const plantillas = [tpl('ligera', [it('L1')]), tpl('owasp-web', [it('W1')]), tpl('reglas', [it('R1', { reglas: ['tipo-any'] })])];
  const { p, deps } = entorno({ plantillas, verificar: veredictosDe({}), respuestas: {
    ligera: { items: [cita('L1', 'falla', 1, 'import { suma }', { titulo: 'TITULO-SECRETO' })] }, 'owasp-web': { items: [] } } });
  const r = await revisarPlantillas(p, pr, deps);
  assert.equal(r.costo, 1.25);
  assert.equal(r.modelo, 'claude-sonnet-5-5');
  const registros = leerCostos(p);
  assert.equal(registros.length, 1);
  const [rec] = registros;
  assert.deepEqual([rec.tipo, rec.modo, rec.prId, rec.costo, rec.ok], ['revisar_plantillas', 'normal', 'api#7', 1.25, true]);
  assert.equal(rec.plantillasIa, 2);
  assert.deepEqual(rec.detalle.map((d) => d.paso), ['ligera', 'owasp-web', 'verificar']);
  for (const d of rec.detalle) assert.deepEqual(Object.keys(d).sort(), d.paso === 'verificar' ? ['costo', 'modelo', 'ok', 'paso', 'uso', 'verifica'] : ['costo', 'modelo', 'ok', 'paso', 'uso']);
  assert.doesNotMatch(readFileSync(join(p.salida, 'datos/costos.jsonl'), 'utf8'), /SECRET|Template:/);
  assert.deepEqual(r.resultado.plantillas.map((t) => t.costo), [0.5, 0.5, 0]);
});

test('with no AI items the deterministic part runs alone: no AI call, no copy, cost 0 and the result is stored', async () => {
  const registro = [];
  const plantillas = [tpl('ligera', [it('L7', { reglas: ['tipo-any'] })])];
  const e = entorno({ plantillas, registro });
  let copias = 0;
  e.deps.copiar = async () => { copias++; return e.copia; };
  const r = await revisarPlantillas(e.p, pr, e.deps);
  assert.deepEqual([r.ok, r.costo, registro.length, copias], [true, 0, 0, 0]);
  assert.equal(item(r, 'ligera', 'L7').estado, 'cumple');
  assert.ok(leerPlantillasPr(e.p, 'api', 7));
  assert.equal(leerCostos(e.p).length, 0);
});

test('templates respect the concurrency limit and every call blocks secrets in the copy', async () => {
  const plantillas = ['a', 'b', 'c'].map((id) => tpl(id, [it(`${id.toUpperCase()}1`)]));
  const registro = [];
  const uno = entorno({ plantillas, registro });
  await revisarPlantillas(uno.p, pr, { ...uno.deps, paralelo: 1 });
  assert.equal(uno.maximo(), 1);
  for (const c of registro) {
    assert.equal(c.cwd, uno.copia);
    assert.ok(c.args.some((x) => x.startsWith('Read(/') && x.endsWith('/**/*.env)')));
    assert.ok(c.args.includes('--json-schema'));
  }
  const dos = entorno({ plantillas });
  await revisarPlantillas(dos.p, pr, { ...dos.deps, paralelo: 2 });
  assert.equal(dos.maximo(), 2);
});

test('without a head commit the job fails before spending', async () => {
  const e = entorno({ plantillas: [tpl('ligera', [it('L1')])] });
  await assert.rejects(revisarPlantillas(e.p, { ...pr, headSha: undefined }, e.deps), /no head commit/);
  assert.equal(leerCostos(e.p).length, 0);
});

test('datosPlantillas gives selection, invalid files, estimate and cap, and warns once per invalid file', async (t) => {
  const propias = mkdtempSync(join(tmpdir(), 'seki-propias-'));
  writeFileSync(join(propias, 'rota.json'), '{ no es json');
  writeFileSync(join(propias, 'pagos.json'), JSON.stringify(tpl('pagos', [it('P1')], { siempre: false, aplicaA: ['src/pagos/**'] })));
  const salida = mkdtempSync(join(tmpdir(), 'seki-plantillas-'));
  const p = { salida, plantillas: propias, repos: { api: {} } };
  const avisos = t.mock.method(console, 'error', () => {});
  const d = await datosPlantillas(p, pr, ['src/pagos/cobro.ts']);
  await datosPlantillas(p, pr, ['src/pagos/cobro.ts']);
  assert.equal(avisos.mock.calls.filter((c) => /rota\.json/.test(c.arguments[0])).length, 1);
  assert.deepEqual(d.invalidas.map((x) => x.archivo), ['rota.json']);
  assert.ok(d.seleccion.activas.some((a) => a.id === 'pagos'));
  assert.ok(d.seleccion.activas.some((a) => a.id === 'ligera'));
  const n = d.seleccion.activas.length;
  assert.equal(d.topeUsd, topeRevisarPlantillas(n));
  assert.deepEqual(d.estimacion, { usd: d.topeUsd, base: 'topes', muestras: 0 });
  assert.equal(d.resultado, null);

  writeFileSync(join(propias, 'rota.json'), JSON.stringify(tpl('rota', [it('X1')])));
  const d2 = await datosPlantillas(p, pr, ['src/pagos/cobro.ts']);
  assert.deepEqual(d2.invalidas, []);
  assert.ok(d2.seleccion.activas.some((a) => a.id === 'rota'));
});

test('evidence in a listed other repository is accepted with its repo; an unknown repo is not', async () => {
  const otro = mkdtempSync(join(tmpdir(), 'seki-otro-'));
  mkdirSync(join(otro, 'src'));
  writeFileSync(join(otro, 'src/cliente.js'), 'a\nfetch("/v1/pagos/lista");\nb\n');
  const registro = [];
  const plantillas = [tpl('ligera', [it('L1'), it('L2'), it('L3')])];
  const e = entorno({ plantillas, registro, verificar: veredictosDe({}),
    otras: async () => ({ ambiente: 'pruebas', lista: [{ repo: 'web', portal: 'w', rama: 'develop', sha: 'c'.repeat(40), dir: otro }] }),
    respuestas: { ligera: { items: [
      cita('L1', 'falla', 2, 'fetch("/v1/pagos/lista");', { repo: 'web', archivo: 'src/cliente.js' }),
      cita('L2', 'falla', 2, 'fetch("/v1/pagos/lista");', { repo: 'nadie', archivo: 'src/cliente.js' }),
      cita('L3', 'cumple', 2, 'const valor = suma(1, 2);', { repo: 'api' }),
    ] } } });
  const r = await revisarPlantillas(e.p, pr, e.deps);
  const l1 = item(r, 'ligera', 'L1');
  assert.deepEqual([l1.estado, l1.repo, l1.archivo, l1.linea], ['falla', 'web', 'src/cliente.js', 2]);
  const l2 = item(r, 'ligera', 'L2');
  assert.deepEqual([l2.estado, l2.motivo], ['no_verificable', 'The quote does not match the cited code']);
  const l3 = item(r, 'ligera', 'L3');
  assert.deepEqual([l3.estado, l3.repo], ['cumple', undefined]);
  const verif = registro.find((c) => !/^Template: /m.test(c.prompt));
  const fichas = JSON.parse(/Findings:\n([^]*)$/.exec(verif.prompt)[1]);
  assert.deepEqual(fichas.map((f) => [f.id, f.repo]), [['ligera/L1', 'web']]);
});

test('a deterministic-only run without the route rule does not load the other repositories', async () => {
  const plantillas = [tpl('ligera', [it('L7', { reglas: ['tipo-any'] })])];
  let llamadas = 0;
  const e = entorno({ plantillas, otras: async () => { llamadas++; throw new Error('no checkout'); } });
  const r = await revisarPlantillas(e.p, pr, e.deps);
  assert.equal(llamadas, 0);
  assert.equal(r.resultado.otrosRepos, undefined);
  assert.equal(r.motivo, null);
});

test('quotes over 300 characters, under 8 non-space characters or outside the copy are rejected', async () => {
  const largo = `const valor = suma(1, 2);${' x'.repeat(150)}`;
  const e = entorno({ plantillas: [tpl('ligera', [it('L1'), it('L2'), it('L3'), it('L4'), it('L5')])], verificar: veredictosDe({}), respuestas: { ligera: { items: [
    cita('L1', 'falla', 2, largo),
    cita('L2', 'falla', 3, '}'),
    cita('L3', 'falla', 1, 'import { suma } from'),
    cita('L4', 'falla', 1, 'localhost', { archivo: '../copia/../../etc/hosts' }),
    cita('L5', 'falla', 1, 'localhost', { archivo: '/etc/hosts' }),
  ] } } });
  writeFileSync(join(e.copia, 'src/a.ts'), `${ARCHIVO}${largo}\n`);
  const r = await revisarPlantillas(e.p, pr, e.deps);
  for (const id of ['L1', 'L2', 'L4', 'L5']) assert.deepEqual([item(r, 'ligera', id).estado, item(r, 'ligera', id).motivo], ['no_verificable', 'The quote does not match the cited code'], id);
  assert.equal(item(r, 'ligera', 'L3').estado, 'falla');
});

test('an empty AI title is not stored and the comment falls back to the question', async () => {
  const e = entorno({ plantillas: [tpl('ligera', [it('L1')])], verificar: veredictosDe({}), respuestas: { ligera: { items: [
    cita('L1', 'falla', 1, 'import { suma }', { titulo: '   ' }),
  ] } } });
  const r = await revisarPlantillas(e.p, pr, e.deps);
  const l1 = item(r, 'ligera', 'L1');
  assert.equal('titulo' in l1, false);
  const { markdown } = comentariosDePlantillas(r.resultado);
  assert.doesNotMatch(markdown, /\*\*issue \([^)]*\): \*\*/);
  assert.match(markdown, /\*\*issue \(blocking\): Question L1\?\*\*/);
});

test('the estimate is the median cost per AI template times the AI templates selected', async () => {
  const salida = mkdtempSync(join(tmpdir(), 'seki-plantillas-'));
  const p = { salida, repos: { api: {} } };
  for (const [costo, plantillasIa] of [[1, 2], [3, 3], [0.4, 1]]) registrarCosto(p, { tipo: 'revisar_plantillas', modo: 'normal', costo, ok: true, plantillasIa });
  // Per template: 0.5, 1, 0.4 -> median 0.5. A record without the count is one template.
  const sin = await datosPlantillas(p, pr, []);
  const n = sin.seleccion.activas.length;
  assert.equal(sin.estimacion.base, 'historial');
  assert.equal(sin.estimacion.usd, 0.5 * n);
  const d = await datosPlantillas(p, pr, ['src/pagos/cobro.ts', 'src/routes/ordenes.ts']);
  const m = d.seleccion.activas.length;
  assert.ok(m > n);
  assert.equal(d.estimacion.usd, 0.5 * m);
  registrarCosto(p, { tipo: 'revisar_plantillas', modo: 'normal', costo: 9, ok: true });
  registrarCosto(p, { tipo: 'revisar_plantillas', modo: 'normal', costo: 9, ok: true });
  assert.equal((await datosPlantillas(p, pr, [])).estimacion.usd, 1 * n);
});

const HASH = /^[0-9a-f]{64}$/;
const NUEVA = 'b'.repeat(40);
const archivo = (filename, patch) => ({ filename, status: 'modified', additions: 1, deletions: 0, patch });
const mundo = (extra = {}) => entorno({ plantillas: [
  tpl('ligera', [it('L1')]), tpl('pci', [it('P1')], { siempre: false, aplicaA: ['src/pci/**'] })],
  diff: [archivo('src/a.ts', '@@ -1 +1 @@\n+uno'), archivo('src/pci/x.ts', '@@ -1 +1 @@\n+pci')],
  verificar: veredictosDe({ 'pci/P1': 'PLAUSIBLE' }),
  respuestas: { ligera: { items: [cita('L1', 'cumple', 1, 'import { suma }')] }, pci: { items: [cita('P1', 'falla', 1, 'import { suma }')] } }, ...extra });

test('every template prompt starts with the same context and ends with its items; the first call finishes before the second starts', async () => {
  const registro = [];
  const plantillas = ['a', 'b', 'c'].map((id) => tpl(id, [it(`${id.toUpperCase()}1`)]));
  const e = entorno({ plantillas, registro });
  await revisarPlantillas(e.p, pr, { ...e.deps, paralelo: 2 });
  assert.equal(registro.length, 3);
  const contextos = registro.map((c) => c.prompt.slice(0, c.prompt.indexOf('\n\nTemplate: ')));
  assert.ok(contextos[0].length > 0 && contextos.every((c) => c === contextos[0]));
  registro.forEach((c, i) => {
    const id = ['a', 'b', 'c'][i];
    assert.match(c.prompt, new RegExp(`\\n\\nTemplate: ${id} v1\\. Language: en\\.\\n\\nItems:\\n\\[[^]*"id": "${id.toUpperCase()}1"[^]*\\]$`));
  });
  assert.equal(registro[1].anteriorTerminada, true);
  assert.equal(e.maximo(), 2);
});

test('the cost record and each of its steps carry the token usage', async () => {
  const e = mundo();
  await revisarPlantillas(e.p, pr, e.deps);
  const [rec] = leerCostos(e.p);
  assert.equal(rec.detalle.length, 3);
  for (const d of rec.detalle) assert.deepEqual(d.uso, USO);
  assert.deepEqual(rec.uso, { entrada: 30, cacheCreada: 15, cacheLeida: 6, salida: 9 });
});

test('a template whose fingerprint did not change is not called again and keeps its verdicts', async () => {
  const registro = [];
  const e = mundo({ registro });
  const primera = await revisarPlantillas(e.p, pr, e.deps);
  for (const t of primera.resultado.plantillas) assert.match(t.huella, HASH);
  assert.equal(item(primera, 'pci', 'P1').veredicto, 'PLAUSIBLE');
  registro.length = 0;
  // The new commit changes only src/a.ts: ligera (always active) reads every patch, pci only its own file.
  e.deps.diff = async () => [archivo('src/a.ts', '@@ -1 +1 @@\n+dos'), archivo('src/pci/x.ts', '@@ -1 +1 @@\n+pci')];
  e.deps.cargar = () => ({ plantillas: [tpl('ligera', [it('L1')]), tpl('pci', [it('P1')], { siempre: false, aplicaA: ['src/pci/**'] })], invalidas: [] });
  const r = await revisarPlantillas(e.p, { ...pr, headSha: NUEVA }, e.deps);
  assert.deepEqual(registro.map((c) => /^Template: ([\w-]+)/m.exec(c.prompt)?.[1]), ['ligera']);
  const p1 = item(r, 'pci', 'P1');
  assert.deepEqual([p1.estado, p1.veredicto, p1.reutilizada], ['falla', 'PLAUSIBLE', true]);
  assert.equal(item(r, 'ligera', 'L1').reutilizada, undefined);
  assert.equal(r.resultado.plantillas.find((t) => t.id === 'pci').costo, 0);
  assert.equal(r.resultado.headSha, NUEVA);
  assert.equal(leerCostos(e.p).at(-1).plantillasIa, 1);
});

test('only new failing items are verified; reused ones are not sent again', async () => {
  const registro = [];
  const e = mundo({ registro, respuestas: { ligera: { items: [cita('L1', 'falla', 1, 'import { suma }')] }, pci: { items: [cita('P1', 'falla', 1, 'import { suma }')] } } });
  await revisarPlantillas(e.p, pr, e.deps);
  registro.length = 0;
  e.deps.diff = async () => [archivo('src/a.ts', '@@ -1 +1 @@\n+dos'), archivo('src/pci/x.ts', '@@ -1 +1 @@\n+pci')];
  e.deps.cargar = () => ({ plantillas: [tpl('ligera', [it('L1')]), tpl('pci', [it('P1')], { siempre: false, aplicaA: ['src/pci/**'] })], invalidas: [] });
  await revisarPlantillas(e.p, { ...pr, headSha: NUEVA }, e.deps);
  const verif = registro.find((c) => !/^Template: /m.test(c.prompt));
  assert.deepEqual(JSON.parse(/Findings:\n([^]*)$/.exec(verif.prompt)[1]).map((f) => f.id), ['ligera/L1']);
});

test('a changed patch of an activating file, a changed item or repetir call the template again', async () => {
  const registro = [];
  const e = mundo({ registro });
  await revisarPlantillas(e.p, pr, e.deps);
  const plantillas = [tpl('ligera', [it('L1')]), tpl('pci', [it('P1')], { siempre: false, aplicaA: ['src/pci/**'] })];
  const llamadas = async (deps, head = NUEVA) => {
    registro.length = 0;
    await revisarPlantillas(e.p, { ...pr, headSha: head }, deps);
    return registro.filter((c) => /^Template: /m.test(c.prompt)).map((c) => /^Template: ([\w-]+)/m.exec(c.prompt)[1]);
  };
  const igual = [archivo('src/a.ts', '@@ -1 +1 @@\n+uno'), archivo('src/pci/x.ts', '@@ -1 +1 @@\n+pci')];
  assert.deepEqual(await llamadas({ ...e.deps, cargar: () => ({ plantillas, invalidas: [] }), diff: async () => igual }), []);
  const cambiado = [igual[0], archivo('src/pci/x.ts', '@@ -1 +1 @@\n+pci2')];
  assert.deepEqual(await llamadas({ ...e.deps, cargar: () => ({ plantillas, invalidas: [] }), diff: async () => cambiado }, 'c'.repeat(40)), ['ligera', 'pci']);
  const otroItem = [tpl('ligera', [it('L1')]), tpl('pci', [it('P1', { pregunta: 'Another question?' })], { siempre: false, aplicaA: ['src/pci/**'] })];
  assert.deepEqual(await llamadas({ ...e.deps, cargar: () => ({ plantillas: otroItem, invalidas: [] }), diff: async () => cambiado }, 'd'.repeat(40)), ['pci']);
  assert.deepEqual(await llamadas({ ...e.deps, cargar: () => ({ plantillas: otroItem, invalidas: [] }), diff: async () => cambiado, repetir: true }, 'd'.repeat(40)), ['ligera', 'pci']);
});

test('a template that failed or has an unjudged failure is not reused', async (t) => {
  t.mock.method(console, 'error', () => {});
  const registro = [];
  const e = mundo({ registro, verificar: () => ({ ok: false, costo: 0.1, salida: null, motivoSeguro: 'The job failed' }) });
  const primera = await revisarPlantillas(e.p, pr, e.deps);
  assert.equal(primera.resultado.verificacion, 'fallida');
  registro.length = 0;
  const r = await revisarPlantillas(e.p, { ...pr, headSha: NUEVA }, e.deps);
  assert.deepEqual(registro.filter((c) => /^Template: /m.test(c.prompt)).map((c) => /^Template: ([\w-]+)/m.exec(c.prompt)[1]), ['pci']);
  assert.equal(item(r, 'pci', 'P1').reutilizada, undefined);
});

test('when everything is reused no AI call and no cost record are made and the result is rewritten for the new commit', async () => {
  const registro = [];
  const plantillas = [tpl('pci', [it('P1')], { siempre: false, aplicaA: ['src/pci/**'] })];
  const diff1 = [archivo('src/pci/x.ts', '@@ -1 +1 @@\n+pci'), archivo('docs/a.md', '@@ -1 +1 @@\n+uno')];
  const e = entorno({ plantillas, registro, diff: diff1, verificar: veredictosDe({}), respuestas: { pci: { items: [cita('P1', 'falla', 1, 'import { suma }')] } },
    otras: async () => ({ ambiente: 'pruebas', lista: [{ repo: 'web', rama: 'develop', sha: 'c'.repeat(40), dir: '/tmp/x' }] }) });
  await revisarPlantillas(e.p, pr, e.deps);
  const registros = leerCostos(e.p).length;
  registro.length = 0;
  let copias = 0;
  const r = await revisarPlantillas(e.p, { ...pr, headSha: NUEVA }, { ...e.deps, diff: async () => [diff1[0], archivo('docs/a.md', '@@ -1 +1 @@\n+dos')], copiar: async () => { copias++; return e.copia; },
    otras: async () => ({ ambiente: 'pruebas', lista: [{ repo: 'web', rama: 'develop', sha: 'c'.repeat(40), dir: '/tmp/x' }] }) });
  assert.deepEqual([r.ok, r.costo, r.modelo, registro.length, copias, leerCostos(e.p).length], [true, 0, null, 0, 1, registros]);
  assert.equal(item(r, 'pci', 'P1').reutilizada, true);
  assert.equal(leerPlantillasPr(e.p, 'api', 7, NUEVA).headSha, NUEVA);
  assert.equal(leerPlantillasPr(e.p, 'api', 7, NUEVA).desactualizada, undefined);
  assert.deepEqual(r.resultado.ramas, [{ repo: 'web', rama: 'develop', sha: 'c'.repeat(40) }]);
});

test('the result stores the other branches that were read and leaves out those that failed', async () => {
  const e = entorno({ plantillas: [tpl('ligera', [it('L1')])], otras: async () => ({ ambiente: 'pruebas', lista: [
    { repo: 'web', rama: 'develop', sha: 'c'.repeat(40), dir: '/tmp/w' }, { repo: 'jobs', rama: 'develop', falla: 'no checkout' }] }) });
  const r = await revisarPlantillas(e.p, pr, e.deps);
  assert.deepEqual(r.resultado.ramas, [{ repo: 'web', rama: 'develop', sha: 'c'.repeat(40) }]);
});

test('datosPlantillas reports the branches whose sha moved; an unreadable sha is not a move', async () => {
  const lista = [['web', 'develop', 'c'], ['jobs', 'develop', 'd'], ['docs', 'main', 'e'], ['sdk', 'main', 'f']].map(([repo, rama, c]) => ({ repo, rama, sha: c.repeat(40), dir: `/tmp/${repo}` }));
  const e = entorno({ plantillas: [tpl('ligera', [it('L1')])], otras: async () => ({ ambiente: 'pruebas', lista }) });
  await revisarPlantillas(e.p, pr, e.deps);
  const consultas = [];
  const shaRama = async (_p, repo, rama) => {
    consultas.push(`${repo}:${rama}`);
    if (repo === 'web') return 'z'.repeat(40);
    if (repo === 'jobs') throw new Error('no copy');
    if (repo === 'docs') return null;
    return 'f'.repeat(40);
  };
  const d = await datosPlantillas(e.p, pr, [], { shaRama });
  assert.deepEqual(d.resultado.ramasMovidas, [{ repo: 'web', rama: 'develop' }]);
  assert.equal(consultas.length, 4);
  const quieta = await datosPlantillas(e.p, pr, [], { shaRama: async (_p, repo) => lista.find((x) => x.repo === repo).sha });
  assert.equal('ramasMovidas' in quieta.resultado, false);
  // Default: the local copy of the branch; with no copy on disk nothing moved and git is never reached.
  const porDefecto = await datosPlantillas(e.p, pr, []);
  assert.equal('ramasMovidas' in porDefecto.resultado, false);
  assert.equal((await datosPlantillas({ ...e.p, salida: mkdtempSync(join(tmpdir(), 'seki-vacio-')) }, pr, [])).resultado, null);
});

test('the estimate sums the per-template median of past steps, then the per-template run median, then the cap', async () => {
  const salida = mkdtempSync(join(tmpdir(), 'seki-plantillas-'));
  const p = { salida, repos: { api: {} } };
  const registrar = (costo, detalle, extra = {}) => registrarCosto(p, { tipo: 'revisar_plantillas', modo: 'normal', costo, ok: true, plantillasIa: detalle.length, detalle, ...extra });
  const paso = (id, costo, ok = true) => ({ paso: id, modelo: 'm', costo, ok });
  registrar(0.9, [paso('ligera', 0.1), paso('owasp-web', 0.8)]);
  registrar(0.7, [paso('ligera', 0.3), paso('owasp-web', 0.4)]);
  registrar(0.6, [paso('ligera', 0.2), paso('owasp-web', 0.4, false)]);
  const d = await datosPlantillas(p, pr, ['src/routes/a.ts']);
  const ids = d.seleccion.activas.map((a) => a.id);
  assert.deepEqual(ids, ['ligera', 'owasp-web']);
  // ligera: median(0.1, 0.3, 0.2) = 0.2. owasp-web has two ok steps, so it falls back to the run median
  // per template: (0.45, 0.35, 0.3) -> 0.35.
  assert.equal(d.estimacion.base, 'historial');
  assert.ok(Math.abs(d.estimacion.usd - 0.55) < 1e-9);
  const vacio = await datosPlantillas({ salida: mkdtempSync(join(tmpdir(), 'seki-plantillas-')), repos: {} }, pr, ['src/routes/a.ts']);
  assert.deepEqual(vacio.estimacion, { usd: vacio.topeUsd, base: 'topes', muestras: 0 });
});

test('a file without patch is told apart by its blob sha', async () => {
  const registro = [];
  const sinPatch = (sha) => [{ filename: 'src/a.ts', status: 'modified', additions: 0, deletions: 0, sha }];
  const e = entorno({ plantillas: [tpl('ligera', [it('L1')])], registro, diff: sinPatch('1'.repeat(40)), respuestas: { ligera: { items: [cita('L1', 'cumple', 1, 'import { suma }')] } } });
  await revisarPlantillas(e.p, pr, e.deps);
  registro.length = 0;
  await revisarPlantillas(e.p, { ...pr, headSha: NUEVA }, { ...e.deps, diff: async () => sinPatch('1'.repeat(40)) });
  assert.equal(registro.length, 0);
  await revisarPlantillas(e.p, { ...pr, headSha: 'c'.repeat(40) }, { ...e.deps, diff: async () => sinPatch('2'.repeat(40)) });
  assert.equal(registro.length, 1);
});

test('a reused answer is revalidated against this run: a quote that moved out of its lines asks the template again', async () => {
  const registro = [];
  const e = mundo({ registro });
  await revisarPlantillas(e.p, pr, e.deps);
  registro.length = 0;
  const reutilizadas = await revisarPlantillas(e.p, { ...pr, headSha: NUEVA }, e.deps);
  assert.equal(registro.length, 0);
  assert.equal(item(reutilizadas, 'pci', 'P1').reutilizada, true);
  // Same patches, but the cited line is now far from line 1 in the copy of the new commit.
  writeFileSync(join(e.copia, 'src/a.ts'), `x\ny\nz\nw\nv\nu\n${ARCHIVO}`);
  const movida = await revisarPlantillas(e.p, { ...pr, headSha: 'c'.repeat(40) }, e.deps);
  assert.deepEqual(registro.filter((c) => /^Template: /m.test(c.prompt)).map((c) => /^Template: ([\w-]+)/m.exec(c.prompt)[1]).sort(), ['ligera', 'pci']);
  assert.equal(item(movida, 'pci', 'P1').reutilizada, undefined);
});

test('a quote in another repository is revalidated with the repositories loaded now', async () => {
  const registro = [];
  const otro = mkdtempSync(join(tmpdir(), 'seki-otro-'));
  mkdirSync(join(otro, 'src'));
  writeFileSync(join(otro, 'src/cliente.js'), 'a\nfetch("/v1/pagos/lista");\nb\n');
  const lista = [{ repo: 'web', portal: 'w', rama: 'develop', sha: 'c'.repeat(40), dir: otro }];
  const e = entorno({ plantillas: [tpl('ligera', [it('L1')])], registro, otras: async () => ({ ambiente: 'pruebas', lista }),
    respuestas: { ligera: { items: [cita('L1', 'cumple', 2, 'fetch("/v1/pagos/lista");', { repo: 'web', archivo: 'src/cliente.js' })] } } });
  await revisarPlantillas(e.p, pr, e.deps);
  registro.length = 0;
  await revisarPlantillas(e.p, { ...pr, headSha: NUEVA }, e.deps);
  assert.equal(registro.length, 0);
  writeFileSync(join(otro, 'src/cliente.js'), 'a\nb\n');
  await revisarPlantillas(e.p, { ...pr, headSha: 'c'.repeat(40) }, e.deps);
  assert.equal(registro.length, 1);
});

test('a run that reuses a template keeps the branch commits it was answered at', async () => {
  const dirs = [{ repo: 'web', portal: 'w', rama: 'develop', dir: '/tmp/w' }, { repo: 'jobs', portal: 'j', rama: 'develop', dir: '/tmp/j' }];
  let ramas = dirs.slice(0, 1).map((d) => ({ ...d, sha: 'c'.repeat(40) }));
  const e = mundo({ otras: async () => ({ ambiente: 'pruebas', lista: ramas }) });
  await revisarPlantillas(e.p, pr, e.deps);
  ramas = [{ ...dirs[0], sha: 'd'.repeat(40) }, { ...dirs[1], sha: 'e'.repeat(40) }];
  e.deps.diff = async () => [archivo('src/a.ts', '@@ -1 +1 @@\n+dos'), archivo('src/pci/x.ts', '@@ -1 +1 @@\n+pci')];
  const r = await revisarPlantillas(e.p, { ...pr, headSha: NUEVA }, e.deps);
  assert.equal(item(r, 'pci', 'P1').reutilizada, true);
  assert.deepEqual(r.resultado.ramas, [{ repo: 'web', rama: 'develop', sha: 'c'.repeat(40) }, { repo: 'jobs', rama: 'develop', sha: 'e'.repeat(40) }]);
  const d = await datosPlantillas(e.p, { ...pr, headSha: NUEVA }, [], { shaRama: async (_p, repo) => ramas.find((x) => x.repo === repo).sha });
  assert.deepEqual(d.resultado.ramasMovidas, [{ repo: 'web', rama: 'develop' }]);
  // Nothing reused: the fresh commits replace them.
  const todo = await revisarPlantillas(e.p, { ...pr, headSha: 'c'.repeat(40) }, { ...e.deps, repetir: true });
  assert.deepEqual(todo.resultado.ramas.map((x) => x.sha), ['d'.repeat(40), 'e'.repeat(40)]);
});

test('the verification step never counts as a template called "verificar" in the estimate', () => {
  const registros = [1, 2, 3].map((i) => ({ tipo: 'revisar_plantillas', modo: 'normal', fecha: new Date().toISOString(), costo: 9.2, ok: true, plantillasIa: 1,
    detalle: [{ paso: 'verificar', modelo: 'm', costo: 0.2, ok: true }, { paso: 'verificar', verifica: true, modelo: 'm', costo: 9, ok: true }] }));
  const e = estimarCostoPlantillas(registros, ['verificar'], { topeUsd: 2 });
  assert.equal(e.base, 'historial');
  assert.ok(Math.abs(e.usd - 0.2) < 1e-9);
});

test('a failed template does not stop the others, also with paralelo 1', async (t) => {
  t.mock.method(console, 'error', () => {});
  const registro = [];
  const plantillas = ['a', 'b', 'c'].map((id) => tpl(id, [it(`${id.toUpperCase()}1`)]));
  const e = entorno({ plantillas, registro, respuestas: { a: new Error('boom'), b: { items: [] }, c: { items: [] } } });
  const r = await revisarPlantillas(e.p, pr, { ...e.deps, paralelo: 1 });
  assert.deepEqual(registro.map((c) => /^Template: ([\w-]+)/m.exec(c.prompt)[1]), ['a', 'b', 'c']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.resultado.plantillas.map((x) => [x.id, x.ok]), [['a', false], ['b', true], ['c', true]]);
});
