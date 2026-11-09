// Template review of one PR: one read-only AI call per active template answers its items with quoted evidence, the
// quotes are checked against the code, deterministic items are decided by the fixed rules, one verification call
// judges the failures, and the result becomes Conventional Comments. Always an explicit, confirmed job.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { escribirJson, leerJson, rutaPlantillas } from './cache.mjs';
import { comentariosDePlantillas } from './comentarios-plantilla.mjs';
import { crearCopia } from './copias.mjs';
import { asegurarDiff } from './diffs.mjs';
import { commitsPr } from './estado.mjs';
import { argsClaude, ejecutarClaude, leerCostos, MOTIVO_FORMATO, reglasSecretos, registrarCosto, sistemaDe } from './ia.mjs';
import { estimarCosto, perfil, topeRevisarPlantillas } from './perfiles.mjs';
import { cargarPlantillas, DIR_BASE, itemsIa, seleccionarPlantillas } from './plantillas.mjs';
import { otrasRamas } from './preguntas.mjs';
import { enParalelo } from './proceso.mjs';
import { reglasDeConfig, reglasDelRepo } from './reglas.mjs';
import { buscarRutas, grepGit, rutasDelDiff } from './rutas-cruzadas.mjs';
import { paralelo as paraleloCola } from './trabajos.mjs';
import { contextoDeDiff, existeCita, SCHEMA_VERIFICAR } from './ultra.mjs';
import { verificar } from './verificar.mjs';

const ESTADOS = new Set(['cumple', 'falla', 'no_aplica', 'no_verificable']);
const VEREDICTOS = new Set(['CONFIRMED', 'PLAUSIBLE', 'REJECTED']);
const REGLA_RUTAS = 'rutas-en-otros-repos';
const REGLA_COMMITS = 'atribucion-ia';
const MAX_TITULO = 200;
const MAX_DETALLE = 2000;
const MAX_CITA = 300;
const MIN_CITA = 8;
const MAX_PEDIDO = 300;
const MOTIVO_GENERICO = 'The job failed';
const MOTIVO_CITA = 'The quote does not match the cited code';
const MOTIVO_OMITIDO = 'The review did not cover this item';
const MOTIVO_PLANTILLA = 'The template review failed';
const MOTIVO_SIN_PEDIDO = 'The review gave no question for the author';
const PEDIDO_REPOS = 'Check the other repositories by hand: they could not be loaded';
const PEDIDO_COMMITS = 'Check the commit messages by hand: they could not be read';

const SCHEMA_PLANTILLA = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, estado: { type: 'string', enum: [...ESTADOS] }, repo: { type: 'string' }, archivo: { type: 'string' }, linea: { type: 'integer' },
    cita: { type: 'string' }, titulo: { type: 'string' }, detalle: { type: 'string' }, pedido: { type: 'string' },
  }, required: ['id', 'estado', 'titulo', 'detalle'] } } },
  required: ['items'],
};

const texto = (v, max) => String(v ?? '').trim().slice(0, max);
const colapsar = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const redondear = (n) => Math.round(n * 1e6) / 1e6;

// Templates loaded once per change of their folders: the board asks often and an invalid file warns on every load.
const memo = new Map();
function firma(dir) {
  if (!dir || !existsSync(dir)) return null;
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.json')).sort().map((n) => {
      const st = statSync(join(dir, n));
      return [n, st.mtimeMs, st.size];
    });
  } catch { return 'ilegible'; }
}
export function plantillasDe(p, { dirBase = DIR_BASE } = {}) {
  const propias = typeof p?.plantillas === 'string' ? p.plantillas : null;
  const clave = JSON.stringify([dirBase, propias, firma(dirBase), firma(propias)]);
  if (!memo.has(clave)) {
    if (memo.size >= 8) memo.delete(memo.keys().next().value);
    memo.set(clave, cargarPlantillas(p, { dirBase }));
  }
  return memo.get(clave);
}

