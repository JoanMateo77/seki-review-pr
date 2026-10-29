// PR explanation launched from the dashboard. The server builds the context (description, checks,
// diff) so the AI does not spend turns asking for it. Whatever does not fit in the message stays on disk, patch by patch, next
// to a read-only copy of the PR; coverage is measured by what the AI actually read.
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { escribirJson, leerJson, rutaExplicacion, rutaVerificacion } from './cache.mjs';
import { asegurarDiff } from './diffs.mjs';
import { contarHerramienta, fijarAvance, quitarAvance } from './avance.mjs';
import { crearCopia } from './copias.mjs';
import { argsClaude, dirVacio, ejecutarClaude, elegirModelo, reglasSecretos, registrarCosto, sistemaDe, tope, TURNOS } from './ia.mjs';
import { ghJson } from './proceso.mjs';

const MAX_LINEAS = 1500;

// Budget order: first what defines the change, tests and documentation last. Generated files never go in.
const GENERADO = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|poetry\.lock|go\.sum)$|\.min\.(js|css)$|\.map$|\.snap$|(^|\/)(dist|build|vendor|coverage)\//;
const ESQUEMA = /(^|\/)(migrations?|db|sql)\/|\.sql$/i;
const PRUEBA = /(__tests__|(^|\/)tests?\/|\.spec\.|\.test\.|_test\.)/;
const DOC = /\.(md|txt|rst)$|(^|\/)docs?\//;
const VISTA = /(^|\/)(screens|views|pages|components|templates|public|styles)\/|\.(ejs|html|css|scss|tsx|jsx|vue|svelte)$/;
export function prioridad(archivo) {
  if (GENERADO.test(archivo)) return 9;
  if (PRUEBA.test(archivo)) return 3;
  if (DOC.test(archivo)) return 4;
  if (ESQUEMA.test(archivo)) return 0;
  if (VISTA.test(archivo)) return 2;
  return 1;
}

// Which part of the diff goes in the message and which is left to read separately. The budget is split in two rounds so a
// huge file does not crowd out the rest: first up to POR_ARCHIVO lines of each, in priority order, and whatever
// is left extends the truncated ones.
const POR_ARCHIVO = 300;
export function recortarDiff(archivos, max = MAX_LINEAS) {
  const generados = [];
  const candidatos = [];
  archivos.map((a, i) => ({ a, i, n: prioridad(a.filename) })).sort((x, y) => x.n - y.n || x.i - y.i).forEach(({ a, n }) => {
    if (n === 9) generados.push(a.filename);
    else candidatos.push({ a, lineas: a.patch?.split('\n') ?? [], tomar: 0 });
  });
  let restantes = max;
  for (const c of candidatos) {
    if (!c.lineas.length || restantes <= 0) continue;
    c.tomar = Math.min(c.lineas.length, POR_ARCHIVO, restantes);
    restantes -= c.tomar;
  }
  for (const c of candidatos) {
    if (restantes <= 0) break;
    if (!c.tomar || c.tomar >= c.lineas.length) continue;
    const mas = Math.min(c.lineas.length - c.tomar, restantes);
    c.tomar += mas;
    restantes -= mas;
  }
  const diffs = [];
  const sinDiff = [];
  const recortados = [];
  for (const { a, lineas, tomar } of candidatos) {
    if (!tomar) { sinDiff.push(a.filename); continue; }
    if (tomar < lineas.length) recortados.push(a.filename);
    diffs.push(`### ${a.filename} (${a.status}, +${a.additions} −${a.deletions})\n${lineas.slice(0, tomar).join('\n')}${tomar < lineas.length ? `\n... (${lineas.length - tomar} lines omitted)` : ''}`);
  }
  return { diffs, sinDiff, recortados, generados, cobertura: { completa: !sinDiff.length && !recortados.length, archivos: archivos.length, sinDiff, recortados, generados } };
}

// One patch per file, with the same path, so the AI can open the ones that were not in the message.
export function escribirParches(dir, archivos) {
  rmSync(dir, { recursive: true, force: true });
  const rutas = {};
  for (const a of archivos) {
    if (!a.patch) continue;
    const ruta = join(dir, `${a.filename}.patch`);
    mkdirSync(dirname(ruta), { recursive: true });
    writeFileSync(ruta, a.patch);
    rutas[a.filename] = ruta;
  }
  return rutas;
}

