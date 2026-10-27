// Comprobaciones sin IA de una propuesta de cambio: reglas del proyecto sobre las líneas agregadas, tipos y tests
// relacionados. Los fallos que ya existían en el commit de la PR (baseline) no se atribuyen a la propuesta.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { leerJson, escribirJson, rutaBaseline } from './cache.mjs';
import { expandir } from './config.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reiniciarCopia } from './copias.mjs';
import { git } from './proceso.mjs';
import { archivosDeDiff, verificar } from './verificar.mjs';

const LIMITE_MS = 5 * 60 * 1000;
const MAX_SALIDA = 4000;

// Un comando de tipos o tests a la vez en toda la máquina: jest y tsc consumen mucha memoria.
let turno = Promise.resolve();
const enTurno = (fn) => { const t = turno.then(fn, fn); turno = t.catch(() => {}); return t; };

function correr(cmd, args, { cwd, env, limiteMs }) {
  return enTurno(() => new Promise((ok) => {
    const hijo = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let salida = '';
    let vencido = false;
    hijo.stdout.on('data', (d) => { salida += d; });
    hijo.stderr.on('data', (d) => { salida += d; });
    const reloj = setTimeout(() => { vencido = true; hijo.kill('SIGKILL'); }, limiteMs);
    const fin = (codigo) => { clearTimeout(reloj); ok({ codigo, salida, vencido }); };
    hijo.on('close', fin);
    hijo.on('error', (e) => { salida += e.message; fin(-1); });
  }));
}

// Sin números de línea: el mismo error se reconoce aunque el cambio desplace líneas.
export function fallosDe(salida) {
  const fallos = new Set();
  for (const l of salida.split('\n')) {
    const tsc = /^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/.exec(l.trim());
    if (tsc) fallos.add(`${tsc[1]}: ${tsc[2]}: ${tsc[3]}`);
    const jest = /^FAIL\s+(\S+)/.exec(l.trim());
    if (jest) fallos.add(`FAIL ${jest[1]}`);
  }
  return [...fallos];
}

const argsCon = (args, archivos) => args.flatMap((a) => (a === '<archivos>' ? archivos : [a]));

async function medir(cfg, clave, dir, archivos, limiteMs) {
  const args = cfg[clave];
  if (!args) return null;
  const r = await correr(expandir(cfg.node), argsCon(args, archivos), { cwd: dir, env: cfg.env ?? {}, limiteMs });
  return { ...r, fallos: fallosDe(r.salida) };
}

const claveArchivos = (archivos) => createHash('sha256').update([...archivos].sort().join('\n')).digest('hex').slice(0, 16);

// Corre los mismos comandos sobre la copia sin el cambio y guarda el resultado por commit. No usa git stash:
// la lista de stash es compartida con el checkout del usuario y sus worktrees.
async function baseline(p, repo, dir, headSha, patch, archivos, limiteMs) {
  const cfg = p.repos[repo].comprobar;
  const ruta = rutaBaseline(p.salida, repo, headSha);
  const guardado = leerJson(ruta, { tipos: undefined, tests: {} });
  const k = claveArchivos(archivos);
  const falta = { tipos: cfg.tipos && guardado.tipos === undefined, tests: cfg.tests && guardado.tests[k] === undefined };
  if (falta.tipos || falta.tests) {
    const tmp = mkdtempSync(join(tmpdir(), 'pw-base-'));
    const parche = join(tmp, 'cambio.diff');
    writeFileSync(parche, patch);
    await reiniciarCopia(dir, headSha);
    try {
      if (falta.tipos) { const r = await medir(cfg, 'tipos', dir, archivos, limiteMs); guardado.tipos = r.vencido ? null : r.fallos; }
      if (falta.tests) { const r = await medir(cfg, 'tests', dir, archivos, limiteMs); guardado.tests[k] = r.vencido ? null : r.fallos; }
    } finally {
      await git(dir, ['apply', '--whitespace=nowarn', parche]);
      rmSync(tmp, { recursive: true, force: true });
    }
    // Un baseline vencido no se guarda: puede salir bien la próxima vez.
    escribirJson(ruta, { tipos: guardado.tipos ?? undefined, tests: Object.fromEntries(Object.entries(guardado.tests).filter(([, v]) => v !== null)) });
  }
  return { tipos: guardado.tipos, tests: guardado.tests[k] };
}

function resultado(r, base) {
  if (!r) return null;
  if (r.vencido) return { ok: false, nuevosFallos: [], salida: 'Se superó el tiempo máximo de la comprobación.', omitido: 'tiempo' };
  const conocidos = new Set(base ?? []);
  const nuevosFallos = r.fallos.filter((f) => !conocidos.has(f));
  const sinFallosLegibles = r.codigo !== 0 && !r.fallos.length;
  return {
    ok: !nuevosFallos.length && !sinFallosLegibles,
    nuevosFallos: sinFallosLegibles ? [`El comando terminó con código ${r.codigo}`] : nuevosFallos,
    salida: r.salida.slice(-MAX_SALIDA),
    ...(base == null ? { sinBaseline: true } : {}),
  };
}

export async function comprobar(p, repo, dir, patch, headSha, { limiteMs = LIMITE_MS } = {}) {
  const archivos = archivosDeDiff(patch);
  const { hallazgos, resumen } = verificar({ repo, archivos });
  const reglas = { hallazgos, resumen, bloqueantes: resumen.bloqueante ?? 0 };
  const cfg = p.repos[repo].comprobar;
  if (!cfg) return { reglas, tipos: null, tests: null };
  const tocados = archivos.filter((a) => a.status !== 'removed').map((a) => a.filename);
  const tipos = await medir(cfg, 'tipos', dir, tocados, limiteMs);
  const tests = tocados.length ? await medir(cfg, 'tests', dir, tocados, limiteMs) : null;
  const hayFallos = tipos?.fallos.length || tests?.fallos.length || tipos?.codigo || tests?.codigo;
  const base = !hayFallos ? { tipos: [], tests: [] }
    : !patch.trim() ? { tipos: tipos?.fallos, tests: tests?.fallos }
    : await baseline(p, repo, dir, headSha, patch, tocados, limiteMs);
  return { reglas, tipos: resultado(tipos, base.tipos), tests: resultado(tests, base.tests) };
}