// Stored result; one for a newer commit is marked as outdated rather than discarded.
export function leerPlantillasPr(p, repo, numero, headSha) {
  const guardado = leerJson(rutaPlantillas(p.salida, repo, numero));
  if (!guardado) return null;
  return headSha && guardado.headSha !== headSha ? { ...guardado, desactualizada: true } : guardado;
}

const activasDe = (plantillas, seleccion) => seleccion.activas.map((a) => plantillas.find((t) => t.id === a.id)).filter(Boolean);

// What the board and the chat show before a template review: selection, broken files, estimate, cap and stored result.
export function datosPlantillas(p, pr, rutas = []) {
  const { plantillas, invalidas } = plantillasDe(p);
  const seleccion = seleccionarPlantillas(plantillas, rutas);
  const n = activasDe(plantillas, seleccion).filter((t) => itemsIa(t).length).length;
  const topeUsd = topeRevisarPlantillas(n);
  // The history is kept per run; a run's cost over its AI templates (one when a record has no count) is the sample.
  const porPlantilla = leerCostos(p).map((x) => (x?.tipo === 'revisar_plantillas' && Number.isInteger(x.plantillasIa) && x.plantillasIa > 1 ? { ...x, costo: x.costo / x.plantillasIa } : x));
  const { usd, base, muestras } = estimarCosto(porPlantilla, { tipo: 'revisar_plantillas', modo: 'normal', multiplicador: n, topeUsd });
  return { seleccion, invalidas, estimacion: { usd: n ? usd : 0, base, muestras }, topeUsd, resultado: leerPlantillasPr(p, pr.repo, pr.numero, pr.headSha) };
}

// The whitespace-collapsed quote (8 to 300 characters, not a lone brace) must be inside the collapsed lines
// linea-2 … linea+2 of a file inside a directory the AI could read: this PR's copy or a listed other repository.
function citaValida(raices, cuentas, x, repoPr) {
  const repo = typeof x.repo === 'string' && x.repo && x.repo !== repoPr ? x.repo : '';
  const archivo = texto(x.archivo, 300);
  const linea = Number.isInteger(x.linea) ? x.linea : 0;
  const cita = colapsar(x.cita);
  if (cita.length > MAX_CITA || cita.replace(/\s/g, '').length < MIN_CITA) return null;
  if (existeCita(raices, cuentas, { repo, archivo, linea })) return null;
  try {
    const lineas = readFileSync(realpathSync(resolve(realpathSync(raices.get(repo)), archivo)), 'utf8').split('\n');
    return colapsar(lineas.slice(Math.max(0, linea - 3), linea + 2).join('\n')).includes(cita) ? { ...(repo ? { repo } : {}), archivo, linea, cita } : null;
  } catch { return null; }
}

function itemIa(base, x, raices, cuentas, repoPr) {
  if (!x) return { ...base, estado: 'no_verificable', motivo: MOTIVO_OMITIDO };
  // An empty title is left out so the comment falls back to the question.
  const titulo = texto(x.titulo, MAX_TITULO);
  const conTexto = { ...base, ...(titulo ? { titulo } : {}), detalle: texto(x.detalle, MAX_DETALLE) };
  if (x.estado === 'no_aplica') return { ...conTexto, estado: 'no_aplica' };
  if (x.estado === 'no_verificable') {
    const pedido = texto(x.pedido, MAX_PEDIDO);
    return { ...conTexto, estado: 'no_verificable', ...(pedido ? { pedido } : { motivo: MOTIVO_SIN_PEDIDO }) };
  }
  const evidencia = citaValida(raices, cuentas, x, repoPr);
  if (!evidencia) return { ...conTexto, estado: 'no_verificable', motivo: MOTIVO_CITA };
  return { ...conTexto, estado: x.estado, ...evidencia, ...(x.estado === 'falla' ? { veredicto: null } : {}) };
}

