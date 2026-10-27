// Comentarios sobre líneas del diff, guardados por PR. El navegador crea y edita borradores y notas; los demás
// estados (en cola, respondido, propuesta...) los pone el servidor y el navegador no puede revertirlos.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { leerJson, escribirJson, rutaComentarios } from './cache.mjs';

const TIPOS = new Set(['pregunta', 'cambio', 'nota']);
const DEL_NAVEGADOR = new Set(['borrador', 'nota']);
const MAX_TEXTO = 4000;
const MAX_SUGERIDO = 20000;
const LADOS = new Set(['nuevo', 'viejo', 'mixto']);
const PENDIENTES = new Set(['en_cola', 'en_curso']);
// Lo que el navegador puede escribir; respuesta, costo, propuesta y demás los pone solo el servidor.
const CAMPOS = ['id', 'tipo', 'estado', 'archivo', 'lado', 'desde', 'hasta', 'claves', 'textoOriginal', 'texto', 'sugerido', 'headSha', 'creado', 'actualizado'];

// Última escritura por PR, para que el tablero sepa cuándo recargar sin leer todos los archivos.
const marcas = new Map();
export const marcasComentarios = () => Object.fromEntries(marcas);

function escribir(p, repo, numero, lista) {
  escribirJson(rutaComentarios(p.salida, repo, numero), lista);
  marcas.set(`${repo}#${numero}`, new Date().toISOString());
}

export const leerComentarios = (p, repo, numero) => leerJson(rutaComentarios(p.salida, repo, numero), []);

function validar(c) {
  if (typeof c?.id !== 'string' || !/^c-[a-z0-9]{4,32}$/.test(c.id)) throw new Error('Comentario sin id válido');
  if (!TIPOS.has(c.tipo)) throw new Error(`Comentario ${c.id}: tipo desconocido "${c.tipo}"`);
  if (typeof c.texto !== 'string' || c.texto.length > MAX_TEXTO) throw new Error(`Comentario ${c.id}: texto vacío o de más de ${MAX_TEXTO} caracteres`);
  if (c.sugerido !== undefined && (typeof c.sugerido !== 'string' || c.sugerido.length > MAX_SUGERIDO)) throw new Error(`Comentario ${c.id}: código sugerido de más de ${MAX_SUGERIDO} caracteres`);
  if (!DEL_NAVEGADOR.has(c.estado)) throw new Error(`Comentario ${c.id}: estado no permitido`);
  if (!LADOS.has(c.lado)) throw new Error(`Comentario ${c.id}: lado desconocido`);
  if (!Number.isInteger(c.desde) || !Number.isInteger(c.hasta) || c.desde < 1 || c.hasta < c.desde) throw new Error(`Comentario ${c.id}: rango de líneas inválido`);
  if (c.claves !== undefined && (!Array.isArray(c.claves) || c.claves.length > 2000 || !c.claves.every((k) => /^[nv]\d{1,7}$/.test(k)))) throw new Error(`Comentario ${c.id}: claves de línea inválidas`);
  if (typeof c.archivo !== 'string' || !c.archivo || c.archivo.length > 500) throw new Error(`Comentario ${c.id}: archivo inválido`);
  if (c.textoOriginal !== undefined && (typeof c.textoOriginal !== 'string' || c.textoOriginal.length > MAX_SUGERIDO)) throw new Error(`Comentario ${c.id}: texto original demasiado largo`);
  if (c.headSha !== undefined && (typeof c.headSha !== 'string' || !/^[0-9a-z]{0,64}$/i.test(c.headSha))) throw new Error(`Comentario ${c.id}: commit inválido`);
}

const limpiar = (c) => Object.fromEntries(CAMPOS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));

export function fusionarComentarios(actuales, entrantes) {
  const porId = new Map(actuales.map((c) => [c.id, c]));
  for (const c of entrantes) {
    const previo = porId.get(c.id);
    if (previo && !DEL_NAVEGADOR.has(previo.estado) && DEL_NAVEGADOR.has(c.estado)) continue;
    if (!previo || (c.actualizado ?? '') > (previo.actualizado ?? '')) porId.set(c.id, c);
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

export function actualizarComentario(p, repo, numero, id, cambios) {
  const lista = leerComentarios(p, repo, numero);
  const i = lista.findIndex((c) => c.id === id);
  if (i < 0) throw new Error(`Comentario ${id} no existe en ${repo}#${numero}`);
  lista[i] = { ...lista[i], ...cambios, actualizado: new Date().toISOString() };
  escribir(p, repo, numero, lista);
  return lista[i];
}

// Un trabajo que falla antes o durante su ejecución no debe dejar comentarios en cola o en curso para siempre.
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

// Al arrancar el servidor ningún trabajo sigue vivo: lo que quedó en cola o en curso se interrumpió.
export function recuperarInterrumpidos(p) {
  const dir = join(p.salida, 'comentarios');
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const nombre of readdirSync(dir)) {
    const m = /^(.+)-(\d+)\.json$/.exec(nombre);
    if (!m) continue;
    const lista = leerComentarios(p, m[1], Number(m[2]));
    n += rescatarPendientes(p, m[1], Number(m[2]), lista.map((c) => c.id), { estado: 'error', motivo: 'El trabajo se interrumpió porque el servidor se reinició' });
  }
  return n;
}

// Reparte los comentarios pedidos en preguntas y cambios enviables; los de otro commit no se envían.
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
