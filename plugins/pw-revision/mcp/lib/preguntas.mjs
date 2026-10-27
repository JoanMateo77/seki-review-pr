// Respuestas de la IA a las preguntas sobre líneas. Todas las preguntas pendientes de una PR van en una sola
// llamada; una pregunta igual sobre el mismo commit y las mismas líneas se responde desde la caché.
import { createHash } from 'node:crypto';
import { escribirJson, leerJson, rutaRespuesta } from './cache.mjs';
import { actualizarComentario, leerComentarios, rescatarPendientes } from './comentarios.mjs';
import { contextoPreguntas } from './contexto.mjs';
import { argsClaude, dirVacio, ejecutarClaude, elegirModelo, promptSistema, registrarCosto, tope, TURNOS } from './ia.mjs';
import { ghJson } from './proceso.mjs';

const PENDIENTES = new Set(['borrador', 'en_cola', 'en_curso', 'error']);
const SCHEMA = {
  type: 'object',
  properties: { respuestas: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, texto: { type: 'string' } }, required: ['id', 'texto'] } } },
  required: ['respuestas'],
};

const clave = (pr, c) => createHash('sha256').update([pr.headSha, c.ambito ?? '', c.seccion ?? '', c.archivo, c.lado, c.desde, c.hasta, c.texto.trim()].join('|')).digest('hex').slice(0, 32);

const detallePr = (p, pr) => ghJson(['pr', 'view', String(pr.numero), '-R', `${p.owner}/${pr.repo}`, '--json', 'body']).catch(() => null);

export async function responderPreguntas(p, pr, ids, { contexto = contextoPreguntas, detalle = detallePr } = {}) {
  const pedidas = new Set(ids);
  const preguntas = leerComentarios(p, pr.repo, pr.numero).filter((c) => c.tipo === 'pregunta' && pedidas.has(c.id) && PENDIENTES.has(c.estado));
  const actualizar = (id, cambios) => actualizarComentario(p, pr.repo, pr.numero, id, cambios);
  const sinCache = [];
  for (const c of preguntas) {
    const guardada = leerJson(rutaRespuesta(p.salida, clave(pr, c)));
    if (guardada) actualizar(c.id, { estado: 'respondido', respuesta: guardada.texto, modelo: guardada.modelo, costo: 0, desdeCache: true, motivo: null });
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
  const ctx = await contexto(p, { ...pr, cuerpo }, sinCache);
  const r = await ejecutarClaude(argsClaude({
    modelo, sistema: promptSistema('base', 'responder'),
    prompt: `Responder ${sinCache.length === 1 ? 'la pregunta' : `las ${sinCache.length} preguntas`} (ids: ${sinCache.map((c) => c.id).join(', ')}).\n\n${ctx}`,
    schema: SCHEMA, tools: [], tope: tope('responder') * sinCache.length, turnos: TURNOS.responder,
  }), { cwd: dirVacio(p) });
  const usado = r.modelo ?? modelo;
  registrarCosto(p, { tipo: 'responder', prId: pr.id, modelo: usado, uso: r.uso, costo: r.costo, ok: r.ok, preguntas: sinCache.length });

  const respuestas = new Map((r.ok ? r.salida.respuestas : []).map((x) => [x.id, x.texto]));
  for (const c of sinCache) {
    const texto = respuestas.get(c.id);
    if (texto) {
      escribirJson(rutaRespuesta(p.salida, clave(pr, c)), { texto, modelo: usado, fecha: new Date().toISOString() });
      actualizar(c.id, { estado: 'respondido', respuesta: texto, modelo: usado, costo: r.costo, lote: sinCache.length, desdeCache: false });
    } else {
      actualizar(c.id, { estado: 'error', motivo: r.ok ? 'La IA no devolvió respuesta para esta pregunta' : r.motivo });
    }
  }
  return { ok: r.ok, motivo: r.motivo, costo: r.costo, modelo: usado };
}
