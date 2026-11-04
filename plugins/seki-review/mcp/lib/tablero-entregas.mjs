// Deliveries as the board and the `entregas` tool see them: next action, events since the last visit and the
// manual adjustments (join, split, title, close). Nothing here calls GitHub: regrouping reuses prs.json.
import { createHash } from 'node:crypto';
import { escribirJson, leerJson, rutaAjustes, rutaEntregas, rutaInstantanea, rutaVisita } from './cache.mjs';
import { leerEventos, registrarEventos } from './eventos.mjs';
import { derivarEntregas } from './recolectar.mjs';

export const MAX_TITULO = 200;
const MAX_UNIR = 50;
const CAMPOS_PR = ['repo', 'repoEtiqueta', 'numero', 'titulo', 'url', 'base', 'portal', 'ambiente', 'estadoPr', 'mergeada'];

const fallo = (codigo, mensaje) => Object.assign(new Error(mensaje), { codigo });
const huella = (...partes) => createHash('sha256').update(partes.join('|')).digest('hex');

export function mapaPrs(foto) {
  const m = new Map();
  for (const pr of [...(foto?.prs ?? []), ...(foto?.recientes ?? [])]) if (!m.has(pr.id)) m.set(pr.id, pr);
  return m;
}

export const leerVisita = (p) => {
  const v = leerJson(rutaVisita(p.salida));
  return typeof v?.ts === 'string' ? v.ts : null;
};

export function marcarVisita(p, ahora = new Date()) {
  const ts = ahora.toISOString();
  escribirJson(rutaVisita(p.salida), { ts });
  return { ts };
}

const listaPrs = (ids) => `${ids.length === 1 ? 'PR' : 'PRs'} ${ids.join(', ')}`;

export function siguienteAccion(entrega, prsPorId) {
  const abiertas = (ambiente) => entrega.prs.filter((id) => {
    const pr = prsPorId.get(id);
    return pr?.ambiente === ambiente && pr.estadoPr === 'OPEN';
  }).sort();
  switch (entrega.etapa) {
    case 'por_mergear_pruebas': {
      const a = abiertas('pruebas');
      return a.length ? `Merge testing ${listaPrs(a)}` : 'Merge the testing PRs';
    }
    case 'qa_fallo': return 'Fix the QA failure and merge a new testing PR';
    case 'esperando_qa': return 'QA pending';
    case 'listo_produccion': {
      const a = abiertas('prod');
      return a.length ? `Merge production ${listaPrs(a)}` : 'Open the production PRs';
    }
    case 'en_produccion': return 'Verify in production and close the delivery';
    default: return 'No action';
  }
}

// entregas.json plus what the board needs: next action, PR summaries and events since the last visit.
export function datosEntregas(p) {
  const base = leerJson(rutaEntregas(p.salida));
  if (!base) return null;
  const prsPorId = mapaPrs(leerJson(rutaInstantanea(p.salida)));
  const visita = leerVisita(p);
  const prs = {};
  for (const id of new Set(base.entregas.flatMap((e) => e.prs))) {
    const pr = prsPorId.get(id);
    if (pr) prs[id] = Object.fromEntries(CAMPOS_PR.map((k) => [k, pr[k] ?? null]));
  }
  return {
    generado: base.generado,
    visita,
    desdeVisita: visita ? leerEventos(p, { desde: visita }) : [],
    entregas: base.entregas.map((e) => ({ ...e, siguiente: siguienteAccion(e, prsPorId) })),
    prs,
  };
}

function exigirIds(ids, conocidos) {
  for (const id of ids) {
    if (typeof id !== 'string' || !conocidos.has(id)) throw fallo(400, 'Unknown PR id');
  }
}

