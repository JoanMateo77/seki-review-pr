// Respuestas de la IA a las preguntas sobre líneas. Todas las preguntas pendientes de una PR van en una sola
// llamada; una pregunta igual sobre el mismo commit y las mismas líneas se responde desde la caché.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { escribirJson, leerJson, rutaRespuesta } from './cache.mjs';
import { actualizarComentario, leerComentarios, rescatarPendientes } from './comentarios.mjs';
import { contextoPreguntas } from './contexto.mjs';
import { argsClaude, dirVacio, ejecutarClaude, elegirModelo, promptSistema, reglasSecretos, registrarCosto, tope, TURNOS } from './ia.mjs';
import { copiaDeRama, crearCopia, ramasEquivalentes } from './copias.mjs';
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

  for (const c of sinCache) actualizar(c.id, { estado: 'en_curso', motivo: null });
  try {
    return await responder(p, pr, sinCache, { contexto, detalle });
  } catch (e) {
    rescatarPendientes(p, pr.repo, pr.numero, sinCache.map((c) => c.id), { estado: 'error', motivo: String(e.message).slice(0, 400) });
    throw e;
  }
}

async function responder(p, pr, sinCache, { contexto, detalle }) {
  const actualizar = (id, cambios) => actualizarComentario(p, pr.repo, pr.numero, id, cambios);
  // Una pregunta sobre la PR entera pesa como todas sus líneas cambiadas.
  const lineas = Math.max(...sinCache.map((c) => (c.ambito === 'pr' ? (pr.adiciones ?? 0) + (pr.eliminaciones ?? 0) : c.hasta - c.desde + 1)));
  const modelo = elegirModelo({ tipo: 'responder', pr, lineasSeleccionadas: lineas });
  const cuerpo = (await detalle(p, pr))?.body;
  const ctx = await contexto(p, { ...pr, cuerpo }, sinCache, { todos: leerComentarios(p, pr.repo, pr.numero) });
  const r = await ejecutarClaude(argsClaude({
    modelo, sistema: promptSistema('base', 'responder'),
    prompt: `Responder ${sinCache.length === 1 ? 'la pregunta' : `las ${sinCache.length} preguntas`} (ids: ${sinCache.map((c) => c.id).join(', ')}).\n\n${ctx}`,
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
      actualizar(c.id, { estado: 'error', motivo: r.ok ? 'La IA no devolvió respuesta para esta pregunta' : r.motivo });
    }
  }
  return { ok: r.ok, motivo: r.motivo, costo: r.costo, modelo: usado };
}

const SCHEMA_INVESTIGAR = { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] };

// Copias de solo lectura de los otros repos en la rama equivalente; una rama que no se pudo traer se informa.
async function otrasRamas(p, pr) {
  const { ambiente, ramas } = ramasEquivalentes(p, pr);
  const lista = [];
  for (const r of ramas) {
    try { lista.push({ ...r, ...(await copiaDeRama(p, r.repo, r.rama)) }); } catch (e) { lista.push({ ...r, falla: String(e.stderr || e.message).trim().slice(0, 160) }); }
  }
  return { ambiente, lista };
}

