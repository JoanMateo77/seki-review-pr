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
srv.kill();

// Board with an AI mode and a daily budget, served on a free port; an Ultra review with fake dependencies stores its result.
// Skipped when a tool was requested on the command line.
if (!tool) {
  const { proyecto: cargarProyecto } = await import('../mcp/lib/config.mjs');
  const { detenerServidores, iniciarServidor } = await import('../mcp/lib/servidor-web.mjs');
  const { leerUltra, revisarUltra } = await import('../mcp/lib/ultra.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'seki-humo-'));
  try {
    const salida = join(dir, 'salida');
    mkdirSync(join(salida, 'datos'), { recursive: true });
    const copia = join(dir, 'copia');
    mkdirSync(join(copia, 'src'), { recursive: true });
    writeFileSync(join(copia, 'src/a.ts'), 'l1\nl2\nl3\n');
    writeFileSync(join(dir, 'proyectos.json'), JSON.stringify({ humo: { owner: 'o', salida, repos: { r: { lineas: [{ portal: 'P', prod: 'main', pruebas: 'develop' }] } }, ia: { modo: 'ahorro', presupuestoDiarioUsd: 5 } } }));
    process.env.SEKI_REVIEW_CONFIG = join(dir, 'proyectos.json');
    const sha = 'a'.repeat(40);
    const pr = { id: 'r#1', repo: 'r', numero: 1, titulo: 'Change', url: 'https://example.test/r/1', base: 'main', rama: 'f', portal: 'P', ambiente: 'prod', estadoPr: 'OPEN', headSha: sha, creada: new Date().toISOString(), body: '' };
    escribirJson(rutaInstantanea(salida), { proyecto: 'humo', generado: new Date().toISOString(), owner: 'o', prs: [pr], recientes: [] });
    const { url } = await iniciarServidor({ proyecto: 'humo', puerto: 0, abrir: false });
    const u = new URL(url);
    const llamar = (ruta, cuerpo) => fetch(`${u.origin}${ruta}`, { method: cuerpo ? 'POST' : 'GET', headers: { 'x-seki-token': u.searchParams.get('t'), 'content-type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    const estadoApi = await (await llamar('/api/estado')).json();
    const pagina = await (await fetch(url)).text();
    const verificar = (ok, texto) => { console.log(ok ? 'ok  ' : 'FAIL', texto); if (!ok) process.exitCode = 1; };
    verificar(estadoApi.presupuesto?.limite === 5 && estadoApi.modo === 'ahorro', '/api/estado exposes the budget and the project mode');
    verificar(pagina.includes('id="selModo"') && pagina.includes('data-ultra-abrir'), 'the served board carries the mode selector and the Ultra action');
    verificar((await llamar('/api/ultra', { repo: 'r', numero: 1 })).status === 409, 'Ultra is refused while the mode is saving');
    const fake = async (args) => (/^Lens: /.test(args[args.indexOf('-p') + 1])
      ? { ok: true, costo: 0.1, modelo: 'claude-sonnet-5-5', salida: { hallazgos: [{ archivo: 'src/a.ts', linea: 2, severidad: 'alta', titulo: 'Problem', detalle: 'Evidence.' }] } }
      : { ok: true, costo: 0.1, modelo: 'claude-sonnet-5-5', salida: { veredictos: [{ id: 'correccion-1', veredicto: 'CONFIRMED', razon: 'Seen in src/a.ts:2' }] } });
    const p = cargarProyecto('humo');
    const r = await revisarUltra(p, pr, {
      ejecutar: fake, copiar: async () => copia, otras: async () => ({ ambiente: 'pruebas', lista: [] }), diff: async () => [{ filename: 'src/a.ts', status: 'modified', patch: '@@ -1 +1,2 @@\n l1\n+l2' }],
      guias: () => 'RULES', copiarComprobacion: async () => ({ dir: copia, baseSha: sha }), comprobarFn: async () => ({ reglas: { hallazgos: [], resumen: {}, bloqueantes: 0 }, tipos: null, tests: null }), paralelo: 1,
    });
    verificar(r.ok && leerUltra(p, 'r', 1, sha)?.hallazgos.length === 1, 'an Ultra review with a fake runner stores its result');
    const ultra = await (await llamar('/api/ultra?repo=r&numero=1')).json();
    verificar(ultra.resultado?.hallazgos?.length === 1 && ultra.estimacion.usd > 0, '/api/ultra returns the stored result and the estimate');
  } finally {
    await detenerServidores();
    rmSync(dir, { recursive: true, force: true });
  }
}
