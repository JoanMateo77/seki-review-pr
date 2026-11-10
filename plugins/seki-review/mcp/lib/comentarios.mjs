// Comments on diff lines, stored per PR. The browser creates and edits drafts and notes; the other
// states (queued, answered, proposal...) are set by the server and the browser cannot revert them.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { leerJson, escribirJson, rutaComentarios } from './cache.mjs';
import { huellaHallazgo } from './descartes.mjs';

const TIPOS = new Set(['pregunta', 'cambio', 'nota']);
const DEL_NAVEGADOR = new Set(['borrador', 'nota']);
const MAX_TEXTO = 4000;
const MAX_SUGERIDO = 20000;
const LADOS = new Set(['nuevo', 'viejo', 'mixto']);
// Explanation sections that can be asked about or expanded on request.
export const SECCIONES = {
  resumen: 'What it solves', por_que: 'Why', impacto_usuario: 'What users notice', que_cambia: 'What changes',
  orden_lectura: 'Reading order', diagrama: 'Flow', tecnologias: 'Technologies', alternativas: 'Alternatives considered',
  dependencias: 'Must go first', riesgos: 'Risks', como_probar: 'How to test',
};
const PENDIENTES = new Set(['en_cola', 'en_curso']);
// A check fix can be requested again when its request failed or its proposal was discarded.
const REINTENTABLES = new Set(['error', 'descartado']);
// A fix approved on an earlier commit no longer blocks: the push moved the head and the line may be flagged again.
export const bloqueaArreglo = (c, huella, headSha) => c.tipo === 'cambio' && c.origenCheck?.huella === huella
  && !REINTENTABLES.has(c.estado) && !(c.estado === 'aprobado' && c.headSha !== headSha);
// What the browser may write; answer, cost, proposal and the rest are set only by the server.
const CAMPOS = ['id', 'tipo', 'estado', 'ambito', 'seccion', 'citado', 'citadoDe', 'respondeA', 'investigar', 'archivo', 'lado', 'desde', 'hasta', 'claves', 'textoOriginal', 'texto', 'sugerido', 'headSha', 'creado', 'actualizado'];

// Last write per PR, so the dashboard knows when to reload without reading every file.
const marcas = new Map();
export const marcasComentarios = () => Object.fromEntries(marcas);

function escribir(p, repo, numero, lista) {
  escribirJson(rutaComentarios(p.salida, repo, numero), lista);
  marcas.set(`${repo}#${numero}`, new Date().toISOString());
}

export const leerComentarios = (p, repo, numero) => leerJson(rutaComentarios(p.salida, repo, numero), []);