// A deterministic item fails on any finding of its rules; the rules it names but the project does not run, and the
// sources that could not be read, make a clean result not verifiable instead of passing.
function itemDeterminista(base, item, { hallazgos, conocidas, reposListos, commitsListos }) {
  const hs = hallazgos.filter((h) => item.reglas.includes(h.regla));
  if (hs.length) return { ...base, estado: 'falla', archivo: hs[0].archivo, ...(hs[0].linea ? { linea: hs[0].linea } : {}), cita: hs[0].texto, titulo: hs[0].titulo, hallazgos: hs };
  const activas = item.reglas.filter((r) => conocidas.has(r));
  if (!activas.length) return { ...base, estado: 'no_verificable', motivo: `The rules ${item.reglas.join(', ')} are not available in this project` };
  if (activas.includes(REGLA_RUTAS) && !reposListos) return { ...base, estado: 'no_verificable', pedido: PEDIDO_REPOS };
  if (activas.includes(REGLA_COMMITS) && !commitsListos) return { ...base, estado: 'no_verificable', pedido: PEDIDO_COMMITS };
  return { ...base, estado: 'cumple', detalle: `No added line matches the rules ${activas.join(', ')}` };
}

export async function revisarPlantillas(p, pr, {
  repetir = false, paralelo = paraleloCola(), ejecutar = ejecutarClaude, copiar = crearCopia, otras = otrasRamas, diff = asegurarDiff,
  commits = (q, r) => commitsPr(q.owner, r.repo, r.numero), grep = grepGit, cargar = plantillasDe,
} = {}) {
  if (!pr?.headSha) throw new Error('The PR has no head commit');
  const guardado = leerPlantillasPr(p, pr.repo, pr.numero);
  if (!repetir && guardado?.headSha === pr.headSha) return { ok: true, motivo: null, costo: 0, modelo: null, resultado: guardado, desdeCache: true };
  const limite = Number.isInteger(paralelo) && paralelo >= 1 ? paralelo : 1;

  // Everything that can fail without spending comes first.
  const sistemas = { plantilla: sistemaDe(p, 'base', 'plantilla'), verificar: sistemaDe(p, 'base', 'ultra-verificar') };
  const archivos = await diff(p, pr.repo, pr.numero, pr.headSha);
  const { plantillas } = cargar(p);
  const seleccion = seleccionarPlantillas(plantillas, archivos.map((a) => a.filename));
  const activas = activasDe(plantillas, seleccion);
  const conIa = activas.filter((t) => itemsIa(t).length);
  const dir = conIa.length ? await copiar(p, pr.repo, pr.numero, pr.headSha, { sufijo: '-lectura' }) : null;
  const usa = (regla) => activas.some((t) => t.items.some((i) => i.reglas.includes(regla)));
  // The other repositories serve the AI (read and quoted) and the cross-repo route rule; nothing else needs them.
  let ambiente = 'pruebas';
  let lista = [];
  let reposListos = true;
  if (conIa.length || usa(REGLA_RUTAS)) {
    try { ({ ambiente, lista } = await otras(p, pr)); } catch { reposListos = false; }
  }
  const otros = lista.filter((o) => !o.falla);
  if (otros.length < lista.length) reposListos = false;

  // Deterministic part: the same fixed rules as pr_verificaciones on the whole diff, plus the cross-repo routes.
  let listaCommits = [];
  let commitsListos = true;
  if (usa(REGLA_COMMITS)) {
    try { listaCommits = await commits(p, pr); } catch { commitsListos = false; }
  }
  const extra = reglasDeConfig(p.reglas);
  const omitidas = p.repos?.[pr.repo]?.reglas_omitidas ?? [];
  const hallazgos = verificar({ repo: pr.repo, archivos, commits: listaCommits, omitidas, extra }).hallazgos;
  const conocidas = new Set([...reglasDelRepo(pr.repo, omitidas, extra).map((r) => r.id), REGLA_COMMITS, REGLA_RUTAS]);
  if (usa(REGLA_RUTAS)) {
    try { hallazgos.push(...await buscarRutas({ rutas: rutasDelDiff(archivos), otros, grep })); } catch { reposListos = false; }
  }
  const deterministas = { hallazgos, conocidas, reposListos, commitsListos };

  const repos = !lista.length && !reposListos ? 'Other repositories: unavailable.' : [
    ...otros.map((o) => `- ${o.repo} (${o.portal}): ${o.dir}, ${ambiente === 'prod' ? 'production' : 'testing'} branch ${o.rama} at ${String(o.sha ?? '').slice(0, 7)}.`),
    ...lista.filter((o) => o.falla).map((o) => `- ${o.repo} (${o.portal}), branch ${o.rama}: unavailable.`)].join('\n');
  const { archivos: listaArchivos, diff: textoDiff } = contextoDeDiff(archivos);
  const contexto = [`PR #${pr.numero} of ${pr.repo}: ${pr.titulo ?? ''}`.trim(),
    `Available repositories (read-only):\n- ${pr.repo}: the current directory, at commit ${pr.headSha.slice(0, 7)} of PR #${pr.numero}.\n${repos}`.trim(),
    `Changed files:\n${listaArchivos}`, `Diff:\n${textoDiff}`].join('\n\n');
  const dirsOtros = otros.map((o) => o.dir);
  const prohibidas = dir ? reglasSecretos([dir, ...dirsOtros], p.secretos) : [];
  const raices = new Map([['', dir], [pr.repo, dir], ...otros.map((o) => [o.repo, o.dir])]);
  const cuentas = new Map();

  const pasos = [];
  const llamar = async (paso, tipo, prompt, schema) => {
    const f = perfil({ tipo, modo: 'normal', pr });
    let r;
    try {
      r = await ejecutar(argsClaude({ modelo: f.modelo, sistema: sistemas[tipo === 'plantilla' ? 'plantilla' : 'verificar'], prompt, schema, tools: ['Read', 'Grep', 'Glob'], tope: f.topeUsd, turnos: f.turnos, dirs: dirsOtros, prohibidas }), { cwd: dir });
    } catch {
      r = { ok: false, costo: 0, salida: null, motivoSeguro: MOTIVO_GENERICO };
    }
    const modelo = r.modelo ?? f.modelo;
    pasos.push({ paso, verifica: tipo !== 'plantilla', modelo, costo: redondear(r.costo ?? 0), ok: !!r.ok });
    return { ...r, modelo };
  };
  const falla = (r, valido) => (r.ok && valido ? null : r.ok ? MOTIVO_FORMATO : r.motivoSeguro ?? MOTIVO_GENERICO);
  const aviso = (paso, motivo) => console.error(`[seki-review/plantillas] The ${paso} step failed: ${motivo}`);

  let ok = false;
  let motivoFallo = MOTIVO_GENERICO;
  let resultado = null;
  try {
    const respuestas = new Map(await enParalelo(conIa, limite, async (t) => {
      const fichas = itemsIa(t).map(({ id, pregunta, evidencia }) => ({ id, pregunta, evidencia }));
      const prompt = `Template: ${t.id} v${t.version}. Language: ${t.idioma}.\n\nItems:\n${JSON.stringify(fichas, null, 1)}\n\n${contexto}`;
      const r = await llamar(t.id, 'plantilla', prompt, SCHEMA_PLANTILLA);
      const motivo = falla(r, Array.isArray(r.salida?.items));
      if (motivo) aviso(t.id, motivo);
      return [t.id, { motivo, costo: redondear(r.costo ?? 0), items: motivo ? [] : r.salida.items }];
    }));

    const entradas = activas.map((t) => {
      const res = respuestas.get(t.id);
      const porId = new Map();
      for (const x of res?.items ?? []) if (x && ESTADOS.has(x.estado) && typeof x.id === 'string' && !porId.has(x.id)) porId.set(x.id, x);
      const items = t.items.map((i) => {
        const base = { id: i.id, pregunta: i.pregunta, siFalla: i.siFalla };
        if (i.reglas.length) return itemDeterminista({ ...base, origen: 'determinista' }, i, deterministas);
        if (res?.motivo) return { ...base, origen: 'ia', estado: 'no_verificable', motivo: MOTIVO_PLANTILLA };
        return itemIa({ ...base, origen: 'ia' }, porId.get(i.id), raices, cuentas, pr.repo);
      });
      return { id: t.id, version: t.version, titulo: t.titulo, idioma: t.idioma, ok: !res?.motivo, ...(res?.motivo ? { motivo: res.motivo } : {}), costo: res?.costo ?? 0, items };
    });

    motivoFallo = conIa.length > 0 && conIa.every((t) => respuestas.get(t.id).motivo) ? respuestas.get(conIa[0].id).motivo : null;
    let verificacion = null;
    const candidatas = entradas.flatMap((t) => t.items.filter((i) => i.estado === 'falla' && i.origen === 'ia').map((i) => ({ t, i })));
    if (!motivoFallo && candidatas.length) {
      const fichas = candidatas.map(({ t, i }) => ({ id: `${t.id}/${i.id}`, ...(i.repo ? { repo: i.repo } : {}), archivo: i.archivo, linea: i.linea, cita: i.cita, titulo: i.titulo, detalle: i.detalle }));
      const v = await llamar('verificar', 'ultra_verificar', `Verify these findings.\n\nAvailable repositories (read-only):\n- ${pr.repo}: the current directory.\n${repos}\n\nFindings:\n${JSON.stringify(fichas, null, 1)}`, SCHEMA_VERIFICAR);
      const motivo = falla(v, Array.isArray(v.salida?.veredictos));
      if (motivo) {
        aviso('verification', motivo);
        verificacion = 'fallida';
      } else {
        const veredictos = new Map();
        for (const x of v.salida.veredictos) {
          if (x && VEREDICTOS.has(x.veredicto) && typeof x.id === 'string' && !veredictos.has(x.id)) veredictos.set(x.id, { veredicto: x.veredicto, razon: texto(x.razon, 300) });
        }
        for (const { t, i } of candidatas) {
          const vd = veredictos.get(`${t.id}/${i.id}`);
          if (!vd) continue;
          if (vd.veredicto === 'REJECTED') Object.assign(i, { estado: 'no_verificable', veredicto: 'REJECTED', motivo: `Rejected by the verification: ${vd.razon}`, pedido: i.titulo || i.pregunta });
          else i.veredicto = vd.veredicto;
        }
      }
    }

    ok = !motivoFallo;
    if (ok) {
      const comentarios = comentariosDePlantillas({ plantillas: entradas });
      resultado = {
        headSha: pr.headSha, fecha: new Date().toISOString(), seleccion,
        ...(reposListos ? {} : { otrosRepos: 'no_disponibles' }), ...(verificacion ? { verificacion } : {}),
        plantillas: entradas, ...comentarios,
      };
      escribirJson(rutaPlantillas(p.salida, pr.repo, pr.numero), resultado);
    }
  } finally {
    // A run without AI calls spends nothing and is not a sample for the estimate.
    if (pasos.length) {
      // Template steps in template order, then the verification (a template may be called "verificar" too).
      const orden = (x) => (x.verifica ? conIa.length : conIa.findIndex((t) => t.id === x.paso));
      const detalle = [...pasos].sort((a, b) => orden(a) - orden(b)).map(({ paso, modelo, costo, ok: pok }) => ({ paso, modelo, costo, ok: pok }));
      registrarCosto(p, {
        tipo: 'revisar_plantillas', modo: 'normal', prId: pr.id, plantillasIa: conIa.length, modelo: detalle.find((x) => x.modelo)?.modelo ?? null,
        costo: redondear(detalle.reduce((s, x) => s + x.costo, 0)), ok, ...(ok ? {} : { motivo: motivoFallo ?? MOTIVO_GENERICO }), detalle,
      });
    }
  }
  const costo = redondear(pasos.reduce((s, x) => s + x.costo, 0));
  return { ok, motivo: ok ? null : motivoFallo, costo, modelo: pasos.find((x) => x.modelo)?.modelo ?? null, resultado };
}
