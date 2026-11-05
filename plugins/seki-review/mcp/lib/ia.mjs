// AI jobs launched by the dashboard: `claude -p` in minimal mode (no CLAUDE.md, memory, skills or third-party MCP)
// and with the model chosen by difficulty. Does not affect regular Claude Code sessions.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rutaCostos } from './cache.mjs';
import { elegirModelo, PERFILES } from './perfiles.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '../..');

export { elegirModelo };

const TIPOS = ['responder', 'explicar', 'cambiar', 'investigar', 'filtrar'];
export const TOPES = Object.fromEntries(TIPOS.map((t) => [t, PERFILES.normal[t].topeUsd]));
export const TURNOS = Object.fromEntries(TIPOS.map((t) => [t, PERFILES.normal[t].turnos]));

// Files the AI cannot read in any directory opened to it; each project adds its own in `secretos`.
// Read rules also govern Grep and Glob; they use each directory's absolute path because relative ones only
// cover the working directory.
const SECRETOS = ['*.env', '.env*', '*.pem', '*.key', '*.p12', '*.pfx', '.npmrc', 'credentials*', 'secrets*', 'id_rsa*', 'id_ed25519*'];
export const reglasSecretos = (dirs, extra = []) => dirs.flatMap((d) => {
  let real = d;
  try { real = realpathSync(d); } catch { /* does not exist yet */ }
  return [...SECRETOS, ...extra].map((s) => `Read(/${real}/**/${s})`);
});

const ESCRITURA = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const configMcp = () => JSON.stringify({ mcpServers: { 'seki-review': { command: 'sh', args: [join(RAIZ, 'bin/servidor.sh')] } } });

// traza: stream-json output to know which tools the AI used; the last line is still the result.
export function argsClaude({ modelo, sistema, prompt, schema, tools = [], mcp = false, tope: usd, turnos, sesion, persistir = false, dirs = [], prohibidas = [], traza = false }) {
  const args = ['-p', prompt, '--model', modelo, '--system-prompt', sistema,
    '--strict-mcp-config', '--tools', tools.join(','), '--disable-slash-commands', '--setting-sources', '',
    '--max-budget-usd', String(usd), '--max-turns', String(turnos), '--output-format', traza ? 'stream-json' : 'json'];
  if (traza) args.push('--verbose');
  if (mcp) args.push('--mcp-config', configMcp());
  // Edit and Write in --allowedTools write to any path; acceptEdits only accepts inside the cwd.
  const edita = tools.some((t) => ESCRITURA.has(t));
  const permitidas = [...(mcp ? ['mcp__seki-review'] : []), ...tools.filter((t) => !ESCRITURA.has(t))];
  if (permitidas.length) args.push('--allowedTools', permitidas.join(' '));
  if (edita) args.push('--permission-mode', 'acceptEdits');
  for (const d of dirs) args.push('--add-dir', d);
  if (prohibidas.length) args.push('--disallowedTools', ...prohibidas);
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  if (!persistir) args.push('--no-session-persistence');
  if (sesion) args.push('--resume', sesion);
  return args;
}

const MOTIVOS = {
  error_max_budget_usd: 'The job reached its cost cap',
  error_max_turns: 'The job reached its turn limit',
};
const MOTIVO_TIEMPO = 'The job exceeded the maximum time';
const MOTIVO_FORMATO = 'The response did not arrive in the expected format';
const MOTIVO_SIN_CONFIRMAR = 'The AI did not confirm completion';
const MOTIVO_GENERICO = 'The job failed';
const SEGUROS = new Set([...Object.values(MOTIVOS), MOTIVO_TIEMPO, MOTIVO_FORMATO, MOTIVO_SIN_CONFIRMAR, MOTIVO_GENERICO]);
const SALIDA_CODIGO = /^claude exited with code -?\d+$/;

// Only classified reasons are persisted: model output and stderr can carry code or secrets.
export const motivoSeguro = (m) => (typeof m === 'string' && (SEGUROS.has(m) || SALIDA_CODIGO.test(m)) ? m : MOTIVO_GENERICO);
export { MOTIVO_FORMATO, MOTIVO_SIN_CONFIRMAR };