function validar(c) {
  if (typeof c?.id !== 'string' || !/^c-[a-z0-9]{4,32}$/.test(c.id)) throw new Error('Comment without a valid id');
  if (!TIPOS.has(c.tipo)) throw new Error(`Comment ${c.id}: unknown type "${c.tipo}"`);
  if (typeof c.texto !== 'string' || c.texto.length > MAX_TEXTO) throw new Error(`Comment ${c.id}: text empty or longer than ${MAX_TEXTO} characters`);
  if (c.sugerido !== undefined && (typeof c.sugerido !== 'string' || c.sugerido.length > MAX_SUGERIDO)) throw new Error(`Comment ${c.id}: suggested code longer than ${MAX_SUGERIDO} characters`);
  if (!DEL_NAVEGADOR.has(c.estado)) throw new Error(`Comment ${c.id}: state not allowed`);
  if (c.headSha !== undefined && (typeof c.headSha !== 'string' || !/^[0-9a-z]{0,64}$/i.test(c.headSha))) throw new Error(`Comment ${c.id}: invalid commit`);
  if (c.respondeA !== undefined && (typeof c.respondeA !== 'string' || !/^c-[a-z0-9]{4,32}$/.test(c.respondeA))) throw new Error(`Comment ${c.id}: replies to an invalid comment`);
  if (c.investigar !== undefined && typeof c.investigar !== 'boolean') throw new Error(`Comment ${c.id}: investigar must be true or false`);
  if (c.citado !== undefined && (typeof c.citado !== 'string' || c.citado.length > 2000)) throw new Error(`Comment ${c.id}: quoted text longer than 2000 characters`);
  // A fragment quoted from an answer only makes sense as a follow-up question in that thread.
  if (c.citadoDe !== undefined && (c.citadoDe !== 'respuesta' || c.citado === undefined || c.respondeA === undefined)) throw new Error(`Comment ${c.id}: answer quote without text or thread`);
  if (c.ambito !== undefined) return validarDePr(c);
  if (!LADOS.has(c.lado)) throw new Error(`Comment ${c.id}: unknown side`);
  if (!Number.isInteger(c.desde) || !Number.isInteger(c.hasta) || c.desde < 1 || c.hasta < c.desde) throw new Error(`Comment ${c.id}: invalid line range`);
  if (c.claves !== undefined && (!Array.isArray(c.claves) || c.claves.length > 2000 || !c.claves.every((k) => /^[nv]\d{1,7}$/.test(k)))) throw new Error(`Comment ${c.id}: invalid line keys`);
  if (typeof c.archivo !== 'string' || !c.archivo || c.archivo.length > 500) throw new Error(`Comment ${c.id}: invalid file`);
  if (c.textoOriginal !== undefined && (typeof c.textoOriginal !== 'string' || c.textoOriginal.length > MAX_SUGERIDO)) throw new Error(`Comment ${c.id}: original text too long`);
}

// Question about the PR or a section of its explanation, without diff lines.
function validarDePr(c) {
  if (c.ambito !== 'pr') throw new Error(`Comment ${c.id}: unknown scope`);
  if (c.tipo !== 'pregunta') throw new Error(`Comment ${c.id}: only a question is allowed on the PR`);
  if (c.seccion !== undefined && !Object.hasOwn(SECCIONES, c.seccion)) throw new Error(`Comment ${c.id}: unknown section`);
}

const limpiar = (c) => Object.fromEntries(CAMPOS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));

export function fusionarComentarios(actuales, entrantes) {
  const porId = new Map(actuales.map((c) => [c.id, c]));
  for (const c of entrantes) {
    const previo = porId.get(c.id);
    if (previo && !DEL_NAVEGADOR.has(previo.estado) && DEL_NAVEGADOR.has(c.estado)) continue;
    // The origin of a check fix is written only by the server: a browser copy never carries it, and must not drop it.
    if (!previo || (c.actualizado ?? '') > (previo.actualizado ?? '')) porId.set(c.id, previo?.origenCheck ? { ...c, origenCheck: previo.origenCheck } : c);
  }
  return [...porId.values()];
}

export function guardarComentarios(p, repo, numero, entrantes, borrados = []) {
  entrantes.forEach(validar);
  const quitar = new Set(borrados);
  const lista = fusionarComentarios(leerComentarios(p, repo, numero), entrantes.map(limpiar))
    .filter((c) => !(quitar.has(c.id) && DEL_NAVEGADOR.has(c.estado)));
  escribir(p, repo, numero, lista);
  return lista;
}

