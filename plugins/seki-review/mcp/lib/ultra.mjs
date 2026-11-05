// Ultra review of one PR: three read-only lenses (correctness, security, guidelines), structural drop of findings that
// cite code that does not exist, one verification call and the project checks. Always an explicit, confirmed job.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { escribirJson, leerJson, rutaUltra } from './cache.mjs';
import { comprobar } from './calidad.mjs';
import { expandir } from './config.mjs';
import { crearCopia } from './copias.mjs';
import { asegurarDiff } from './diffs.mjs';
import { argsClaude, ejecutarClaude, reglasSecretos, registrarCosto, sistemaDe } from './ia.mjs';
import { perfil } from './perfiles.mjs';
import { otrasRamas } from './preguntas.mjs';
import { lineamientos } from './propuestas.mjs';
import { paralelo as paraleloCola } from './trabajos.mjs';

const MAX_HALLAZGOS = 30;
const MAX_TITULO = 200;
const MAX_DETALLE = 2000;
const MAX_PARCHE = 60000;
const SEVERIDADES = new Set(['alta', 'media', 'baja']);
const VEREDICTOS = new Set(['CONFIRMED', 'PLAUSIBLE', 'REJECTED']);
const LENTES = ['correccion', 'seguridad', 'lineamientos'];
const MOTIVO_GENERICO = 'The job failed';
const MOTIVO_SIN_GUIAS = 'The project guidelines are not available';

const SCHEMA_LENTE = {
  type: 'object',
  properties: { hallazgos: { type: 'array', items: { type: 'object', properties: {
    archivo: { type: 'string' }, linea: { type: 'integer' }, severidad: { type: 'string', enum: ['alta', 'media', 'baja'] },
    titulo: { type: 'string' }, detalle: { type: 'string' },
  }, required: ['archivo', 'linea', 'severidad', 'titulo', 'detalle'] } } },
  required: ['hallazgos'],
};
const SCHEMA_VERIFICAR = {
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

// The cached diff holds GitHub patches without headers; the project checks parse a git diff.
export function parcheUnido(archivos) {
  return archivos.filter((a) => a.patch !== undefined).map((a) => {
    const origen = a.status === 'added' ? '/dev/null' : `a/${a.previous_filename ?? a.filename}`;
    const destino = a.status === 'removed' ? '/dev/null' : `b/${a.filename}`;
    return `diff --git a/${a.previous_filename ?? a.filename} b/${a.filename}\n--- ${origen}\n+++ ${destino}\n${a.patch}`;
  }).join('\n');
}

const texto = (v, max) => String(v ?? '').trim().slice(0, max);

function normalizar(lente, salida) {
  const lista = Array.isArray(salida?.hallazgos) ? salida.hallazgos.slice(0, MAX_HALLAZGOS) : [];
  return lista.map((h, i) => ({
    id: `${lente}-${i + 1}`, lente,
    archivo: texto(h?.archivo, 300), linea: Number.isInteger(h?.linea) ? h.linea : 0,
    severidad: SEVERIDADES.has(h?.severidad) ? h.severidad : 'media',
    titulo: texto(h?.titulo, MAX_TITULO), detalle: texto(h?.detalle, MAX_DETALLE),
  }));
}

// A finding survives only if its file exists inside the copy and its line is within the file.
function existeCita(dir, h) {
  if (!h.archivo || isAbsolute(h.archivo)) return 'The cited file does not exist in the copy';
  const raiz = realpathSync(dir);
  const ruta = resolve(raiz, h.archivo);
  let real;
  try { real = realpathSync(ruta); } catch { return 'The cited file does not exist in the copy'; }
  if (real !== raiz && !real.startsWith(raiz + sep)) return 'The cited file does not exist in the copy';
  if (!statSync(real).isFile()) return 'The cited file does not exist in the copy';
  if (!Number.isInteger(h.linea) || h.linea < 1) return 'The cited line is not valid';
  const lineas = readFileSync(real, 'utf8').split('\n');
  const total = lineas.at(-1) === '' ? lineas.length - 1 : lineas.length;
  return h.linea > total ? 'The cited line is beyond the end of the file' : null;
}

// n tasks with at most `limite` running at once.
async function enParalelo(tareas, limite) {
  const salida = new Array(tareas.length);
  let siguiente = 0;
  const trabajador = async () => { while (siguiente < tareas.length) { const i = siguiente++; salida[i] = await tareas[i](); } };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limite), tareas.length) }, trabajador));
  return salida;
}

