// Comentarios sobre líneas del diff, guardados por PR. El navegador crea y edita borradores y notas; los demás
// estados (en cola, respondido, propuesta...) los pone el servidor y el navegador no puede revertirlos.
import { leerJson, escribirJson, rutaComentarios } from './cache.mjs';

const TIPOS = new Set(['pregunta', 'cambio', 'nota']);
const DEL_NAVEGADOR = new Set(['borrador', 'nota']);
const MAX_TEXTO = 4000;
const MAX_SUGERIDO = 20000;

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
}

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
  const lista = fusionarComentarios(leerComentarios(p, repo, numero), entrantes)
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