// A check finding sent to the change pipeline. Created here, not by the browser, so `origenCheck` cannot be forged.
// `origenCheck: { huella, regla, archivo, linea, texto, hashLinea? }` is stored because `resuelveCheck` needs the file,
// the line and the text (the hash for a line longer than the cut text) to tell whether the finding is gone, without
// reading the snapshot.
// The AI reason goes to `origenCheck.razon`, not into `texto`: the change job follows `texto` as the request and
// reads the reason only as labelled data.
export function crearCambioDeCheck(p, pr, h, { razon } = {}) {
  if (!Number.isInteger(h.linea) || h.linea < 1) throw new Error('The finding has no line: it cannot be sent to a fix');
  const huella = h.huella ?? huellaHallazgo(h);
  const actuales = leerComentarios(p, pr.repo, pr.numero);
  if (actuales.some((x) => bloqueaArreglo(x, huella, pr.headSha))) throw Object.assign(new Error('This finding already has a fix request'), { codigo: 409 });
  const ahora = new Date().toISOString();
  const c = {
    id: `c-${Array.from({ length: 12 }, () => Math.floor(Math.random() * 36).toString(36)).join('')}`,
    tipo: 'cambio', estado: 'en_cola', archivo: h.archivo, lado: 'nuevo', desde: h.linea, hasta: h.linea,
    texto: `Fix the check "${h.titulo}" (${h.regla}) on this line. ${h.mensaje} Change only what the finding needs.`,
    headSha: pr.headSha, creado: ahora, actualizado: ahora,
    origenCheck: { huella, regla: h.regla, archivo: h.archivo, linea: h.linea, texto: h.texto, ...(h.hashLinea ? { hashLinea: h.hashLinea } : {}), ...(razon ? { razon } : {}) },
  };
  // A retry replaces the failed or discarded request of the same finding instead of leaving it next to the new one.
  // An approved one stays: it records what was pushed.
  const previos = actuales.filter((x) => !(x.origenCheck?.huella === huella && REINTENTABLES.has(x.estado)));
  escribir(p, pr.repo, pr.numero, [...previos, c]);
  return c;
}

export function actualizarComentario(p, repo, numero, id, cambios) {
  const lista = leerComentarios(p, repo, numero);
  const i = lista.findIndex((c) => c.id === id);
  if (i < 0) throw new Error(`Comment ${id} does not exist in ${repo}#${numero}`);
  lista[i] = { ...lista[i], ...cambios, actualizado: new Date().toISOString() };
  escribir(p, repo, numero, lista);
  return lista[i];
}

// A job that fails before or during its run must not leave comments queued or in progress forever.
export function rescatarPendientes(p, repo, numero, ids, cambios) {
  const quedan = new Set(ids);
  const lista = leerComentarios(p, repo, numero);
  let n = 0;
  for (const [i, c] of lista.entries()) {
    if (!quedan.has(c.id) || !PENDIENTES.has(c.estado)) continue;
    lista[i] = { ...c, ...cambios, actualizado: new Date().toISOString() };
    n++;
  }
  if (n) escribir(p, repo, numero, lista);
  return n;
}

// A cancelled check fix becomes a failed request, so its row offers Fix again; other comments go back to drafts.
export function cancelarPendientes(p, repo, numero, ids) {
  const deCheck = new Set(leerComentarios(p, repo, numero).filter((c) => c.origenCheck).map((c) => c.id));
  return rescatarPendientes(p, repo, numero, ids.filter((id) => deCheck.has(id)), { estado: 'error', motivo: 'Cancelled' })
    + rescatarPendientes(p, repo, numero, ids.filter((id) => !deCheck.has(id)), { estado: 'borrador', motivo: null });
}

// When the server starts no job is still alive: whatever was queued or in progress was interrupted.
export function recuperarInterrumpidos(p) {
  const dir = join(p.salida, 'comentarios');
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const nombre of readdirSync(dir)) {
    const m = /^(.+)-(\d+)\.json$/.exec(nombre);
    if (!m) continue;
    const lista = leerComentarios(p, m[1], Number(m[2]));
    n += rescatarPendientes(p, m[1], Number(m[2]), lista.map((c) => c.id), { estado: 'error', motivo: 'The job was interrupted because the server restarted' });
  }
  return n;
}

// Splits the requested comments into sendable questions and changes; those from another commit are not sent.
export function separarEnviables(lista, ids, headSha) {
  const pedidos = new Set(ids);
  const r = { preguntas: [], cambios: [], desactualizados: [] };
  for (const c of lista) {
    if (!pedidos.has(c.id) || !['borrador', 'error'].includes(c.estado) || c.tipo === 'nota') continue;
    if (c.headSha && c.headSha !== headSha) r.desactualizados.push(c.id);
    else (c.tipo === 'pregunta' ? r.preguntas : r.cambios).push(c.id);
  }
  return r;
}
