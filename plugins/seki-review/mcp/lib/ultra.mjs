// Ultra review of one PR: three read-only lenses (correctness, security, guidelines), structural drop of findings that
// cite code that does not exist, one verification call and the project checks. Always an explicit, confirmed job.
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, resolve, sep } from 'node:path';
import { escribirJson, leerJson, rutaPlantillas, rutaUltra, rutaVerificacion } from './cache.mjs';
import { comprobar } from './calidad.mjs';
import { expandir } from './config.mjs';
import { aplicarDescartes, leerDescartes, MOTIVO_SIN_VEREDICTO, triablesOrdenados } from './descartes.mjs';
import { crearCopia, mergeBaseFresca, ramasEquivalentes, reiniciarCopia } from './copias.mjs';
import { asegurarDiff } from './diffs.mjs';
import { prioridad } from './explicar.mjs';
import { argsClaude, ejecutarClaude, leerCostos, MOTIVO_FORMATO, reglasSecretos, registrarCosto, sistemaDe } from './ia.mjs';
import { estimarCosto, perfil, sugerirUltra, topeRevisarUltra } from './perfiles.mjs';
import { cargarPlantillas, LENTES_ULTRA } from './plantillas.mjs';
import { otrasRamas } from './preguntas.mjs';
import { enParalelo, git } from './proceso.mjs';
import { lineamientos } from './propuestas.mjs';
import { fusionarTriaje } from './triaje.mjs';
import { paralelo as paraleloCola } from './trabajos.mjs';

const MAX_HALLAZGOS = 30;
// The check cards share the verification call with the lens findings.
const MAX_FICHAS_CHECKS = 15;
const SEVERIDAD_FICHA = { bloqueante: 'alta', alto: 'alta', medio: 'media' };
const VEREDICTO_TRIAJE = { CONFIRMED: 'real', PLAUSIBLE: 'dudoso', REJECTED: 'falso_positivo' };
const MOTIVO_SIN_VEREDICTO_LENTE = 'The verification gave no verdict';
const MAX_TITULO = 200;
const MAX_DETALLE = 2000;
const MAX_PARCHE = 60000;
const MAX_ARCHIVOS_LISTA = 300;
const MAX_BYTES_ARCHIVO = 2 * 1024 * 1024;
const SEVERIDADES = new Set(['alta', 'media', 'baja']);
const VEREDICTOS = new Set(['CONFIRMED', 'PLAUSIBLE', 'REJECTED']);
const LENTES = LENTES_ULTRA;
const MOTIVO_GENERICO = 'The job failed';
const MOTIVO_SIN_GUIAS = 'The project guidelines are not available';
const MOTIVO_CUBIERTA = 'Covered by the template review of this commit';
const MOTIVO_NO_EXISTE = 'The cited file does not exist';

const SCHEMA_LENTE = {
  type: 'object',
  properties: { hallazgos: { type: 'array', items: { type: 'object', properties: {
    repo: { type: 'string' }, archivo: { type: 'string' }, linea: { type: 'integer' }, severidad: { type: 'string', enum: ['alta', 'media', 'baja'] },
    titulo: { type: 'string' }, detalle: { type: 'string' },
  }, required: ['archivo', 'linea', 'severidad', 'titulo', 'detalle'] } } },
  required: ['hallazgos'],
};
export const SCHEMA_VERIFICAR = {
  type: 'object',
  properties: { veredictos: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, veredicto: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE', 'REJECTED'] }, razon: { type: 'string' },
  }, required: ['id', 'veredicto', 'razon'] } } },
  required: ['veredictos'],
};

// Stored result; one for a newer commit is marked as outdated rather than discarded.
export function leerUltra(p, repo, numero, headSha) {
  const guardado = leerJson(rutaUltra(p.salida, repo, numero));
  if (!guardado) return null;
  return headSha && guardado.headSha !== headSha ? { ...guardado, desactualizada: true } : guardado;
}

// Lenses that the stored template review of this very commit already covers (a template declares `cubre`). Read here and
// not through revision-plantillas.mjs, which imports this module. A result of the same commit counts even when other
// branches moved since; a template that failed does not cover anything.
export function lentesCubiertas(p, repo, numero, headSha) {
  const guardado = leerJson(rutaPlantillas(p.salida, repo, numero));
  if (!headSha || guardado?.headSha !== headSha || !Array.isArray(guardado.plantillas)) return [];
  const buenas = new Set(guardado.plantillas.filter((t) => t?.ok !== false).map((t) => t?.id));
  if (!buenas.size) return [];
  const cubiertas = new Set(cargarPlantillas(p).plantillas.filter((t) => buenas.has(t.id)).flatMap((t) => t.cubre));
  return LENTES.filter((l) => cubiertas.has(l));
}

