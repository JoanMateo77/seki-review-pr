// Smoke test: starts the server over stdio and calls a tool.
// Usage: node test/humo.mjs [tool] ['{"arg":1}']
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { escribirJson, rutaInstantanea } from '../mcp/lib/cache.mjs';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const srv = spawn('sh', [join(raiz, 'bin/servidor.sh')], { stdio: ['pipe', 'pipe', 'inherit'] });
const pendientes = new Map();
createInterface({ input: srv.stdout }).on('line', (l) => {
  const m = JSON.parse(l);
  pendientes.get(m.id)?.(m);
});
let id = 0;
const pedir = (method, params) => new Promise((ok) => { pendientes.set(++id, ok); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });

const init = await pedir('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'humo', version: '0' } });
console.log('server:', init.result.serverInfo);
srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const lista = await pedir('tools/list', {});
console.log('tools:', lista.result.tools.map((t) => t.name).join(', '));
const [, , tool, args] = process.argv;
if (tool) {
  const r = await pedir('tools/call', { name: tool, arguments: args ? JSON.parse(args) : {} });
  console.log(r.result?.isError ? 'ERROR' : 'OK');
  console.log(r.result?.content?.[0]?.text ?? JSON.stringify(r.error));
}
if (!lista.result.tools.some((t) => t.name === 'pr_ultra')) { console.error('FAIL: the pr_ultra tool is not registered'); process.exitCode = 1; }
if (!lista.result.tools.some((t) => t.name === 'pr_plantillas')) { console.error('FAIL: the pr_plantillas tool is not registered'); process.exitCode = 1; }
if (!lista.result.tools.some((t) => t.name === 'pr_revisar')) { console.error('FAIL: the pr_revisar tool is not registered'); process.exitCode = 1; }
srv.kill();

// Board with an AI mode and a daily budget, served on a free port; an Ultra review with fake dependencies stores its result.
// Skipped when a tool was requested on the command line.
if (!tool) {
  const { proyecto: cargarProyecto } = await import('../mcp/lib/config.mjs');
  const { detenerServidores, iniciarServidor } = await import('../mcp/lib/servidor-web.mjs');
  const { leerUltra, revisarUltra } = await import('../mcp/lib/ultra.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'seki-humo-'));
  const configPrevia = process.env.SEKI_REVIEW_CONFIG;
  try {
    const salida = join(dir, 'salida');
    mkdirSync(join(salida, 'datos'), { recursive: true });
    const copia = join(dir, 'copia');
    mkdirSync(join(copia, 'src'), { recursive: true });
    writeFileSync(join(copia, 'src/a.ts'), 'l1\nl2\nl3\n');
    writeFileSync(join(dir, 'proyectos.json'), JSON.stringify({ humo: { owner: 'o', salida, repos: { r: { lineas: [{ portal: 'P', prod: 'main', pruebas: 'develop' }] } }, ia: { modo: 'ahorro', presupuestoDiarioUsd: 20 } } }));
    process.env.SEKI_REVIEW_CONFIG = join(dir, 'proyectos.json');
    const sha = 'a'.repeat(40);
    const pr = { id: 'r#1', repo: 'r', numero: 1, titulo: 'Change', url: 'https://example.test/r/1', base: 'main', rama: 'f', portal: 'P', ambiente: 'prod', estadoPr: 'OPEN', headSha: sha, creada: new Date().toISOString(), body: '' };
    escribirJson(rutaInstantanea(salida), { proyecto: 'humo', generado: new Date().toISOString(), owner: 'o', prs: [pr], recientes: [] });
    const fake = async (args) => (/^Lens: /.test(args[args.indexOf('-p') + 1])
      ? { ok: true, costo: 0.1, modelo: 'claude-sonnet-5-5', salida: { hallazgos: [{ archivo: 'src/a.ts', linea: 2, severidad: 'alta', titulo: 'Problem', detalle: 'Evidence.' }] } }
      : { ok: true, costo: 0.1, modelo: 'claude-sonnet-5-5', salida: { veredictos: [{ id: 'correccion-1', veredicto: 'CONFIRMED', razon: 'Seen in src/a.ts:2' }] } });
    const p = cargarProyecto('humo');
    const ejecutarUltra = (proy, prr, opciones) => revisarUltra(proy, prr, {
      ejecutar: fake, copiar: async () => copia, otras: async () => ({ ambiente: 'pruebas', lista: [] }), diff: async () => [{ filename: 'src/a.ts', status: 'modified', patch: '@@ -1 +1,2 @@\n l1\n+l2' }],
      guias: () => 'RULES', copiarComprobacion: async () => ({ dir: copia, baseSha: sha }), comprobarFn: async () => ({ reglas: { hallazgos: [], resumen: {}, bloqueantes: 0 }, tipos: null, tests: null }), paralelo: 1, ...opciones,
    });
    const { url } = await iniciarServidor({ proyecto: 'humo', puerto: 0, abrir: false, ejecutarUltra });
    const u = new URL(url);
    const llamar = (ruta, cuerpo) => fetch(`${u.origin}${ruta}`, { method: cuerpo ? 'POST' : 'GET', headers: { 'x-seki-token': u.searchParams.get('t'), 'content-type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    const estadoApi = await (await llamar('/api/estado')).json();
    const pagina = await (await fetch(url)).text();
    const verificar = (ok, texto) => { console.log(ok ? 'ok  ' : 'FAIL', texto); if (!ok) process.exitCode = 1; };
    verificar(estadoApi.presupuesto?.limite === 20 && estadoApi.modo === 'ahorro', '/api/estado exposes the budget and the project mode');
    verificar(pagina.includes('id="selModo"') && pagina.includes('data-ultra-abrir'), 'the served board carries the mode selector and the Ultra action');
    const { Script } = await import('node:vm');
    verificar([...pagina.matchAll(/<script>([\s\S]*?)<\/script>/g)].every((m) => { try { new Script(m[1]); return true; } catch { return false; } }), 'the served page scripts compile');
    verificar((await llamar('/api/ultra', { repo: 'r', numero: 1, confirmar: true })).status === 409, 'Ultra is refused while the mode is saving');
    const aceptada = await llamar('/api/ultra', { repo: 'r', numero: 1, confirmar: true, modo: 'ultra' });
    verificar(aceptada.status === 202, 'a confirmed Ultra request with another mode is accepted');
    let trabajo;
    for (let i = 0; i < 100 && trabajo?.estado !== 'terminado' && trabajo?.estado !== 'error'; i++) {
      await new Promise((ok) => setTimeout(ok, 50));
      trabajo = (await (await llamar('/api/estado')).json()).trabajos.find((t) => t.tipo === 'revisar_ultra');
    }
    verificar(trabajo?.estado === 'terminado', 'the Ultra job appears in /api/estado and finishes');
    verificar(leerUltra(p, 'r', 1, sha)?.hallazgos.length === 1, 'the Ultra review stores its result');
    const ultra = await (await llamar('/api/ultra?repo=r&numero=1')).json();
    verificar(ultra.resultado?.hallazgos?.length === 1 && ultra.estimacion.usd > 0, '/api/ultra returns the stored result and the estimate');
  } finally {
    if (configPrevia === undefined) delete process.env.SEKI_REVIEW_CONFIG; else process.env.SEKI_REVIEW_CONFIG = configPrevia;
    await detenerServidores();
    rmSync(dir, { recursive: true, force: true });
  }
}

// Review intake with a fake gh: one PR requested from the owner and one added with pr_revisar end up in the snapshot, not in deliveries.
if (!tool) {
  const { proyecto: cargarProyecto } = await import('../mcp/lib/config.mjs');
  const { recolectar } = await import('../mcp/lib/recolectar.mjs');
  const { leerJson, rutaEntregas } = await import('../mcp/lib/cache.mjs');
  const { falsoGhRutas, limpiarGhRutas } = await import('./util/gh-rutas.mjs');
  const { default: revisar } = await import('../mcp/tools/pr_revisar.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'seki-humo-revisar-'));
  const previo = { config: process.env.SEKI_REVIEW_CONFIG, gh: process.env.SEKI_GH };
  const verificar = (ok, texto) => { console.log(ok ? 'ok  ' : 'FAIL', texto); if (!ok) process.exitCode = 1; };
  try {
    const salida = join(dir, 'salida');
    mkdirSync(join(salida, 'datos'), { recursive: true });
    writeFileSync(join(dir, 'proyectos.json'), JSON.stringify({ humo: { owner: 'o', autor: 'yo', salida, repos: { r: { lineas: [{ portal: 'P', prod: 'main', pruebas: 'develop' }], inactivas: { viejo: 'retired' } } } } }));
    process.env.SEKI_REVIEW_CONFIG = join(dir, 'proyectos.json');
    const ahora = new Date().toISOString();
    const ghPr = (n, autor) => ({ number: n, title: `pr ${n}`, url: `u/${n}`, baseRefName: 'viejo', headRefName: `rama-${n}`, createdAt: ahora, updatedAt: ahora, additions: 1, deletions: 1, changedFiles: 1, isDraft: false, headRefOid: `sha${n}`, author: { login: autor }, reviewDecision: '', body: '', state: 'OPEN' });
    const gh = falsoGhRutas([
      { patron: '^pr list -R o/r .*--search user-review-requested:yo', json: [ghPr(10, 'ana')] },
      { patron: '^pr view 20 -R o/r --json state$', json: { state: 'OPEN', number: 20 } },
      { patron: '^pr view 20 -R o/r ', json: ghPr(20, 'beto') },
      { patron: '^pr list ', json: [] },
      { patron: '^api repos/o/r/pulls\\?base=', json: [] },
    ]);
    process.env.SEKI_GH = gh.ruta;
    const r = await revisar.handler({ proyecto: 'humo', enlace: 'https://github.com/o/r/pull/20' });
    verificar(r.id === 'r#20' && r.estado === 'agregada', 'pr_revisar adds a PR by link');
    const foto = await recolectar({ proyecto: 'humo' });
    const marcas = Object.fromEntries(foto.prs.map((x) => [x.id, x.paraRevisar]));
    verificar(marcas['r#10'] === 'solicitada' && marcas['r#20'] === 'enlace', 'the requested PR and the linked PR are in the snapshot under To review');
    verificar(foto.prs.every((x) => x.soloRevision), 'neither is treated as the owner\'s own PR');
    verificar(leerJson(rutaEntregas(cargarProyecto('humo').salida)).entregas.every((e) => !e.prs.some((id) => id === 'r#10' || id === 'r#20')), 'neither enters the deliveries');
  } finally {
    for (const [k, v] of [['SEKI_REVIEW_CONFIG', previo.config], ['SEKI_GH', previo.gh]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
    limpiarGhRutas();
    rmSync(dir, { recursive: true, force: true });
  }
}