const formas = (d) => {
  let real = d;
  try { real = realpathSync(d); } catch { /* does not exist yet */ }
  return [...new Set([d, real])];
};

// PR files the AI opened: their patch or the file in the PR copy.
export function archivosLeidos(herramientas, { parches = {}, copia = null }) {
  const porParche = new Map();
  for (const [archivo, ruta] of Object.entries(parches)) for (const f of formas(ruta)) porParche.set(f, archivo);
  const raices = copia ? formas(copia) : [];
  const leidos = new Set();
  for (const { nombre, entrada } of herramientas) {
    const ruta = nombre === 'Read' ? entrada?.file_path : null;
    if (typeof ruta !== 'string') continue;
    if (porParche.has(ruta)) { leidos.add(porParche.get(ruta)); continue; }
    const raiz = raices.find((r) => ruta.startsWith(`${r}/`));
    if (raiz) leidos.add(ruta.slice(raiz.length + 1));
  }
  return leidos;
}

// Final coverage: what did not come in full in the message counts as reviewed only if the AI read it separately.
export function coberturaReal(base, leidos, previa = null) {
  const yaVistos = new Set(previa?.leidosAparte ?? []);
  const visto = (f) => leidos.has(f) || yaVistos.has(f);
  const sinDiff = base.sinDiff.filter((f) => !visto(f));
  const recortados = base.recortados.filter((f) => !visto(f));
  const leidosAparte = [...new Set([...yaVistos, ...[...base.sinDiff, ...base.recortados].filter((f) => leidos.has(f))])];
  return { completa: !sinDiff.length && !recortados.length, archivos: base.archivos, sinDiff, recortados, generados: base.generados ?? [], leidosAparte };
}

export function promptExplicar({ pr, proyecto, detalle, archivos, verificaciones, parches = {}, copia = null, previa = null, foco = null }) {
  const elegidos = foco ? archivos.filter((a) => foco.includes(a.filename)) : archivos;
  const { diffs, sinDiff, recortados, generados } = recortarDiff(elegidos);
  const hallazgos = (verificaciones?.hallazgos ?? []).map((h) => `- ${h.severidad} · ${h.titulo} · ${h.archivo}:${h.linea ?? '?'} · ${h.mensaje}`);
  const aparte = [...recortados, ...sinDiff];
  const enDisco = aparte.map((f) => `- ${f}${recortados.includes(f) ? ' (truncated in the message)' : ''}${parches[f] ? `: ${parches[f]}` : ': no patch (binary or too large)'}`);
  return [
    `PR ${pr.id} in project ${proyecto}: "${pr.titulo}". ${pr.base} ← ${pr.rama}, +${pr.adiciones} −${pr.eliminaciones}.`,
    ...(previa ? [`## Current explanation (complete it, do not redo it)\n${JSON.stringify(previa, null, 1)}`] : []),
    `## Description\n${detalle?.body?.trim() || '(no description)'}`,
    `## Commits\n${(detalle?.commits ?? []).map((c) => `- ${c.messageHeadline}`).join('\n') || '(no data)'}`,
    `## Automated checks\n${hallazgos.join('\n') || 'No findings.'}`,
    `## Diff${foco ? ' of the missing files' : ''}\n${diffs.join('\n\n')}`,
    ...(aparte.length ? [`## Patches that did not come in full in the message\nRead them with Read before explaining: code and schema first, then screens; tests only to learn what they cover. Whatever is not read, say so in riesgos and do not claim anything about those files.\n${enDisco.join('\n')}`] : []),
    ...(generados.length ? [`## Generated files (do not review)\n${generados.map((f) => `- ${f}`).join('\n')}`] : []),
    copia ? `The current directory is a read-only copy of the PR at its commit: to see a full file or who uses something, use Read and Grep there.` : '',
    previa
      ? `Save the full explanation with pr_guardar_explicacion (proyecto "${proyecto}", repo "${pr.repo}", numero ${pr.numero}${pr.headSha ? `, headSha "${pr.headSha}"` : ''}): keep what is still true and add what these files show (que_cambia, riesgos, orden_lectura, como_probar, dependencias). Reply "done".`
      : `Save with pr_guardar_explicacion (proyecto "${proyecto}", repo "${pr.repo}", numero ${pr.numero}${pr.headSha ? `, headSha "${pr.headSha}"` : ''}), including esfuerzo and orden_lectura, and diagrama only if a flow changes. Reply "done".`,
  ].filter(Boolean).join('\n\n');
}