function uso(r) {
  const u = { entrada: 0, cacheCreada: 0, cacheLeida: 0, salida: 0 };
  for (const m of Object.values(r?.modelUsage ?? {})) {
    u.entrada += m.inputTokens ?? 0;
    u.cacheCreada += m.cacheCreationInputTokens ?? 0;
    u.cacheLeida += m.cacheReadInputTokens ?? 0;
    u.salida += m.outputTokens ?? 0;
  }
  return u;
}

// Tool calls from a stream-json output, in order.
export function herramientasUsadas(salida) {
  const usadas = [];
  for (const linea of salida.split('\n')) {
    if (!linea.includes('"tool_use"')) continue;
    let o;
    try { o = JSON.parse(linea); } catch { continue; }
    for (const c of o?.message?.content ?? []) if (c?.type === 'tool_use' && c.name !== 'StructuredOutput') usadas.push({ nombre: c.name, entrada: c.input ?? {} });
  }
  return usadas;
}

export function ejecutarClaude(args, { cwd, limiteMs = 10 * 60 * 1000, alUsar }) {
  return new Promise((resolver) => {
    const hijo = spawn(process.env.SEKI_CLAUDE ?? 'claude', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let salida = '';
    let pendiente = '';
    let errores = '';
    let vencido = false;
    hijo.stdout.on('data', (d) => {
      salida += d;
      if (!alUsar) return;
      // With stream-json each complete line is an event: each tool is reported as soon as the AI requests it.
      const lineas = (pendiente + d).split('\n');
      pendiente = lineas.pop();
      for (const h of herramientasUsadas(lineas.join('\n'))) { try { alUsar(h); } catch { /* progress reporting does not stop the job */ } }
    });
    hijo.stderr.on('data', (d) => { errores += d; });
    const reloj = setTimeout(() => { vencido = true; hijo.kill('SIGTERM'); }, limiteMs);
    const cerrar = (codigo) => {
      clearTimeout(reloj);
      let r = null;
      try { r = JSON.parse(salida.trim().split('\n').pop()); } catch { /* non-JSON output */ }
      const conSchema = args.includes('--json-schema');
      const ok = codigo === 0 && !!r && !r.is_error && (!conSchema || r.structured_output !== undefined);
      let motivo = null;
      let seguro = null;
      if (!ok) {
        seguro = vencido ? MOTIVO_TIEMPO
          : MOTIVOS[r?.subtype]
          ?? (r && !r.is_error && conSchema ? MOTIVO_FORMATO : null)
          ?? `claude exited with code ${codigo}`;
        motivo = vencido || MOTIVOS[r?.subtype] || (r && !r.is_error && conSchema) ? seguro
          : (r?.errors?.join(' ') || errores.trim() || r?.result || seguro).slice(0, 400);
      }
      resolver({
        ok,
        salida: r?.structured_output ?? null,
        texto: typeof r?.result === 'string' ? r.result : '',
        sesion: r?.session_id ?? null,
        modelo: Object.keys(r?.modelUsage ?? {})[0] ?? null,
        uso: uso(r),
        costo: r?.total_cost_usd ?? null,
        herramientas: args.includes('stream-json') ? herramientasUsadas(salida) : [],
        denegadas: (r?.permission_denials ?? []).map((d) => ({ nombre: d.tool_name, entrada: d.tool_input ?? {} })),
        motivo,
        motivoSeguro: seguro,
      });
    };
    hijo.on('close', cerrar);
    hijo.on('error', (e) => { errores = e.message; cerrar(-1); });
  });
}

// Directory without CLAUDE.md for jobs that do not need a copy of the repo.
export function dirVacio(p) {
  const dir = join(p.salida, '.ia-vacio');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const PROMPTS = join(RAIZ, 'mcp/prompts');
export const promptSistema = (...nombres) => nombres.map((n) => readFileSync(join(PROMPTS, `${n}.md`), 'utf8').trim()).join('\n\n');

// System prompt with the project context (stack, writing and code rules) from proyectos.json.
export const sistemaDe = (p, ...nombres) => [promptSistema(...nombres), ...(p?.contexto ? [`# Project context\n\n${p.contexto}`] : [])].join('\n\n');

// Failed jobs keep a short safe reason (already sanitised by ejecutarClaude), never prompt text.
export function registrarCosto(p, { fecha = new Date().toISOString(), ...datos }) {
  if (datos.motivo !== undefined) datos.motivo = datos.ok === false && datos.motivo ? motivoSeguro(datos.motivo) : undefined;
  const ruta = rutaCostos(p.salida);
  mkdirSync(dirname(ruta), { recursive: true });
  appendFileSync(ruta, JSON.stringify({ fecha, ...datos }) + '\n');
}

// Local calendar day (machine time zone) of an ISO date.
export function diaLocal(fecha) {
  const d = new Date(fecha);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function leerCostos(p) {
  const ruta = rutaCostos(p.salida);
  if (!existsSync(ruta)) return [];
  const registros = [];
  for (const linea of readFileSync(ruta, 'utf8').split('\n')) {
    try { const x = linea && JSON.parse(linea); if (x && typeof x === 'object') registros.push(x); } catch { /* unreadable line */ }
  }
  return registros;
}

export function costosDelDia(p, dia = diaLocal(Date.now())) {
  const r = { total: 0, trabajos: 0 };
  for (const x of leerCostos(p)) {
    if (diaLocal(x.fecha) !== dia || x.tipo === 'valoracion') continue;
    r.total += x.costo ?? 0;
    r.trabajos++;
  }
  return r;
}

const nombreCorto = (m) => (/opus/i.test(m) ? 'opus' : /haiku/i.test(m) ? 'haiku' : /sonnet/i.test(m) ? 'sonnet' : m || 'otro');

// Cost per model over the last days versus what the person marked as useful, to calibrate model choice
// with our own data. A repeated analysis of the same PR counts as a retry.
export function resumenCostos(p, { dias = 30, ahora = Date.now() } = {}) {
  const desde = new Date(ahora - dias * 86400000).toISOString();
  const modelos = {};
  const modos = {};
  const valoradas = new Map();
  const analizadas = new Set();
  let reintentos = 0;
  for (const x of leerCostos(p)) {
    if (!x || !(x.fecha >= desde)) continue;
    if (x.tipo === 'valoracion') { valoradas.set(x.comentario, x); continue; }
    const m = (modelos[nombreCorto(x.modelo)] ??= { trabajos: 0, fallidos: 0, costo: 0, utiles: 0, noUtiles: 0 });
    const mm = (modos[x.modo ?? 'normal'] ??= { trabajos: 0, fallidos: 0, costo: 0, utiles: 0, noUtiles: 0 });
    for (const t of [m, mm]) {
      t.trabajos++;
      if (x.ok === false) t.fallidos++;
      t.costo += x.costo ?? 0;
    }
    if (x.tipo === 'explicar') { if (analizadas.has(x.prId)) reintentos++; analizadas.add(x.prId); }
    if (x.reintento) reintentos++;
  }
  for (const v of valoradas.values()) {
    if (v.util === null) continue;
    const m = (modelos[nombreCorto(v.modelo)] ??= { trabajos: 0, fallidos: 0, costo: 0, utiles: 0, noUtiles: 0 });
    m[v.util ? 'utiles' : 'noUtiles']++;
    const mm = (modos[v.modo ?? 'normal'] ??= { trabajos: 0, fallidos: 0, costo: 0, utiles: 0, noUtiles: 0 });
    mm[v.util ? 'utiles' : 'noUtiles']++;
  }
  for (const m of [...Object.values(modelos), ...Object.values(modos)]) m.costoPorUtil = m.utiles ? m.costo / m.utiles : null;
  return { dias, modelos, modos, reintentos };
}
