// Filtro de la cola por una necesidad en palabras ("PRs de ciberseguridad"): la IA decide con título, rama, portal y
// archivos, sin leer el diff. El resultado se guarda por consulta y por estado de la cola: repetir un filtro guardado
// no cuesta mientras ninguna PR cambie de commit ni entre o salga de la cola.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { escribirJson, leerJson, rutaDiff } from './cache.mjs';
import { argsClaude, dirVacio, ejecutarClaude, registrarCosto, sistemaDe, tope, TURNOS } from './ia.mjs';

const SCHEMA = {
  type: 'object',
  properties: {
    coincidencias: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, relacion: { type: 'string', enum: ['directa', 'relacionada'] }, motivo: { type: 'string' } }, required: ['id', 'relacion', 'motivo'] },
    },
  },
  required: ['coincidencias'],
};
const MAX_ARCHIVOS = 40;
// Sube cuando cambian las instrucciones o el formato: los resultados guardados con las anteriores ya no valen.
const VERSION_FILTRO = 2;
export const MAX_CONSULTA = 300;

export const normalizarConsulta = (q) => String(q ?? '').replace(/\s+/g, ' ').trim();

export function archivosConocidos(p, pr) {
  const diff = leerJson(rutaDiff(p.salida, pr.repo, pr.numero));
  const delDiff = diff?.headSha === pr.headSha ? diff.archivos.map((a) => a.filename) : [];
  const otros = [...(pr.explicacion?.orden_lectura ?? []).map((o) => o.archivo), ...(pr.verificaciones?.hallazgos ?? []).map((h) => h.archivo)];
  return [...new Set([...delDiff, ...otros].filter(Boolean))];
}

export function lineaDePr(p, pr) {
  const archivos = archivosConocidos(p, pr);
  const lista = archivos.length
    ? `${archivos.slice(0, MAX_ARCHIVOS).join(', ')}${archivos.length > MAX_ARCHIVOS ? ` (+${archivos.length - MAX_ARCHIVOS})` : ''}`
    : 'sin datos';
  return `- ${pr.id} | ${pr.titulo} | rama ${pr.rama} | ${pr.portal ?? pr.repo} | archivos: ${lista}`;
}

export const firmaCola = (prs) => createHash('sha256').update(prs.map((x) => `${x.id}@${x.headSha}`).sort().join('|')).digest('hex').slice(0, 16);
const rutaFiltro = (p, clave) => join(p.salida, 'filtros', `${clave}.json`);

const enCurso = new Map();

export async function filtrarPrs(p, prs, consulta) {
  const q = normalizarConsulta(consulta);
  if (!q) throw new Error('Escriba qué PRs busca.');
  if (q.length > MAX_CONSULTA) throw new Error(`La necesidad no puede pasar de ${MAX_CONSULTA} caracteres.`);
  const firma = firmaCola(prs);
  const clave = createHash('sha256').update(`${VERSION_FILTRO}|${q.toLowerCase()}|${firma}`).digest('hex').slice(0, 32);
  const guardado = leerJson(rutaFiltro(p, clave));
  if (guardado) return { ...guardado, costo: 0, desdeCache: true };
  // Un doble clic o dos pestañas con la misma consulta comparten la llamada en vez de pagarla dos veces.
  if (!enCurso.has(clave)) enCurso.set(clave, consultar(p, prs, q, firma, clave).finally(() => enCurso.delete(clave)));
  return enCurso.get(clave);
}

async function consultar(p, prs, q, firma, clave) {
  const modelo = process.env.SEKI_IA_MODELO_FILTRAR ?? process.env.SEKI_IA_MODELO ?? 'sonnet';
  const prompt = `Necesidad: ${q}\n\nPRs (${prs.length}):\n${prs.map((pr) => lineaDePr(p, pr)).join('\n')}`;
  const r = await ejecutarClaude(argsClaude({
    modelo, prompt, sistema: sistemaDe(p, 'filtrar'), schema: SCHEMA, tools: [], tope: tope('filtrar'), turnos: TURNOS.filtrar,
  }), { cwd: dirVacio(p), limiteMs: 3 * 60 * 1000 });
  registrarCosto(p, { tipo: 'filtrar', modelo: r.modelo ?? modelo, uso: r.uso, costo: r.costo, ok: r.ok });
  if (!r.ok) throw new Error(`La IA no pudo filtrar: ${String(r.motivo ?? r.texto ?? '').slice(0, 300)}`);
  const ids = new Set(prs.map((x) => x.id));
  const vistos = new Set();
  const coincidencias = (r.salida.coincidencias ?? [])
    .filter((c) => ids.has(c.id) && !vistos.has(c.id) && vistos.add(c.id))
    .map((c) => ({ id: c.id, relacion: c.relacion === 'directa' ? 'directa' : 'relacionada', motivo: String(c.motivo).slice(0, 240) }));
  const resultado = { consulta: q, firma, total: prs.length, coincidencias, modelo: r.modelo ?? modelo, fecha: new Date().toISOString() };
  escribirJson(rutaFiltro(p, clave), resultado);
  return { ...resultado, costo: r.costo, desdeCache: false };
}
