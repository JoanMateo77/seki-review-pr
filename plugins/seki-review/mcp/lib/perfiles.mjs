import { probarSeguro } from './patrones.mjs';

// One table decides model, cost cap, turn limit and second pass for every AI call, per mode.
export const MODOS = ['ahorro', 'normal', 'ultra'];

const NORMAL = {
  responder: { modelo: null, topeUsd: 0.5, turnos: 4, segundaPasada: false },
  explicar: { modelo: null, topeUsd: 2, turnos: 30, segundaPasada: true },
  cambiar: { modelo: null, topeUsd: 1.5, turnos: 40, segundaPasada: false },
  investigar: { modelo: null, topeUsd: 1, turnos: 25, segundaPasada: false },
  filtrar: { modelo: 'sonnet', topeUsd: 0.5, turnos: 3, segundaPasada: false },
  ultra_lente: { modelo: 'sonnet', topeUsd: 1.5, turnos: 25, segundaPasada: false },
  ultra_verificar: { modelo: 'sonnet', topeUsd: 1, turnos: 30, segundaPasada: false },
  plantilla: { modelo: 'sonnet', topeUsd: 1, turnos: 25, segundaPasada: false },
};

const AHORRO = Object.fromEntries(Object.entries(NORMAL).map(([tipo, f]) => [tipo, {
  ...f,
  modelo: tipo.startsWith('ultra_') ? f.modelo : tipo === 'responder' || tipo === 'filtrar' ? 'haiku' : 'sonnet',
  segundaPasada: tipo === 'explicar' ? false : f.segundaPasada,
}]));

// An Ultra project default only pre-selects the mode: regular jobs run as in normal.
export const PERFILES = { ahorro: AHORRO, normal: NORMAL, ultra: structuredClone(NORMAL) };

const modoValido = (m) => MODOS.includes(m);
export const modoDe = (p, override) => (modoValido(override) ? override : modoValido(p?.ia?.modo) ? p.ia.modo : 'normal');

const mayus = (tipo) => tipo.toUpperCase();

// The difficulty rule behind `modelo: null`; the environment variables win over everything.
const modeloForzado = (tipo) => process.env[`SEKI_IA_MODELO_${mayus(tipo)}`] ?? process.env.SEKI_IA_MODELO;

export function elegirModelo({ tipo, pr = {}, lineasSeleccionadas = 0 }) {
  const forzado = modeloForzado(tipo);
  if (forzado) return tipo === 'cambiar' && forzado === 'haiku' ? 'sonnet' : forzado;
  const grande = (pr.adiciones ?? 0) + (pr.eliminaciones ?? 0) > 1500;
  if (tipo !== 'responder' && (pr.seguridad || grande)) return 'opus';
  const esfuerzo = pr.explicacion?.esfuerzo ?? pr.esfuerzoTamano ?? 3;
  if (tipo === 'responder' && lineasSeleccionadas <= 40 && esfuerzo <= 2) return 'haiku';
  return 'sonnet';
}

// Worst case of one Ultra review: three lenses and one verification.
export const topeRevisarUltra = () => 3 * perfil({ tipo: 'ultra_lente', modo: 'ultra' }).topeUsd + perfil({ tipo: 'ultra_verificar', modo: 'ultra' }).topeUsd;

// Worst case of one template review: one call per active template with AI items and one verification.
// Without AI items nothing is called, so the cap is 0.
export const topeRevisarPlantillas = (n) => (n > 0 ? n * perfil({ tipo: 'plantilla', modo: 'normal' }).topeUsd + perfil({ tipo: 'ultra_verificar', modo: 'normal' }).topeUsd : 0);

const VENTANA_DIAS = 30;
const MIN_MUESTRAS = 3;

// Median cost of the same job type and mode over the last 30 days; with fewer than 3 records the job cap stands in.
export function estimarCosto(registros, { tipo, modo = 'normal', multiplicador = 1, topeUsd = 0, ahora = Date.now() }) {
  const desde = new Date(ahora - VENTANA_DIAS * 86400000).toISOString();
  const costos = registros
    .filter((x) => x?.tipo === tipo && (x.modo ?? 'normal') === modo && x.fecha >= desde && Number.isFinite(x.costo))
    .map((x) => x.costo)
    .sort((a, b) => a - b);
  if (costos.length < MIN_MUESTRAS) return { usd: topeUsd, base: 'topes', muestras: costos.length };
  const m = costos.length >> 1;
  const mediana = costos.length % 2 ? costos[m] : (costos[m - 1] + costos[m]) / 2;
  return { usd: mediana * multiplicador, base: 'historial', muestras: costos.length };
}

// Ultra is suggested when a changed path matches a sensitive pattern or the PR is already flagged as security.
export function sugerirUltra(p, pr, archivos = []) {
  const rutas = archivos.map((a) => (typeof a === 'string' ? a : a?.filename)).filter(Boolean);
  const motivos = [];
  if (pr?.seguridad) motivos.push('The PR is flagged as security-related');
  for (const patron of p?.ia?.patronesSensibles ?? []) {
    if (rutas.some((r) => probarSeguro(patron, r) === true)) motivos.push(`A changed file matches the sensitive path pattern "${patron.source}"`);
  }
  return { sugerida: motivos.length > 0, motivos };
}

// Worst case a queued job may spend, for the budget gate: explicar adds its second pass (not when completing),
// cambiar its retry for each change request (`n`), responder one cap per question; the caller passes `n` when it knows the count.
export function topeDeTrabajo({ tipo, modo, n, completar = false }) {
  const f = perfil({ tipo, modo });
  const veces = tipo === 'cambiar' ? 2 * (n ?? 1) : n ?? (tipo === 'explicar' ? 1 + Number(f.segundaPasada && !completar) : 1);
  return f.topeUsd * veces;
}

export function perfil({ tipo, modo, pr = {}, lineasSeleccionadas = 0 }) {
  const m = modoValido(modo) ? modo : 'normal';
  const fila = PERFILES[m][tipo];
  if (!fila) throw new Error(`Unknown AI job type "${tipo}"`);
  const modelo = modeloForzado(tipo) || !fila.modelo ? elegirModelo({ tipo, pr, lineasSeleccionadas }) : fila.modelo;
  const topeUsd = Number(process.env[`SEKI_IA_TOPE_${mayus(tipo)}`]) || fila.topeUsd;
  return { modo: m, modelo, topeUsd, turnos: fila.turnos, segundaPasada: fila.segundaPasada };
}