// What the board and the chat show before an Ultra review: estimate and its base, whether it is suggested and the stored result.
// The cap and the estimate are those of the lenses that will run; a history median covers all three, hence the scale.
export function datosUltra(p, pr, archivos = []) {
  const cubiertas = lentesCubiertas(p, pr.repo, pr.numero, pr.headSha);
  const n = LENTES.length - cubiertas.length;
  const tope = topeRevisarUltra(n);
  const { usd, base, muestras } = estimarCosto(leerCostos(p), { tipo: 'revisar_ultra', modo: 'ultra', multiplicador: n / LENTES.length, topeUsd: tope });
  return { estimacion: { usd, base, muestras }, topeUsd: tope, lentesCubiertas: cubiertas, ...sugerirUltra(p, pr, archivos), resultado: leerUltra(p, pr.repo, pr.numero, pr.headSha) };
}

// The cached diff holds GitHub patches without headers or final newline; the checks parse and `git apply` a git diff.
export function parcheUnido(archivos) {
  return archivos.filter((a) => a.patch !== undefined).map((a) => {
    const origen = a.status === 'added' ? '/dev/null' : `a/${a.previous_filename ?? a.filename}`;
    const destino = a.status === 'removed' ? '/dev/null' : `b/${a.filename}`;
    return `diff --git a/${a.previous_filename ?? a.filename} b/${a.filename}\n--- ${origen}\n+++ ${destino}\n${a.patch}${a.patch.endsWith('\n') ? '' : '\n'}`;
  }).join('');
}

// File list capped, and diff cut at file boundaries in review priority order (generated files stay out).
export function contextoDeDiff(archivos) {
  const lista = archivos.slice(0, MAX_ARCHIVOS_LISTA).map((a) => `- ${a.filename} (${a.status}, +${a.additions ?? 0} -${a.deletions ?? 0})`);
  if (archivos.length > MAX_ARCHIVOS_LISTA) lista.push(`- and ${archivos.length - MAX_ARCHIVOS_LISTA} more`);
  const orden = archivos.map((a, i) => ({ a, i, n: prioridad(a.filename) })).filter((x) => x.n < 9 && x.a.patch !== undefined).sort((x, y) => x.n - y.n || x.i - y.i);
  let usado = 0;
  const incluidos = [];
  const fuera = [];
  for (const { a } of orden) {
    const trozo = parcheUnido([a]);
    if (usado + trozo.length > MAX_PARCHE) { fuera.push(a.filename); continue; }
    usado += trozo.length;
    incluidos.push(trozo);
  }
  const nota = fuera.length ? `\n\nNot included in this message (read them in the copy): ${fuera.slice(0, MAX_ARCHIVOS_LISTA).join(', ')}${fuera.length > MAX_ARCHIVOS_LISTA ? ` and ${fuera.length - MAX_ARCHIVOS_LISTA} more` : ''}` : '';
  return { archivos: lista.join('\n') || '(no data)', diff: incluidos.join('\n') + nota };
}

const texto = (v, max) => String(v ?? '').trim().slice(0, max);
const redondear = (n) => Math.round(n * 1e6) / 1e6;

function normalizar(lente, salida) {
  const lista = Array.isArray(salida?.hallazgos) ? salida.hallazgos.slice(0, MAX_HALLAZGOS) : [];
  return lista.map((h, i) => ({
    id: `${lente}-${i + 1}`, lente,
    ...(h?.repo ? { repo: texto(h.repo, 100) } : {}),
    archivo: texto(h?.archivo, 300), linea: Number.isInteger(h?.linea) ? h.linea : 0,
    severidad: SEVERIDADES.has(h?.severidad) ? h.severidad : 'media',
    titulo: texto(h?.titulo, MAX_TITULO), detalle: texto(h?.detalle, MAX_DETALLE),
  }));
}

// A finding survives only if its file exists inside a directory the AI was given and its line is within the file.
export function existeCita(raices, cuentas, h) {
  try {
    const base = raices.get(h.repo ?? '');
    if (!base) return 'The cited repository is not available';
    if (!h.archivo || isAbsolute(h.archivo)) return MOTIVO_NO_EXISTE;
    const raiz = realpathSync(base);
    const real = realpathSync(resolve(raiz, h.archivo));
    if (real !== raiz && !real.startsWith(raiz + sep)) return MOTIVO_NO_EXISTE;
    const st = statSync(real);
    if (!st.isFile()) return MOTIVO_NO_EXISTE;
    if (st.size > MAX_BYTES_ARCHIVO) return 'The cited file is too large to verify';
    if (!Number.isInteger(h.linea) || h.linea < 1) return 'The cited line is not valid';
    if (!cuentas.has(real)) {
      const lineas = readFileSync(real, 'utf8').split('\n');
      cuentas.set(real, lineas.at(-1) === '' ? lineas.length - 1 : lineas.length);
    }
    return h.linea > cuentas.get(real) ? 'The cited line is beyond the end of the file' : null;
  } catch {
    return MOTIVO_NO_EXISTE;
  }
}