// Validates a body against the snapshot and the current deliveries; returns the normalized adjustment.
export function validarAjuste(cuerpo, foto, entregas) {
  const conocidos = mapaPrs(foto);
  const { tipo } = cuerpo ?? {};
  if (tipo === 'unir') {
    if (!Array.isArray(cuerpo.prs) || cuerpo.prs.length > MAX_UNIR) throw fallo(400, `prs must be an array of at most ${MAX_UNIR} PR ids`);
    exigirIds(cuerpo.prs, conocidos);
    const prs = [...new Set(cuerpo.prs)].sort();
    if (prs.length < 2) throw fallo(400, 'Joining needs at least two different PRs');
    return { tipo, prs };
  }
  if (tipo === 'separar') {
    exigirIds([cuerpo.pr], conocidos);
    return { tipo, pr: cuerpo.pr };
  }
  if (tipo === 'titulo') {
    if (typeof cuerpo.clave !== 'string' || !entregas.some((e) => e.clave === cuerpo.clave)) throw fallo(404, 'Unknown delivery');
    const titulo = typeof cuerpo.titulo === 'string' ? cuerpo.titulo.trim() : '';
    if (!titulo || titulo.length > MAX_TITULO) throw fallo(400, `The title must have between 1 and ${MAX_TITULO} characters`);
    return { tipo, clave: cuerpo.clave, titulo };
  }
  throw fallo(400, 'Unknown adjustment type');
}

function aplicarEnAjustes(previos, ajuste) {
  const a = { unir: [], separar: [], titulo: {}, ...(previos ?? {}) };
  let unir = (a.unir ?? []).map((g) => [...g]);
  let separar = [...(a.separar ?? [])];
  const titulo = { ...(a.titulo ?? {}) };
  if (ajuste.tipo === 'unir') {
    // A separated PR would ignore the join: joining takes it back.
    const juntos = new Set(ajuste.prs);
    separar = separar.filter((id) => !juntos.has(id));
    unir.push(ajuste.prs);
  } else if (ajuste.tipo === 'separar') {
    unir = unir.map((g) => g.filter((id) => id !== ajuste.pr)).filter((g) => g.length >= 2);
    if (!separar.includes(ajuste.pr)) separar.push(ajuste.pr);
  } else {
    titulo[ajuste.clave] = ajuste.titulo;
  }
  return { ...a, unir, separar, titulo };
}

// One adjustment at a time per process: ajustes.json is read, changed and written as a whole.
let cadena = Promise.resolve();
const enSerie = (fn) => {
  const r = cadena.then(fn);
  cadena = r.catch(() => {});
  return r;
};

const fotoActual = (p) => {
  const foto = leerJson(rutaInstantanea(p.salida));
  if (!foto) throw fallo(503, 'No PR data yet: refresh the state first.');
  return foto;
};
const entregasActuales = (p) => leerJson(rutaEntregas(p.salida))?.entregas ?? [];

export const aplicarAjuste = (p, cuerpo, ahora = () => new Date()) => enSerie(async () => {
  const foto = fotoActual(p);
  const entregas = entregasActuales(p);
  const ajuste = validarAjuste(cuerpo, foto, entregas);
  escribirJson(rutaAjustes(p.salida), aplicarEnAjustes(leerJson(rutaAjustes(p.salida)), ajuste));
  const ts = ahora().toISOString();
  const prs = ajuste.tipo === 'unir' ? ajuste.prs : ajuste.tipo === 'separar' ? [ajuste.pr] : entregas.find((e) => e.clave === ajuste.clave).prs;
  const entrega = ajuste.tipo === 'titulo' ? ajuste.clave : entregas.find((e) => e.prs.includes(prs[0]))?.clave ?? null;
  await registrarEventos(p, [{ id: huella('entrega_ajustada', JSON.stringify(ajuste), ts), ts, tipo: 'entrega_ajustada', entrega, prs: [...prs].sort(), ajuste, origen: 'tablero' }]);
  await derivarEntregas(p, foto);
  return datosEntregas(p);
});

// Only a delivery in production can be closed: before that, closing would hide pending work.
export const cerrarEntrega = (p, clave, ahora = () => new Date()) => enSerie(async () => {
  const foto = fotoActual(p);
  const entrega = typeof clave === 'string' ? entregasActuales(p).find((e) => e.clave === clave) : null;
  if (!entrega) throw fallo(404, 'Unknown delivery');
  if (entrega.etapa !== 'en_produccion') throw fallo(409, 'Only a delivery in production can be closed');
  const ts = ahora().toISOString();
  const prs = [...entrega.prs].sort();
  await registrarEventos(p, [{ id: huella('entrega_cerrada', prs.join(','), ts), ts, tipo: 'entrega_cerrada', entrega: clave, prs, origen: 'tablero' }]);
  await derivarEntregas(p, foto);
  return datosEntregas(p);
});