const listaDeArchivos = (archivos) => archivos.map((a) => `- ${a.filename} (${a.status}, +${a.additions ?? 0} -${a.deletions ?? 0})`).join('\n') || '(no data)';

export async function revisarUltra(p, pr, {
  repetir = false, paralelo = paraleloCola(), ejecutar = ejecutarClaude, comprobarFn = comprobar,
  copiar = crearCopia, otras = otrasRamas, diff = asegurarDiff, guias = lineamientos,
} = {}) {
  const guardado = leerJson(rutaUltra(p.salida, pr.repo, pr.numero));
  if (!repetir && guardado?.headSha === pr.headSha) return { ok: true, motivo: null, costo: 0, modelo: null, resultado: guardado, desdeCache: true };

  const dir = await copiar(p, pr.repo, pr.numero, pr.headSha, { sufijo: '-lectura' });
  const { ambiente, lista } = await otras(p, pr).catch(() => ({ ambiente: 'pruebas', lista: [] }));
  const otros = lista.filter((o) => !o.falla);
  const archivos = await diff(p, pr.repo, pr.numero, pr.headSha);
  const patch = parcheUnido(archivos);
  const reglasGuia = guias(p);
  const dirGuias = reglasGuia && p.lineamientos ? expandir(p.lineamientos) : null;

  const repos = [`- ${pr.repo}: the current directory, at commit ${pr.headSha.slice(0, 7)} of PR #${pr.numero}.`,
    ...otros.map((o) => `- ${o.repo} (${o.portal}): ${o.dir}, ${ambiente === 'prod' ? 'production' : 'testing'} branch ${o.rama} at ${o.sha.slice(0, 7)}.`),
    ...lista.filter((o) => o.falla).map((o) => `- ${o.repo} (${o.portal}), branch ${o.rama}: unavailable.`)].join('\n');
  const contexto = [`PR #${pr.numero} of ${pr.repo}: ${pr.titulo ?? ''}`.trim(),
    `Available repositories (read-only):\n${repos}`,
    `Changed files:\n${listaDeArchivos(archivos)}`,
    `Diff${patch.length > MAX_PARCHE ? ' (truncated; read the rest in the copy)' : ''}:\n${patch.slice(0, MAX_PARCHE)}`].join('\n\n');

  const pasos = [];
  const registrar = (paso, r) => pasos.push({ paso, modelo: r.modelo ?? null, costo: r.costo ?? 0, ok: !!r.ok });
  const directorios = [...otros.map((o) => o.dir), ...(dirGuias ? [dirGuias] : [])];
  const prohibidas = reglasSecretos([dir, ...directorios], p.secretos);

  const llamar = async (tipo, prompt, sistema, schema, dirs) => {
    const f = perfil({ tipo, modo: 'ultra', pr });
    try {
      const r = await ejecutar(argsClaude({ modelo: f.modelo, sistema, prompt, schema, tools: ['Read', 'Grep', 'Glob'], tope: f.topeUsd, turnos: f.turnos, dirs, prohibidas }), { cwd: dir });
      return { ...r, modelo: r.modelo ?? f.modelo };
    } catch {
      return { ok: false, costo: 0, modelo: f.modelo, salida: null, motivoSeguro: MOTIVO_GENERICO };
    }
  };

  const lentes = await enParalelo(LENTES.map((nombre) => async () => {
    if (nombre === 'lineamientos' && !reglasGuia) return { nombre, ok: false, omitida: true, motivo: MOTIVO_SIN_GUIAS, costo: 0, hallazgos: [] };
    const extra = nombre === 'lineamientos' ? `\n\nProject guidelines:\n${reglasGuia}` : '';
    const r = await llamar('ultra_lente', `Lens: ${nombre}. Review this PR.\n\n${contexto}${extra}`, sistemaDe(p, 'base', `ultra-${nombre}`), SCHEMA_LENTE, directorios);
    registrar(nombre, r);
    const ok = !!r.ok && Array.isArray(r.salida?.hallazgos);
    return { nombre, ok, ...(ok ? {} : { motivo: r.motivoSeguro ?? MOTIVO_GENERICO }), costo: r.costo ?? 0, hallazgos: ok ? normalizar(nombre, r.salida) : [], modelo: r.modelo };
  }), paralelo);

  const descartadas = [];
  const candidatas = [];
  for (const h of lentes.flatMap((l) => l.hallazgos)) {
    const motivo = existeCita(dir, h);
    if (motivo) descartadas.push({ ...h, motivo }); else candidatas.push(h);
  }

  let motivoFallo = null;
  let veredictos = new Map();
  let verif = null;
  const algunaLente = lentes.some((l) => l.ok);
  if (!algunaLente) motivoFallo = lentes.find((l) => !l.omitida)?.motivo ?? MOTIVO_GENERICO;
  else if (candidatas.length) {
    const fichas = candidatas.map(({ id, lente, archivo, linea, severidad, titulo, detalle }) => ({ id, lente, archivo, linea, severidad, titulo, detalle }));
    verif = await llamar('ultra_verificar', `Verify these findings.\n\nAvailable repositories (read-only):\n${repos}\n\nFindings:\n${JSON.stringify(fichas, null, 1)}`, sistemaDe(p, 'base', 'ultra-verificar'), SCHEMA_VERIFICAR, directorios);
    registrar('verificar', verif);
    if (verif.ok && Array.isArray(verif.salida?.veredictos)) {
      veredictos = new Map(verif.salida.veredictos.filter((v) => VEREDICTOS.has(v?.veredicto)).map((v) => [v.id, { veredicto: v.veredicto, razon: texto(v.razon, 300) }]));
    } else motivoFallo = verif.motivoSeguro ?? MOTIVO_GENERICO;
  }

  const costo = pasos.reduce((s, x) => s + x.costo, 0);
  const modelo = pasos.find((x) => x.modelo)?.modelo ?? null;
  const ok = !motivoFallo;
  let resultado = null;
  if (ok) {
    const hallazgos = [];
    for (const h of candidatas) {
      const v = veredictos.get(h.id);
      if (v && v.veredicto !== 'REJECTED') hallazgos.push({ ...h, ...v });
      else descartadas.push({ ...h, motivo: v ? `Rejected by the verification: ${v.razon}` : 'The verification gave no verdict' });
    }
    let comprobacion = null;
    try { comprobacion = await comprobarFn(p, pr.repo, dir, patch, pr.headSha); } catch { comprobacion = { error: 'The project checks could not run' }; }
    resultado = {
      headSha: pr.headSha, fecha: new Date().toISOString(),
      lentes: lentes.map(({ nombre, ok: lok, omitida, motivo, costo: c, hallazgos: hs }) => ({ nombre, ok: lok, ...(omitida ? { omitida } : {}), ...(motivo ? { motivo } : {}), costo: c, hallazgos: hs.length })),
      hallazgos, descartadas, comprobacion,
    };
    escribirJson(rutaUltra(p.salida, pr.repo, pr.numero), resultado);
  }
  registrarCosto(p, { tipo: 'revisar_ultra', modo: 'ultra', prId: pr.id, modelo, costo, ok, ...(ok ? {} : { motivo: motivoFallo }), detalle: pasos });
  return { ok, motivo: motivoFallo, costo, modelo, resultado };
}
