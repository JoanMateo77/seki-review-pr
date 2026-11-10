// AI triage of the fixed-rule check findings of one PR: one read-only call, one verdict per finding fingerprint.
// Explicit, confirmed job; the verdicts only advise, a person still dismisses or fixes.
import { escribirJson, leerJson, rutaTriaje } from './cache.mjs';
import { leerDescartes, MOTIVO_SIN_VEREDICTO, TRIABLES, triablesOrdenados } from './descartes.mjs';
import { crearCopia } from './copias.mjs';
import { argsClaude, ejecutarClaude, leerCostos, MOTIVO_FORMATO, reglasSecretos, registrarCosto, sistemaDe } from './ia.mjs';
import { estimarCosto, modoDe, perfil, topeDeTrabajo } from './perfiles.mjs';
import { existeCita } from './ultra.mjs';

const MAX_RAZON = 300;
const MOTIVO_GENERICO = 'The job failed';
const VEREDICTOS = new Set(['real', 'falso_positivo', 'dudoso']);

export const SCHEMA_TRIAJE = {
  type: 'object',
  properties: { veredictos: { type: 'array', items: { type: 'object', properties: {
    huella: { type: 'string' }, veredicto: { type: 'string', enum: [...VEREDICTOS] }, razon: { type: 'string' },
    evidencia: { type: 'object', properties: { archivo: { type: 'string' }, linea: { type: 'integer' } }, required: ['archivo', 'linea'] },
  }, required: ['huella', 'veredicto', 'razon'] } } },
  required: ['veredictos'],
};

const redondear = (n) => Math.round(n * 1e6) / 1e6;
const abiertosTriables = (verificaciones) => (verificaciones?.hallazgos ?? []).filter((h) => TRIABLES.has(h.severidad));

// A stored triage of an older commit stays readable: verdicts are matched to findings by fingerprint, not by commit.
export function leerTriaje(p, repo, numero, headSha) {
  const guardado = leerJson(rutaTriaje(p.salida, repo, numero));
  return guardado ? { ...guardado, desactualizado: guardado.headSha !== headSha } : null;
}

export function guardarTriaje(p, pr, { origen, modelo, modo, costo, veredictos }) {
  const triaje = { headSha: pr.headSha, fecha: new Date().toISOString(), origen, modelo, modo, costo, veredictos };
  escribirJson(rutaTriaje(p.salida, pr.repo, pr.numero), triaje);
  return triaje;
}

// A triage of the same commit already stored keeps its verdicts (they may carry evidence); Ultra only adds the
// fingerprints it has none for. Another commit's triage is replaced, as in any other write.
export function fusionarTriaje(p, pr, { modelo, modo, costo, veredictos }) {
  const guardado = leerJson(rutaTriaje(p.salida, pr.repo, pr.numero));
  if (guardado?.headSha !== pr.headSha) return guardarTriaje(p, pr, { origen: 'ultra', modelo, modo, costo, veredictos });
  const tenidas = new Set(guardado.veredictos.map((v) => v.huella));
  const nuevos = veredictos.filter((v) => !tenidas.has(v.huella)).map((v) => ({ ...v, origen: 'ultra' }));
  const triaje = { ...guardado, veredictos: [...guardado.veredictos, ...nuevos] };
  escribirJson(rutaTriaje(p.salida, pr.repo, pr.numero), triaje);
  return triaje;
}

// What the board shows before triaging: stored result, dismissals, how many findings qualify, estimate and cap.
export function datosChecks(p, pr, verificaciones) {
  const modo = modoDe(p);
  const topeUsd = topeDeTrabajo({ tipo: 'triar_checks', modo });
  const { usd, base, muestras } = estimarCosto(leerCostos(p), { tipo: 'triar_checks', modo, topeUsd });
  return {
    triaje: leerTriaje(p, pr.repo, pr.numero, pr.headSha),
    descartes: leerDescartes(p, pr.repo, pr.numero),
    triables: abiertosTriables(verificaciones).length,
    estimacion: { usd, base, muestras },
    topeUsd,
  };
}