// Archivos que la IA abrió y búsquedas que hizo, con el repo de cada uno, para guardarlos con la respuesta.
// raices: [{ repo, dir }], la primera es el directorio de trabajo (rutas relativas).
export function consultasDe(herramientas, raices) {
  const dirs = raices.flatMap((r) => {
    let real = r.dir;
    try { real = realpathSync(r.dir); } catch { /* ya no existe */ }
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

// Pregunta que necesita mirar el código: la IA busca y lee en una copia de solo lectura de la PR (aparte de la que
// usan los pedidos de cambio) y en los checkouts de los otros repos, sin acceso a archivos de secretos.
export async function investigarPregunta(p, pr, id, { contexto = contextoPreguntas, detalle = detallePr } = {}) {
  const todos = leerComentarios(p, pr.repo, pr.numero);
  const c = todos.find((x) => x.id === id && x.tipo === 'pregunta');
  if (!c) throw Object.assign(new Error('La pregunta no existe'), { codigo: 404 });
  const actualizar = (cambios) => actualizarComentario(p, pr.repo, pr.numero, id, cambios);
  actualizar({ estado: 'en_curso', motivo: null });
  try {
    const dir = await crearCopia(p, pr.repo, pr.numero, pr.headSha, { sufijo: '-lectura' });
    const { ambiente, lista } = await otrasRamas(p, pr);
    const otros = lista.filter((o) => !o.falla);
    const cuerpo = (await detalle(p, pr))?.body;
    const ctx = await contexto(p, { ...pr, cuerpo }, [c], { todos });
    const repos = [`- ${pr.repo}: el directorio actual, en el commit ${pr.headSha.slice(0, 7)} de la PR #${pr.numero}.`,
      ...otros.map((o) => `- ${o.repo} (${o.portal}): ${o.dir}, rama ${o.rama} de ${ambiente === 'prod' ? 'producción' : 'pruebas'} en ${o.sha.slice(0, 7)}, recién traída de GitHub.`),
      ...lista.filter((o) => o.falla).map((o) => `- ${o.repo} (${o.portal}), rama ${o.rama}: no disponible (${o.falla}).`)].join('\n');
    const modelo = elegirModelo({ tipo: 'investigar', pr });
    const r = await ejecutarClaude(argsClaude({
      modelo, sistema: promptSistema('base', 'investigar'),
      prompt: `Investigar en el código la pregunta ${c.id}. Al citar código de otro repo, decir de qué repo y rama es.\n\nRepositorios disponibles (solo lectura):\n${repos}\n\n${ctx}`,
      schema: SCHEMA_INVESTIGAR, tools: ['Read', 'Grep', 'Glob'], tope: tope('investigar'), turnos: TURNOS.investigar,
      dirs: otros.map((o) => o.dir), prohibidas: reglasSecretos([dir, ...otros.map((o) => o.dir)]), traza: true,
    }), { cwd: dir });
    const consultado = consultasDe(r.herramientas, [{ repo: pr.repo, dir }, ...otros.map((o) => ({ repo: o.portal && o.portal !== o.repo ? `${o.repo} (${o.portal})` : o.repo, dir: o.dir }))]);
    // Intentos que bloquearon los permisos (archivos de secretos, herramientas no habilitadas).
    const bloqueadas = r.denegadas.map((d) => ({ herramienta: d.nombre, ruta: String(d.entrada.file_path ?? d.entrada.path ?? d.entrada.pattern ?? '').slice(0, 200) }));
    const leido = [{ repo: pr.repo, rama: `PR #${pr.numero}`, sha: pr.headSha }, ...otros.map((o) => ({ repo: o.repo, portal: o.portal, rama: o.rama, sha: o.sha }))];
    const usado = r.modelo ?? modelo;
    registrarCosto(p, { tipo: 'investigar', prId: pr.id, comentario: id, modelo: usado, uso: r.uso, costo: r.costo, ok: r.ok, archivos: consultado.archivos.length, bloqueadas: bloqueadas.length });
    if (r.ok && r.salida?.texto) actualizar({ estado: 'respondido', respuesta: r.salida.texto, investigado: true, leido, consultado, bloqueadas: bloqueadas.length ? bloqueadas : undefined, necesitaCodigo: undefined, modelo: usado, costo: r.costo, lote: 1, desdeCache: false });
    else actualizar({ estado: 'error', motivo: r.ok ? 'La IA no devolvió respuesta' : r.motivo });
    return { ok: r.ok, motivo: r.motivo, costo: r.costo, modelo: usado };
  } catch (e) {
    rescatarPendientes(p, pr.repo, pr.numero, [id], { estado: 'error', motivo: String(e.message).slice(0, 400) });
    throw e;
  }
}
