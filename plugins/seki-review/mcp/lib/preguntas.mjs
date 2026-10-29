// AI answers to questions about lines. All pending questions of a PR go in a single
// call; an identical question on the same commit and the same lines is answered from the cache.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { escribirJson, leerJson, rutaRespuesta } from './cache.mjs';
import { actualizarComentario, leerComentarios, rescatarPendientes } from './comentarios.mjs';
import { contextoPreguntas } from './contexto.mjs';
import { argsClaude, dirVacio, ejecutarClaude, elegirModelo, reglasSecretos, registrarCosto, sistemaDe, tope, TURNOS } from './ia.mjs';
import { copiaDeRama, crearCopia, ramasEquivalentes } from './copias.mjs';
import { contarHerramienta, fijarAvance, quitarAvance } from './avance.mjs';
import { ghJson } from './proceso.mjs';

const PENDIENTES = new Set(['borrador', 'en_cola', 'en_curso', 'error']);
const SCHEMA = {
  type: 'object',
  properties: { respuestas: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, texto: { type: 'string' }, necesitaCodigo: { type: 'boolean' } }, required: ['id', 'texto'] } } },
  required: ['respuestas'],
};

const clave = (pr, c) => createHash('sha256').update([pr.headSha, c.ambito ?? '', c.seccion ?? '', c.citado ?? '', c.respondeA ?? '', c.archivo, c.lado, c.desde, c.hasta, c.texto.trim()].join('|')).digest('hex').slice(0, 32);

const detallePr = (p, pr) => ghJson(['pr', 'view', String(pr.numero), '-R', `${p.owner}/${pr.repo}`, '--json', 'body']).catch(() => null);

export async function responderPreguntas(p, pr, ids, { contexto = contextoPreguntas, detalle = detallePr } = {}) {
  const pedidas = new Set(ids);
  const preguntas = leerComentarios(p, pr.repo, pr.numero).filter((c) => c.tipo === 'pregunta' && pedidas.has(c.id) && PENDIENTES.has(c.estado));
  const actualizar = (id, cambios) => actualizarComentario(p, pr.repo, pr.numero, id, cambios);
  const sinCache = [];
  for (const c of preguntas) {
    const guardada = leerJson(rutaRespuesta(p.salida, clave(pr, c)));
    if (guardada) actualizar(c.id, { estado: 'respondido', respuesta: guardada.texto, necesitaCodigo: guardada.necesitaCodigo, modelo: guardada.modelo, costo: 0, desdeCache: true, motivo: null });
    else sinCache.push(c);
  }
  if (!sinCache.length) return { ok: true, costo: 0, modelo: null };

  for (const c of sinCache) { actualizar(c.id, { estado: 'en_curso', motivo: null }); fijarAvance(`c:${c.id}`, { fase: 'redactando' }); }
  try {
    return await responder(p, pr, sinCache, { contexto, detalle });
  } catch (e) {
    rescatarPendientes(p, pr.repo, pr.numero, sinCache.map((c) => c.id), { estado: 'error', motivo: String(e.message).slice(0, 400) });
    throw e;
  } finally {
    for (const c of sinCache) quitarAvance(`c:${c.id}`);
  }
}