// Checks run on a dedicated copy at the merge-base with the PR patch applied, so the baseline works as in change
// proposals. The patch comes from git itself (binary files, renames and large files included). Without a merge-base
// (or if the patch does not apply) they run on the PR commit and are not compared.
async function copiaDeComprobacion(p, pr, patchCache, dirLectura) {
  if (!p.repos[pr.repo]?.comprobar) return { dir: dirLectura, baseSha: pr.headSha };
  let base = null;
  try { base = await mergeBaseFresca(p, pr.repo, pr.numero, pr.headSha, pr.base); } catch { /* no merge-base */ }
  if (base) {
    const tmp = mkdtempSync(join(tmpdir(), 'seki-ultra-'));
    try {
      const dir = await crearCopia(p, pr.repo, pr.numero, base, { sufijo: '-ultra' });
      // A copy kept from a previous run still has that run's patch applied.
      await reiniciarCopia(dir, base);
      const patch = await git(dir, ['diff', '--binary', '--no-color', '--no-ext-diff', base, pr.headSha]);
      if (patch.trim()) {
        const archivo = join(tmp, 'cambio.diff');
        writeFileSync(archivo, patch);
        await git(dir, ['apply', '--whitespace=nowarn', archivo]);
        return { dir, baseSha: base, patch };
      }
    } catch { /* falls back to the PR commit */ } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  return { dir: await crearCopia(p, pr.repo, pr.numero, pr.headSha, { sufijo: '-ultra' }), baseSha: null };
}

// Open findings of the checks of this commit; none when they belong to another commit. The board passes the snapshot
// PR, which carries them; the file the MCP tool stores is read only for a PR object without checks. Dismissals are
// read again here: a person may dismiss findings while the job waits in the queue.
function checksGuardados(p, pr) {
  const fuente = pr.verificaciones ?? leerJson(rutaVerificacion(p.salida, pr.repo, pr.numero));
  if (!fuente || fuente.headSha !== pr.headSha) return [];
  return aplicarDescartes(fuente, leerDescartes(p, pr.repo, pr.numero)).hallazgos;
}

const lineaCheck = (h) => `- ${h.severidad} · ${h.titulo} (${h.regla}) · ${h.archivo}${h.linea ? `:${h.linea}` : ''} · ${h.texto}`;

export async function revisarUltra(p, pr, {
  repetir = false, paralelo = paraleloCola(), ejecutar = ejecutarClaude, comprobarFn = comprobar,
  copiar = crearCopia, otras = otrasRamas, diff = asegurarDiff, guias = lineamientos, copiarComprobacion = copiaDeComprobacion,
  checks = checksGuardados,
} = {}) {
  if (!pr?.headSha) throw new Error('The PR has no head commit');
  const guardado = leerUltra(p, pr.repo, pr.numero);
  if (!repetir && guardado?.headSha === pr.headSha) return { ok: true, motivo: null, costo: 0, modelo: null, resultado: guardado, desdeCache: true };
  const limite = Number.isInteger(paralelo) && paralelo >= 1 ? paralelo : 1;

  // Everything that can fail without spending comes first.
  const sistemas = Object.fromEntries([...LENTES, 'verificar'].map((n) => [n, sistemaDe(p, 'base', `ultra-${n}`)]));
  const dir = await copiar(p, pr.repo, pr.numero, pr.headSha, { sufijo: '-lectura' });
  let ambiente;
  try { ambiente = ramasEquivalentes(p, pr).ambiente; } catch { ambiente = 'pruebas'; }
  let lista = [];
  let otrosRepos = 'disponibles';
  try { ({ ambiente, lista } = await otras(p, pr)); } catch { otrosRepos = 'no_disponibles'; }
  const otros = lista.filter((o) => !o.falla);
  const archivos = await diff(p, pr.repo, pr.numero, pr.headSha);
  const abiertosChecks = await checks(p, pr);
  const hallazgosChecks = triablesOrdenados(abiertosChecks);
  // Only the most severe get a card; the rest keep no verdict, so the standalone triage can still judge them.
  const verificadosChecks = triablesOrdenados(abiertosChecks, MAX_FICHAS_CHECKS);
  const seccionChecks = hallazgosChecks.length ? `\n\nFixed-rule findings (unverified patterns):\n${hallazgosChecks.map(lineaCheck).join('\n')}` : '';
  const patch = parcheUnido(archivos);
  const cubiertas = lentesCubiertas(p, pr.repo, pr.numero, pr.headSha);
  const reglasGuia = guias(p);
  const dirGuias = reglasGuia && p.lineamientos ? expandir(p.lineamientos) : null;

  const repos = otrosRepos === 'no_disponibles' ? 'Other repositories: unavailable.' : [
    ...otros.map((o) => `- ${o.repo} (${o.portal}): ${o.dir}, ${ambiente === 'prod' ? 'production' : 'testing'} branch ${o.rama} at ${o.sha.slice(0, 7)}.`),
    ...lista.filter((o) => o.falla).map((o) => `- ${o.repo} (${o.portal}), branch ${o.rama}: unavailable.`)].join('\n');
  const { archivos: listaArchivos, diff: textoDiff } = contextoDeDiff(archivos);
  const contexto = [`PR #${pr.numero} of ${pr.repo}: ${pr.titulo ?? ''}`.trim(),
    `Available repositories (read-only):\n- ${pr.repo}: the current directory, at commit ${pr.headSha.slice(0, 7)} of PR #${pr.numero}.\n${repos}`.trim(),
    `Changed files:\n${listaArchivos}`, `Diff:\n${textoDiff}`].join('\n\n');

  const raices = new Map([['', dir], [pr.repo, dir], ...otros.map((o) => [o.repo, o.dir])]);
  const dirsOtros = otros.map((o) => o.dir);
  const prohibidas = reglasSecretos([dir, ...dirsOtros, ...(dirGuias ? [dirGuias] : [])], p.secretos);

  const pasos = [];
  const llamar = async (paso, tipo, prompt, schema, dirs) => {
    const f = perfil({ tipo, modo: 'ultra', pr });
    let r;
    try {
      r = await ejecutar(argsClaude({ modelo: f.modelo, sistema: sistemas[paso], prompt, schema, tools: ['Read', 'Grep', 'Glob'], tope: f.topeUsd, turnos: f.turnos, dirs, prohibidas }), { cwd: dir });
    } catch {
      r = { ok: false, costo: 0, salida: null, motivoSeguro: MOTIVO_GENERICO };
    }
    const modelo = r.modelo ?? f.modelo;
    pasos.push({ paso, modelo, costo: redondear(r.costo ?? 0), ok: !!r.ok });
    return { ...r, modelo };
  };
  const falla = (r, valido) => (r.ok && valido ? null : r.ok ? MOTIVO_FORMATO : r.motivoSeguro ?? MOTIVO_GENERICO);
  const aviso = (paso, motivo) => console.error(`[seki-review/ultra] The ${paso} step failed: ${motivo}`);

  let ok = false;
  let motivoFallo = MOTIVO_GENERICO;
  let resultado = null;
  try {
    const lentes = await enParalelo(LENTES, limite, async (nombre) => {
      if (cubiertas.includes(nombre)) return { nombre, ok: false, omitida: true, motivo: MOTIVO_CUBIERTA, costo: 0, hallazgos: [] };
      if (nombre === 'lineamientos' && !reglasGuia) return { nombre, ok: false, omitida: true, motivo: MOTIVO_SIN_GUIAS, costo: 0, hallazgos: [] };
      const extra = nombre === 'lineamientos' ? `\n\nProject guidelines:\n${reglasGuia}` : seccionChecks;
      const r = await llamar(nombre, 'ultra_lente', `Lens: ${nombre}. Review this PR.\n\n${contexto}${extra}`, SCHEMA_LENTE, nombre === 'lineamientos' && dirGuias ? [...dirsOtros, dirGuias] : dirsOtros);
      const motivo = falla(r, Array.isArray(r.salida?.hallazgos));
      if (motivo) aviso(nombre, motivo);
      return { nombre, ok: !motivo, ...(motivo ? { motivo } : {}), costo: redondear(r.costo ?? 0), hallazgos: motivo ? [] : normalizar(nombre, r.salida) };
    });

    const descartadas = [];
    const candidatas = [];
    const cuentas = new Map();
    for (const h of lentes.flatMap((l) => l.hallazgos)) {
      const motivo = existeCita(raices, cuentas, h);
      if (motivo) descartadas.push({ ...h, motivo }); else candidatas.push(h);
    }

    let veredictos = new Map();
    let modeloVerificar = null;
    motivoFallo = null;
    if (!lentes.some((l) => l.ok)) motivoFallo = lentes.find((l) => !l.omitida)?.motivo ?? MOTIVO_GENERICO;
    else if (candidatas.length || verificadosChecks.length) {
      const fichasChecks = verificadosChecks.map((h) => ({ id: `check-${h.huella}`, lente: 'checks', archivo: h.archivo, linea: h.linea, severidad: SEVERIDAD_FICHA[h.severidad], titulo: h.titulo, detalle: texto(`${h.texto}\n${h.mensaje}`, MAX_DETALLE) }));
      const fichas = [...candidatas.map(({ id, lente, repo, archivo, linea, severidad, titulo, detalle }) => ({ id, lente, ...(repo ? { repo } : {}), archivo, linea, severidad, titulo, detalle })), ...fichasChecks];
      const v = await llamar('verificar', 'ultra_verificar', `Verify these findings.\n\nAvailable repositories (read-only):\n- ${pr.repo}: the current directory.\n${repos}\n\nFindings:\n${JSON.stringify(fichas, null, 1)}`, SCHEMA_VERIFICAR, dirsOtros);
      motivoFallo = falla(v, Array.isArray(v.salida?.veredictos));
      if (motivoFallo) aviso('verification', motivoFallo);
      else {
        modeloVerificar = v.modelo;
        for (const x of v.salida.veredictos) {
          if (x && VEREDICTOS.has(x.veredicto) && typeof x.id === 'string' && !veredictos.has(x.id)) veredictos.set(x.id, { veredicto: x.veredicto, razon: texto(x.razon, 300) });
        }
      }
    }

    ok = !motivoFallo;
    if (ok) {
      if (verificadosChecks.length) {
        // Same guard as the standalone triage: a rejection without a reason never hides a finding.
        fusionarTriaje(p, pr, { modelo: modeloVerificar, modo: 'ultra', costo: 0, veredictos: verificadosChecks.map((h) => {
          const v = veredictos.get(`check-${h.huella}`);
          if (!v) return { huella: h.huella, veredicto: 'dudoso', razon: MOTIVO_SIN_VEREDICTO };
          return { huella: h.huella, veredicto: v.veredicto === 'REJECTED' && !v.razon ? 'dudoso' : VEREDICTO_TRIAJE[v.veredicto], razon: v.razon };
        }) });
      }
      const hallazgos = [];
      for (const h of candidatas) {
        const v = veredictos.get(h.id);
        if (v && v.veredicto !== 'REJECTED') hallazgos.push({ ...h, ...v });
        else descartadas.push({ ...h, motivo: v ? `Rejected by the verification: ${v.razon}` : MOTIVO_SIN_VEREDICTO_LENTE });
      }
      let comprobacion;
      try {
        const c = await copiarComprobacion(p, pr, patch, dir);
        comprobacion = await comprobarFn(p, pr.repo, c.dir, c.patch ?? patch, c.baseSha ?? pr.headSha, c.baseSha ? {} : { sinBaseline: true });
        if (!c.baseSha) comprobacion = { ...comprobacion, sinBaseline: true };
      } catch { comprobacion = { error: 'The project checks could not run' }; }
      resultado = {
        headSha: pr.headSha, fecha: new Date().toISOString(),
        ...(otrosRepos === 'no_disponibles' ? { otrosRepos } : {}),
        lentes: lentes.map(({ nombre, ok: lok, omitida, motivo, costo, hallazgos: hs }) => ({ nombre, ok: lok, ...(omitida ? { omitida } : {}), ...(motivo ? { motivo } : {}), costo, hallazgos: hs.length })),
        hallazgos, descartadas, comprobacion,
      };
      escribirJson(rutaUltra(p.salida, pr.repo, pr.numero), resultado);
    }
  } finally {
    const detalle = [...LENTES, 'verificar'].flatMap((n) => pasos.filter((x) => x.paso === n));
    registrarCosto(p, {
      tipo: 'revisar_ultra', modo: 'ultra', prId: pr.id, modelo: detalle.find((x) => x.modelo)?.modelo ?? null,
      costo: redondear(detalle.reduce((s, x) => s + x.costo, 0)), ok, ...(ok ? {} : { motivo: motivoFallo ?? MOTIVO_GENERICO }), detalle,
    });
  }
  const costo = redondear(pasos.reduce((s, x) => s + x.costo, 0));
  return { ok, motivo: ok ? null : motivoFallo, costo, modelo: pasos.find((x) => x.modelo)?.modelo ?? null, resultado };
}
