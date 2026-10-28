// Explicación de una PR lanzada desde el tablero. El servidor arma el contexto (descripción, verificaciones,
// diff) para que la IA no gaste turnos pidiéndolo y solo lea del checkout lo que falte.
import { escribirJson, leerJson, rutaExplicacion, rutaVerificacion } from './cache.mjs';
import { asegurarDiff } from './diffs.mjs';
import { argsClaude, dirVacio, ejecutarClaude, elegirModelo, registrarCosto, sistemaDe, tope, TURNOS } from './ia.mjs';
import { expandir } from './config.mjs';
import { ghJson } from './proceso.mjs';

const MAX_LINEAS = 1500;

// Qué parte del diff entra en el mensaje: los archivos sin diff y los recortados quedan registrados en la explicación.
export function recortarDiff(archivos, max = MAX_LINEAS) {
  let restantes = max;
  const diffs = [];
  const sinDiff = [];
  const recortados = [];
  for (const a of archivos) {
    const lineas = a.patch?.split('\n') ?? [];
    if (!lineas.length || restantes <= 0) { sinDiff.push(a.filename); continue; }
    const tomadas = lineas.slice(0, restantes);
    restantes -= tomadas.length;
    if (tomadas.length < lineas.length) recortados.push(a.filename);
    diffs.push(`### ${a.filename} (${a.status}, +${a.additions} −${a.deletions})\n${tomadas.join('\n')}${tomadas.length < lineas.length ? `\n... (${lineas.length - tomadas.length} líneas omitidas)` : ''}`);
  }
  return { diffs, sinDiff, cobertura: { completa: !sinDiff.length && !recortados.length, archivos: archivos.length, sinDiff, recortados } };
}

export function promptExplicar({ pr, proyecto, detalle, archivos, verificaciones, checkout }) {
  const { diffs, sinDiff, cobertura } = recortarDiff(archivos);
  const hallazgos = (verificaciones?.hallazgos ?? []).map((h) => `- ${h.severidad} · ${h.titulo} · ${h.archivo}:${h.linea ?? '?'} · ${h.mensaje}`);
  return [
    `PR ${pr.id} del proyecto ${proyecto}: "${pr.titulo}". ${pr.base} ← ${pr.rama}, +${pr.adiciones} −${pr.eliminaciones}.`,
    `## Descripción\n${detalle?.body?.trim() || '(sin descripción)'}`,
    `## Commits\n${(detalle?.commits ?? []).map((c) => `- ${c.messageHeadline}`).join('\n') || '(sin datos)'}`,
    `## Verificaciones automáticas\n${hallazgos.join('\n') || 'Sin hallazgos.'}`,
    `## Diff\n${diffs.join('\n\n')}`,
    ...(sinDiff.length ? [`## Archivos sin diff en el mensaje\n${sinDiff.map((f) => `- ${f}: sin diff en el mensaje`).join('\n')}`] : []),
    ...(cobertura.completa ? [] : [`## Cobertura parcial\nEl mensaje no trae el diff completo (${sinDiff.length} archivos sin diff, ${cobertura.recortados.length} recortados). Leer del checkout lo necesario para lo central; lo que no se revise, decirlo en riesgos y no afirmar nada sobre esos archivos.`]),
    `Checkout local del repo: ${checkout}. Puede estar parado en otra rama: para el código de la PR, el diff es la fuente.`,
    `Guardar con pr_guardar_explicacion (proyecto "${proyecto}", repo "${pr.repo}", numero ${pr.numero}), incluidos esfuerzo y orden_lectura, y diagrama solo si cambia un flujo. Responder "listo".`,
  ].join('\n\n');
}

export async function explicarConIa(p, pr) {
  const [detalle, archivos] = await Promise.all([
    ghJson(['pr', 'view', String(pr.numero), '-R', `${p.owner}/${pr.repo}`, '--json', 'body,commits']).catch(() => null),
    asegurarDiff(p, pr.repo, pr.numero, pr.headSha),
  ]);
  const { cobertura } = recortarDiff(archivos);
  const prompt = promptExplicar({
    pr, proyecto: p.clave, detalle, archivos,
    verificaciones: leerJson(rutaVerificacion(p.salida, pr.repo, pr.numero)),
    checkout: expandir(p.repos[pr.repo]?.checkout ?? ''),
  });
  const modelo = elegirModelo({ tipo: 'explicar', pr });
  const r = await ejecutarClaude(argsClaude({
    modelo, prompt, sistema: sistemaDe(p, 'base', 'explicar'),
    tools: ['Read', 'Grep', 'Glob'], mcp: true, tope: tope('explicar'), turnos: TURNOS.explicar,
  }), { cwd: dirVacio(p) });
  const ok = r.ok && /listo/i.test(r.texto);
  if (ok) {
    const ruta = rutaExplicacion(p.salida, pr.repo, pr.numero);
    const e = leerJson(ruta);
    if (e?.headSha === pr.headSha) escribirJson(ruta, { ...e, cobertura });
  }
  registrarCosto(p, { tipo: 'explicar', prId: pr.id, modelo: r.modelo ?? modelo, uso: r.uso, costo: r.costo, ok });
  return { ok, motivo: ok ? null : r.motivo ?? r.texto.slice(0, 400), costo: r.costo, modelo: r.modelo ?? modelo };
}