async function responder(p, pr, sinCache, { contexto, detalle }) {
  const actualizar = (id, cambios) => actualizarComentario(p, pr.repo, pr.numero, id, cambios);
  // A question about the whole PR weighs as much as all its changed lines.
  const lineas = Math.max(...sinCache.map((c) => (c.ambito === 'pr' ? (pr.adiciones ?? 0) + (pr.eliminaciones ?? 0) : c.hasta - c.desde + 1)));
  const modelo = elegirModelo({ tipo: 'responder', pr, lineasSeleccionadas: lineas });
  const cuerpo = (await detalle(p, pr))?.body;
  const ctx = await contexto(p, { ...pr, cuerpo }, sinCache, { todos: leerComentarios(p, pr.repo, pr.numero) });
  const r = await ejecutarClaude(argsClaude({
    modelo, sistema: sistemaDe(p, 'base', 'responder'),
    prompt: `Answer ${sinCache.length === 1 ? 'the question' : `the ${sinCache.length} questions`} (ids: ${sinCache.map((c) => c.id).join(', ')}).\n\n${ctx}`,
    schema: SCHEMA, tools: [], tope: tope('responder') * sinCache.length, turnos: TURNOS.responder,
  }), { cwd: dirVacio(p) });
  const usado = r.modelo ?? modelo;
  registrarCosto(p, { tipo: 'responder', prId: pr.id, comentarios: sinCache.map((c) => c.id), modelo: usado, uso: r.uso, costo: r.costo, ok: r.ok, preguntas: sinCache.length });

  const respuestas = new Map((r.ok ? r.salida.respuestas : []).map((x) => [x.id, x]));
  for (const c of sinCache) {
    const { texto, necesitaCodigo } = respuestas.get(c.id) ?? {};
    if (texto) {
      const falta = necesitaCodigo === true ? true : undefined;
      escribirJson(rutaRespuesta(p.salida, clave(pr, c)), { texto, modelo: usado, necesitaCodigo: falta, fecha: new Date().toISOString() });
      actualizar(c.id, { estado: 'respondido', respuesta: texto, necesitaCodigo: falta, modelo: usado, costo: r.costo, lote: sinCache.length, desdeCache: false });
    } else {
      actualizar(c.id, { estado: 'error', motivo: r.ok ? 'The AI returned no answer for this question' : r.motivo });
    }
  }
  return { ok: r.ok, motivo: r.motivo, costo: r.costo, modelo: usado };
}

const SCHEMA_INVESTIGAR = { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] };

// Read-only copies of the other repos on the equivalent branch; a branch that could not be fetched is reported.
async function otrasRamas(p, pr) {
  const { ambiente, ramas } = ramasEquivalentes(p, pr);
  const lista = [];
  for (const r of ramas) {
    try { lista.push({ ...r, ...(await copiaDeRama(p, r.repo, r.rama)) }); } catch (e) { lista.push({ ...r, falla: String(e.stderr || e.message).trim().slice(0, 160) }); }
  }
  return { ambiente, lista };
}

// Files the AI opened and searches it ran, with the repo of each, to store them with the answer.
// raices: [{ repo, dir }], the first one is the working directory (relative paths).
export function consultasDe(herramientas, raices) {
  const dirs = raices.flatMap((r) => {
    let real = r.dir;
    try { real = realpathSync(r.dir); } catch { /* no longer exists */ }
    return [...new Set([r.dir, real])].map((d) => ({ repo: r.repo, d }));
  });
  const ubicar = (ruta = '') => {
    if (!ruta.startsWith('/')) return { repo: raices[0]?.repo ?? null, ruta };
    const r = dirs.find(({ d }) => ruta === d || ruta.startsWith(`${d}/`));
    return r ? { repo: r.repo, ruta: ruta.slice(r.d.length + 1) || '.' } : { repo: null, ruta };
  };
  const archivos = new Map();
  const busquedas = [];
  for (const { nombre, entrada } of herramientas) {
    if (nombre === 'Read' && typeof entrada.file_path === 'string') {
      const u = ubicar(entrada.file_path);
      const desde = Number.isInteger(entrada.offset) ? entrada.offset : undefined;
      const hasta = desde && Number.isInteger(entrada.limit) ? desde + entrada.limit - 1 : undefined;
      archivos.set(`${u.repo}|${u.ruta}|${desde ?? ''}`, { ...u, ...(desde ? { desde } : {}), ...(hasta ? { hasta } : {}) });
    } else if (nombre === 'Grep' || nombre === 'Glob') {
      busquedas.push({ herramienta: nombre, patron: String(entrada.pattern ?? '').slice(0, 120), ...(entrada.path ? ubicar(entrada.path) : {}) });
    }
  }
  return { archivos: [...archivos.values()].slice(0, 60), busquedas: busquedas.slice(0, 40) };
}