// Anything the model skipped or backed with a weak "false positive" becomes dudoso: it never hides a finding by omission.
function normalizar(salida, enviados, raices) {
  const validas = new Set(enviados.map((h) => h.huella));
  const vistos = new Map();
  const cuentas = new Map();
  for (const x of Array.isArray(salida?.veredictos) ? salida.veredictos : []) {
    if (!x || !validas.has(x.huella) || vistos.has(x.huella) || !VEREDICTOS.has(x.veredicto)) continue;
    const razon = String(x.razon ?? '').trim().slice(0, MAX_RAZON);
    const evidencia = x.evidencia && typeof x.evidencia.archivo === 'string' ? { archivo: x.evidencia.archivo.slice(0, 300), linea: x.evidencia.linea } : undefined;
    let veredicto = x.veredicto;
    if (veredicto === 'falso_positivo' && (!razon || (evidencia && existeCita(raices, cuentas, evidencia)))) veredicto = 'dudoso';
    vistos.set(x.huella, { huella: x.huella, veredicto, razon, ...(evidencia ? { evidencia } : {}) });
  }
  return enviados.map((h) => vistos.get(h.huella) ?? { huella: h.huella, veredicto: 'dudoso', razon: MOTIVO_SIN_VEREDICTO });
}

export async function triarChecks(p, pr, { modo, repetir = false, ejecutar = ejecutarClaude, copiar = crearCopia, verificaciones } = {}) {
  if (!pr?.headSha) throw new Error('The PR has no head commit');
  const guardado = leerJson(rutaTriaje(p.salida, pr.repo, pr.numero));
  if (!repetir && guardado?.headSha === pr.headSha) return { ok: true, motivo: null, costo: 0, modelo: guardado.modelo ?? null, resultado: guardado, desdeCache: true };

  const enviados = triablesOrdenados(verificaciones?.hallazgos);
  if (!enviados.length) return { ok: false, motivo: 'No findings to triage', costo: 0 };

  const sistema = sistemaDe(p, 'base', 'checks-triar');
  const dir = await copiar(p, pr.repo, pr.numero, pr.headSha, { sufijo: '-lectura' });
  const raices = new Map([['', dir], [pr.repo, dir]]);
  const prohibidas = reglasSecretos([dir], p.secretos);
  const modoEfectivo = modoDe(p, modo);
  const f = perfil({ tipo: 'triar_checks', modo: modoEfectivo, pr });
  const fichas = enviados.map(({ huella, regla, titulo, severidad, archivo, linea, texto, mensaje }) => ({ huella, regla, titulo, severidad, archivo, linea, texto, mensaje }));
  const prompt = `Triage these findings of PR #${pr.numero} of ${pr.repo}: ${pr.titulo ?? ''}\n\nFindings:\n${JSON.stringify(fichas, null, 1)}`;

  let r;
  try {
    r = await ejecutar(argsClaude({ modelo: f.modelo, sistema, prompt, schema: SCHEMA_TRIAJE, tools: ['Read', 'Grep', 'Glob'], tope: f.topeUsd, turnos: f.turnos, prohibidas }), { cwd: dir });
  } catch {
    r = { ok: false, costo: 0, salida: null, motivoSeguro: MOTIVO_GENERICO };
  }
  const costo = redondear(r.costo ?? 0);
  const modelo = r.modelo ?? f.modelo;
  const formatoValido = r.ok && Array.isArray(r.salida?.veredictos);
  const motivo = formatoValido ? null : r.ok ? MOTIVO_FORMATO : r.motivoSeguro ?? MOTIVO_GENERICO;
  registrarCosto(p, { tipo: 'triar_checks', modo: modoEfectivo, prId: pr.id, modelo, costo, ok: !motivo, ...(motivo ? { motivo } : {}) });
  if (motivo) return { ok: false, motivo, costo, modelo, resultado: null };

  const resultado = guardarTriaje(p, pr, { origen: 'checks', modelo, modo: modoEfectivo, costo, veredictos: normalizar(r.salida, enviados, raices) });
  return { ok: true, motivo: null, costo, modelo, resultado };
}
