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
};

const AHORRO = Object.fromEntries(Object.entries(NORMAL).map(([tipo, f]) => [tipo, {
  ...f,
  modelo: tipo.startsWith('ultra_') ? f.modelo : tipo === 'responder' || tipo === 'filtrar' ? 'haiku' : 'sonnet',
  segundaPasada: tipo === 'explicar' ? false : f.segundaPasada,
}]));

// An Ultra project default only pre-selects the mode: regular jobs run as in normal.
export const PERFILES = { ahorro: AHORRO, normal: NORMAL, ultra: structuredClone(NORMAL) };

export const modoValido = (m) => MODOS.includes(m);
export const modoDe = (p, override) => (modoValido(override) ? override : modoValido(p?.ia?.modo) ? p.ia.modo : 'normal');

const mayus = (tipo) => tipo.toUpperCase();

// The difficulty rule behind `modelo: null`; the environment variables win over everything.
export function elegirModelo({ tipo, pr = {}, lineasSeleccionadas = 0 }) {
  const forzado = process.env[`SEKI_IA_MODELO_${mayus(tipo)}`] ?? process.env.SEKI_IA_MODELO;
  if (forzado) return tipo === 'cambiar' && forzado === 'haiku' ? 'sonnet' : forzado;
  const grande = (pr.adiciones ?? 0) + (pr.eliminaciones ?? 0) > 1500;
  if (tipo !== 'responder' && (pr.seguridad || grande)) return 'opus';
  const esfuerzo = pr.explicacion?.esfuerzo ?? pr.esfuerzoTamano ?? 3;
  if (tipo === 'responder' && lineasSeleccionadas <= 40 && esfuerzo <= 2) return 'haiku';
  return 'sonnet';
}

export function perfil({ tipo, modo, pr = {}, lineasSeleccionadas = 0 }) {
  const m = modoValido(modo) ? modo : 'normal';
  const fila = PERFILES[m][tipo];
  if (!fila) throw new Error(`Unknown AI job type "${tipo}"`);
  const forzado = process.env[`SEKI_IA_MODELO_${mayus(tipo)}`] ?? process.env.SEKI_IA_MODELO;
  const modelo = forzado || !fila.modelo ? elegirModelo({ tipo, pr, lineasSeleccionadas }) : fila.modelo;
  const topeUsd = Number(process.env[`SEKI_IA_TOPE_${mayus(tipo)}`]) || fila.topeUsd;
  return { modo: m, modelo, topeUsd, turnos: fila.turnos, segundaPasada: fila.segundaPasada };
}
