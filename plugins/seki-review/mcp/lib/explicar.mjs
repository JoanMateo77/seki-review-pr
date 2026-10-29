// Explicación de una PR lanzada desde el tablero. El servidor arma el contexto (descripción, verificaciones,
// diff) para que la IA no gaste turnos pidiéndolo. Lo que no cabe en el mensaje queda en disco, parche por parche, junto
// a una copia de solo lectura de la PR; la cobertura se mide por lo que la IA de verdad leyó.
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { escribirJson, leerJson, rutaExplicacion, rutaVerificacion } from './cache.mjs';
import { asegurarDiff } from './diffs.mjs';
import { contarHerramienta, fijarAvance, quitarAvance } from './avance.mjs';
import { crearCopia } from './copias.mjs';
import { argsClaude, dirVacio, ejecutarClaude, elegirModelo, reglasSecretos, registrarCosto, sistemaDe, tope, TURNOS } from './ia.mjs';
import { ghJson } from './proceso.mjs';

const MAX_LINEAS = 1500;

// Orden del cupo: primero lo que define el cambio, al final pruebas y documentación. Lo generado nunca entra.
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

// Qué parte del diff entra en el mensaje y qué queda para leer aparte. El cupo se reparte en dos rondas para que un
// archivo enorme no deje fuera a los demás: primero hasta POR_ARCHIVO líneas de cada uno, en orden de prioridad, y lo
// que sobre amplía los recortados.
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
    diffs.push(`### ${a.filename} (${a.status}, +${a.additions} −${a.deletions})\n${lineas.slice(0, tomar).join('\n')}${tomar < lineas.length ? `\n... (${lineas.length - tomar} líneas omitidas)` : ''}`);
  }
  return { diffs, sinDiff, recortados, generados, cobertura: { completa: !sinDiff.length && !recortados.length, archivos: archivos.length, sinDiff, recortados, generados } };
}

// Un parche por archivo, con la misma ruta, para que la IA abra los que no vinieron en el mensaje.
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
  try { real = realpathSync(d); } catch { /* aún no existe */ }
  return [...new Set([d, real])];
};

// Archivos de la PR que la IA abrió: su parche o el archivo en la copia de la PR.
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

// Cobertura final: lo que no vino entero en el mensaje cuenta como revisado solo si la IA lo leyó aparte.
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
  const enDisco = aparte.map((f) => `- ${f}${recortados.includes(f) ? ' (recortado en el mensaje)' : ''}${parches[f] ? `: ${parches[f]}` : ': sin parche (binario o muy grande)'}`);
  return [
    `PR ${pr.id} del proyecto ${proyecto}: "${pr.titulo}". ${pr.base} ← ${pr.rama}, +${pr.adiciones} −${pr.eliminaciones}.`,
    ...(previa ? [`## Explicación actual (completarla, no rehacerla)\n${JSON.stringify(previa, null, 1)}`] : []),
    `## Descripción\n${detalle?.body?.trim() || '(sin descripción)'}`,
    `## Commits\n${(detalle?.commits ?? []).map((c) => `- ${c.messageHeadline}`).join('\n') || '(sin datos)'}`,
    `## Verificaciones automáticas\n${hallazgos.join('\n') || 'Sin hallazgos.'}`,
    `## Diff${foco ? ' de los archivos que faltaban' : ''}\n${diffs.join('\n\n')}`,
    ...(aparte.length ? [`## Parches que no vinieron completos en el mensaje\nLeerlos con Read antes de explicar, primero los de código y esquema, luego pantallas; las pruebas solo para saber qué cubren. Lo que no se lea, decirlo en riesgos y no afirmar nada sobre esos archivos.\n${enDisco.join('\n')}`] : []),
    ...(generados.length ? [`## Archivos generados (no revisar)\n${generados.map((f) => `- ${f}`).join('\n')}`] : []),
    copia ? `El directorio actual es una copia de solo lectura de la PR en su commit: para ver un archivo completo o quién usa algo, Read y Grep ahí.` : '',
    previa
      ? `Guardar con pr_guardar_explicacion (proyecto "${proyecto}", repo "${pr.repo}", numero ${pr.numero}${pr.headSha ? `, headSha "${pr.headSha}"` : ''}) la explicación completa: conservar lo que sigue siendo cierto y sumar lo que muestran estos archivos (que_cambia, riesgos, orden_lectura, como_probar, dependencias). Responder "listo".`
      : `Guardar con pr_guardar_explicacion (proyecto "${proyecto}", repo "${pr.repo}", numero ${pr.numero}${pr.headSha ? `, headSha "${pr.headSha}"` : ''}), incluidos esfuerzo y orden_lectura, y diagrama solo si cambia un flujo. Responder "listo".`,
  ].filter(Boolean).join('\n\n');
}

// completar: analiza solo los archivos que la explicación vigente no revisó y la amplía.
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
// Vale la pena una segunda pasada si quedó sin ver algo que no es prueba ni documentación.
const faltaCodigo = (c) => faltantes(c).some((f) => prioridad(f) <= 2);

async function explicar(p, pr, clave, { completar }) {
  const [detalle, archivos] = await Promise.all([
    ghJson(['pr', 'view', String(pr.numero), '-R', `${p.owner}/${pr.repo}`, '--json', 'body,commits']).catch(() => null),
    asegurarDiff(p, pr.repo, pr.numero, pr.headSha),
  ]);
  const ruta = rutaExplicacion(p.salida, pr.repo, pr.numero);
  const vigente = () => { const e = leerJson(ruta); return e?.headSha === pr.headSha ? e : null; };
  // Sin checkout configurado no hay copia: la IA trabaja solo con el diff (mensaje y parches).
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
    const ok = r.ok && /listo/i.test(r.texto);
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
  // Si tras la primera pasada quedó código sin ver, se amplía una vez sola.
  if (res.ok && !completar && faltaCodigo(vigente()?.cobertura)) res = await pasada(vigente());
  const { ok, r } = res;
  return { ok, motivo: ok ? null : r.motivo ?? r.texto.slice(0, 400), costo, modelo: r.modelo ?? modelo, pasadas };
}
