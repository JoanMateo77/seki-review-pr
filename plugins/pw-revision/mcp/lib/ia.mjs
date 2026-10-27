// Trabajos de IA que lanza el tablero: `claude -p` en modo mínimo (sin CLAUDE.md, memoria, skills ni MCP ajenos)
// y con el modelo según la dificultad. No afecta las sesiones normales de Claude Code.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rutaCostos } from './cache.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '../..');

export const TOPES = { responder: 0.5, explicar: 2, cambiar: 1.5 };
export const TURNOS = { responder: 4, explicar: 30, cambiar: 40 };

export const tope = (tipo) => Number(process.env[`PW_IA_TOPE_${tipo.toUpperCase()}`]) || TOPES[tipo];

export function elegirModelo({ tipo, pr, lineasSeleccionadas = 0 }) {
  const forzado = process.env[`PW_IA_MODELO_${tipo.toUpperCase()}`] ?? process.env.PW_IA_MODELO;
  if (forzado) return tipo === 'cambiar' && forzado === 'haiku' ? 'sonnet' : forzado;
  const grande = (pr.adiciones ?? 0) + (pr.eliminaciones ?? 0) > 1500;
  if (tipo !== 'responder' && (pr.seguridad || grande)) return 'opus';
  const esfuerzo = pr.explicacion?.esfuerzo ?? pr.esfuerzoTamano ?? 3;
  if (tipo === 'responder' && lineasSeleccionadas <= 40 && esfuerzo <= 2) return 'haiku';
  return 'sonnet';
}

const configMcp = () => JSON.stringify({ mcpServers: { 'pw-revision': { command: 'sh', args: [join(RAIZ, 'bin/servidor.sh')] } } });

export function argsClaude({ modelo, sistema, prompt, schema, tools = [], mcp = false, tope: usd, turnos, sesion, persistir = false }) {
  const args = ['-p', prompt, '--model', modelo, '--system-prompt', sistema,
    '--strict-mcp-config', '--tools', tools.join(','), '--disable-slash-commands', '--setting-sources', 'project',
    '--max-budget-usd', String(usd), '--max-turns', String(turnos), '--output-format', 'json'];
  if (mcp) args.push('--mcp-config', configMcp());
  const permitidas = [...(mcp ? ['mcp__pw-revision'] : []), ...tools];
  if (permitidas.length) args.push('--allowedTools', permitidas.join(' '));
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  if (!persistir) args.push('--no-session-persistence');
  if (sesion) args.push('--resume', sesion);
  return args;
}

const MOTIVOS = {
  error_max_budget_usd: 'Se alcanzó el tope de costo del trabajo',
  error_max_turns: 'Se alcanzó el límite de turnos del trabajo',
};

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

export function ejecutarClaude(args, { cwd, limiteMs = 10 * 60 * 1000 }) {
  return new Promise((resolver) => {
    const hijo = spawn(process.env.PW_CLAUDE ?? 'claude', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let salida = '';
    let errores = '';
    let vencido = false;
    hijo.stdout.on('data', (d) => { salida += d; });
    hijo.stderr.on('data', (d) => { errores += d; });
    const reloj = setTimeout(() => { vencido = true; hijo.kill('SIGTERM'); }, limiteMs);
    const cerrar = (codigo) => {
      clearTimeout(reloj);
      let r = null;
      try { r = JSON.parse(salida.trim().split('\n').pop()); } catch { /* salida no JSON */ }
      const conSchema = args.includes('--json-schema');
      const ok = codigo === 0 && !!r && !r.is_error && (!conSchema || r.structured_output !== undefined);
      let motivo = null;
      if (!ok) {
        motivo = vencido ? 'El trabajo superó el tiempo máximo'
          : MOTIVOS[r?.subtype]
          ?? (r && !r.is_error && conSchema ? 'La respuesta no llegó con el formato esperado' : null)
          ?? (r?.errors?.join(' ') || errores.trim() || r?.result || `claude terminó con código ${codigo}`).slice(0, 400);
      }
      resolver({
        ok,
        salida: r?.structured_output ?? null,
        texto: typeof r?.result === 'string' ? r.result : '',
        sesion: r?.session_id ?? null,
        modelo: Object.keys(r?.modelUsage ?? {})[0] ?? null,
        uso: uso(r),
        costo: r?.total_cost_usd ?? null,
        motivo,
      });
    };
    hijo.on('close', cerrar);
    hijo.on('error', (e) => { errores = e.message; cerrar(-1); });
  });
}

// Directorio sin CLAUDE.md para los trabajos que no necesitan una copia del repo.
export function dirVacio(p) {
  const dir = join(p.salida, '.ia-vacio');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const PROMPTS = join(RAIZ, 'mcp/prompts');
export const promptSistema = (...nombres) => nombres.map((n) => readFileSync(join(PROMPTS, `${n}.md`), 'utf8').trim()).join('\n\n');

export function registrarCosto(p, { fecha = new Date().toISOString(), ...datos }) {
  const ruta = rutaCostos(p.salida);
  mkdirSync(dirname(ruta), { recursive: true });
  appendFileSync(ruta, JSON.stringify({ fecha, ...datos }) + '\n');
}

export function costosDelDia(p, dia = new Date().toISOString().slice(0, 10)) {
  const ruta = rutaCostos(p.salida);
  const r = { total: 0, trabajos: 0 };
  if (!existsSync(ruta)) return r;
  for (const linea of readFileSync(ruta, 'utf8').split('\n')) {
    if (!linea) continue;
    const x = JSON.parse(linea);
    if (!x.fecha?.startsWith(dia)) continue;
    r.total += x.costo ?? 0;
    r.trabajos++;
  }
  return r;
}