// completar: analyzes only the files the current explanation did not review and extends it.
export async function explicarConIa(p, pr, { completar = false } = {}) {
  const clave = `pr:${pr.id}`;
  fijarAvance(clave, { fase: 'preparando' });
  try {
    return await explicar(p, pr, clave, { completar });
  } finally {
    quitarAvance(clave);
  }
}

const faltantes = (c) => [...(c?.sinDiff ?? []), ...(c?.recortados ?? [])];
// A second pass is worth it if something that is not a test or documentation was left unseen.
const faltaCodigo = (c) => faltantes(c).some((f) => prioridad(f) <= 2);

async function explicar(p, pr, clave, { completar }) {
  const [detalle, archivos] = await Promise.all([
    ghJson(['pr', 'view', String(pr.numero), '-R', `${p.owner}/${pr.repo}`, '--json', 'body,commits']).catch(() => null),
    asegurarDiff(p, pr.repo, pr.numero, pr.headSha),
  ]);
  const ruta = rutaExplicacion(p.salida, pr.repo, pr.numero);
  const vigente = () => { const e = leerJson(ruta); return e?.headSha === pr.headSha ? e : null; };
  // Without a configured checkout there is no copy: the AI works only with the diff (message and patches).
  const copia = await crearCopia(p, pr.repo, pr.numero, pr.headSha, { sufijo: '-lectura' }).catch(() => null);
  const dirParches = join(p.copias ?? join(p.salida, 'copias'), 'diffs', `${pr.repo}-${pr.numero}`);
  const parches = escribirParches(dirParches, archivos);
  const verificaciones = leerJson(rutaVerificacion(p.salida, pr.repo, pr.numero));
  const modelo = elegirModelo({ tipo: 'explicar', pr });
  let costo = 0;
  let pasadas = 0;

  const pasada = async (previa) => {
    const { cobertura: coberturaPrevia, repo: _r, numero: _n, headSha: _h, fecha: _f, desactualizada: _d, ...resto } = previa ?? {};
    const foco = previa ? faltantes(coberturaPrevia) : null;
    const base = recortarDiff(foco ? archivos.filter((a) => foco.includes(a.filename)) : archivos).cobertura;
    if (foco) base.archivos = archivos.length;
    fijarAvance(clave, { fase: previa ? 'completando' : 'leyendo' });
    const r = await ejecutarClaude(argsClaude({
      modelo, sistema: sistemaDe(p, 'base', 'explicar'),
      prompt: promptExplicar({ pr, proyecto: p.clave, detalle, archivos, verificaciones, parches, copia, previa: previa ? resto : null, foco }),
      tools: ['Read', 'Grep', 'Glob'], mcp: true, tope: tope('explicar'), turnos: TURNOS.explicar, traza: true,
      dirs: [dirParches], prohibidas: reglasSecretos(copia ? [copia] : [], p.secretos),
    }), { cwd: copia ?? dirVacio(p), alUsar: (h) => contarHerramienta(clave, h, [copia, dirParches].filter(Boolean)) });
    pasadas++;
    costo += r.costo ?? 0;
    const ok = r.ok && /\b(done|listo)\b/i.test(r.texto);
    registrarCosto(p, { tipo: 'explicar', prId: pr.id, modelo: r.modelo ?? modelo, uso: r.uso, costo: r.costo, ok, ...(previa ? { completar: true } : {}) });
    if (!ok) return { ok, r };
    const e = vigente();
    if (e) {
      const cobertura = coberturaReal(base, archivosLeidos(r.herramientas, { parches, copia }), previa ? coberturaPrevia : null);
      if (foco) cobertura.generados = recortarDiff(archivos).generados;
      escribirJson(ruta, { ...e, cobertura });
    }
    return { ok, r };
  };

  const previa = completar ? vigente() : null;
  let res = await pasada(previa?.cobertura && !previa.cobertura.completa ? previa : null);
  // If code was left unseen after the first pass, it is extended exactly once.
  if (res.ok && !completar && faltaCodigo(vigente()?.cobertura)) res = await pasada(vigente());
  const { ok, r } = res;
  return { ok, motivo: ok ? null : r.motivo ?? r.texto.slice(0, 400), costo, modelo: r.modelo ?? modelo, pasadas };
}