// Question that needs to look at the code: the AI searches and reads in a read-only copy of the PR (separate from the one
// used by change requests) and in the checkouts of the other repos, with no access to secret files.
export async function investigarPregunta(p, pr, id, { contexto = contextoPreguntas, detalle = detallePr } = {}) {
  const todos = leerComentarios(p, pr.repo, pr.numero);
  const c = todos.find((x) => x.id === id && x.tipo === 'pregunta');
  if (!c) throw Object.assign(new Error('The question does not exist'), { codigo: 404 });
  const actualizar = (cambios) => actualizarComentario(p, pr.repo, pr.numero, id, cambios);
  actualizar({ estado: 'en_curso', motivo: null });
  const clave = `c:${id}`;
  fijarAvance(clave, { fase: 'copias' });
  try {
    const dir = await crearCopia(p, pr.repo, pr.numero, pr.headSha, { sufijo: '-lectura' });
    const { ambiente, lista } = await otrasRamas(p, pr);
    const otros = lista.filter((o) => !o.falla);
    const cuerpo = (await detalle(p, pr))?.body;
    const ctx = await contexto(p, { ...pr, cuerpo }, [c], { todos });
    const repos = [`- ${pr.repo}: the current directory, at commit ${pr.headSha.slice(0, 7)} of PR #${pr.numero}.`,
      ...otros.map((o) => `- ${o.repo} (${o.portal}): ${o.dir}, ${ambiente === 'prod' ? 'production' : 'testing'} branch ${o.rama} at ${o.sha.slice(0, 7)}, freshly fetched from GitHub.`),
      ...lista.filter((o) => o.falla).map((o) => `- ${o.repo} (${o.portal}), branch ${o.rama}: unavailable (${o.falla}).`)].join('\n');
    const modelo = elegirModelo({ tipo: 'investigar', pr });
    fijarAvance(clave, { fase: 'leyendo', repos: 1 + otros.length });
    const r = await ejecutarClaude(argsClaude({
      modelo, sistema: sistemaDe(p, 'base', 'investigar'),
      prompt: `Investigate question ${c.id} in the code. When quoting code from another repo, say which repo and branch it is from.\n\nAvailable repositories (read-only):\n${repos}\n\n${ctx}`,
      schema: SCHEMA_INVESTIGAR, tools: ['Read', 'Grep', 'Glob'], tope: tope('investigar'), turnos: TURNOS.investigar,
      dirs: otros.map((o) => o.dir), prohibidas: reglasSecretos([dir, ...otros.map((o) => o.dir)], p.secretos), traza: true,
    }), { cwd: dir, alUsar: (h) => contarHerramienta(clave, h, [dir, ...otros.map((o) => o.dir)]) });
    const consultado = consultasDe(r.herramientas, [{ repo: pr.repo, dir }, ...otros.map((o) => ({ repo: o.portal && o.portal !== o.repo ? `${o.repo} (${o.portal})` : o.repo, dir: o.dir }))]);
    // Attempts blocked by permissions (secret files, tools not enabled).
    const bloqueadas = r.denegadas.map((d) => ({ herramienta: d.nombre, ruta: String(d.entrada.file_path ?? d.entrada.path ?? d.entrada.pattern ?? '').slice(0, 200) }));
    const leido = [{ repo: pr.repo, rama: `PR #${pr.numero}`, sha: pr.headSha }, ...otros.map((o) => ({ repo: o.repo, portal: o.portal, rama: o.rama, sha: o.sha }))];
    const usado = r.modelo ?? modelo;
    registrarCosto(p, { tipo: 'investigar', prId: pr.id, comentario: id, modelo: usado, uso: r.uso, costo: r.costo, ok: r.ok, archivos: consultado.archivos.length, bloqueadas: bloqueadas.length });
    if (r.ok && r.salida?.texto) actualizar({ estado: 'respondido', respuesta: r.salida.texto, investigado: true, leido, consultado, bloqueadas: bloqueadas.length ? bloqueadas : undefined, necesitaCodigo: undefined, modelo: usado, costo: r.costo, lote: 1, desdeCache: false });
    else actualizar({ estado: 'error', motivo: r.ok ? 'The AI returned no answer' : r.motivo });
    return { ok: r.ok, motivo: r.motivo, costo: r.costo, modelo: usado };
  } catch (e) {
    rescatarPendientes(p, pr.repo, pr.numero, [id], { estado: 'error', motivo: String(e.message).slice(0, 400) });
    throw e;
  } finally {
    quitarAvance(clave);
  }
}
