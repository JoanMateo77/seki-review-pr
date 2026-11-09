// Serves the dashboard on 127.0.0.1 with actions: refresh the state (GitHub + git, no AI) and
// analyze PRs with AI. It only serves this machine and requires the URL token on every call.
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { cargarProyectos, proyecto as cargarProyecto } from './config.mjs';
import { recolectar } from './recolectar.mjs';
import { construirHtml, fotoConExplicaciones, nombresDeArchivos, versionEnDisco } from './tablero.mjs';

const VERSION = versionEnDisco();
import { crearCola } from './trabajos.mjs';
import { asegurarDiff, diffParaTablero } from './diffs.mjs';
import { actualizarComentario, guardarComentarios, leerComentarios, marcasComentarios, recuperarInterrumpidos, rescatarPendientes, separarEnviables } from './comentarios.mjs';
import { investigarPregunta, responderPreguntas } from './preguntas.mjs';
import { ajustarPropuesta, aprobar, descartar, leerPropuesta, proponerCambios } from './propuestas.mjs';
import { explicarConIa } from './explicar.mjs';
import { avances } from './avance.mjs';
import { filtrarPrs } from './filtrar.mjs';
import { costosDelDia, registrarCosto, resumenCostos } from './ia.mjs';
import { modoDe, topeDeTrabajo, topeRevisarUltra } from './perfiles.mjs';
import { datosUltra, leerUltra, revisarUltra } from './ultra.mjs';
import { datosPlantillas, leerPlantillasPr, revisarPlantillas } from './revision-plantillas.mjs';
import { crearPresupuesto, crearReservas, gastoMaquina } from './presupuesto.mjs';
import { estadoServidor, pedirCeder, tokenDe } from './acceso.mjs';
import { limpiarCopias } from './copias.mjs';
import { ghJson } from './proceso.mjs';
import { dirQa, leerJson, rutaEntregas, rutaInstantanea } from './cache.mjs';
import { crearSondeo, crearVigia, VENTANA_TABLERO_MS } from './vigia.mjs';
import { aplicarAjuste, cerrarEntrega, datosEntregas, mapaPrs, marcarVisita } from './tablero-entregas.mjs';
import { MAX_ARCHIVO } from './archivos.mjs';
import { importarQa } from './qa-importar.mjs';
import { generarGuia } from './qa-salida.mjs';
import { aplicarRastreador, cambiosPendientes } from './rastreador-xlsx.mjs';
import { enSerieEntregas } from './recolectar.mjs';
import { idDe, incorporarEnlace, leerRevisar, quitarRevisar } from './revisar.mjs';

// Reservations of running AI jobs are shared by every project served by this process.
const RESERVAS_PROCESO = crearReservas();

const PUERTO = 4317;
const MAX_CUERPO = 64 * 1024;
const MAX_CUERPO_ENTREGAS = 16 * 1024;
const MAX_CUERPO_IMPORTAR = 7 * 1024 * 1024;
const NOMBRE_GUIA = /^guia-\d{4}-\d{2}-\d{2}-\d+\.(xlsx|pdf|html)$/;
const TIPOS_GUIA = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  html: 'text/html; charset=utf-8',
};
const MAX_RESULTADOS_GUIA = 20;
const falloHttp = (codigo, mensaje) => Object.assign(new Error(mensaje), { codigo });
// Errors tagged by the review-intake library carry a safe message and the status to answer with.
const PREFIJO_REVISAR = '[seki-review/revisar] ';
const errorRevisar = (e) => {
  throw typeof e?.codigo === 'string' && String(e.message).startsWith(PREFIJO_REVISAR) ? falloHttp(e.http ?? 400, e.message.slice(PREFIJO_REVISAR.length)) : e;
};

// The guide is a regular file inside salida/qa: a link, a subfolder or a name outside the pattern is never served.
function leerArchivoGuia(p, nombre) {
  if (typeof nombre !== 'string' || !NOMBRE_GUIA.test(nombre)) throw falloHttp(400, 'Invalid file name');
  let raiz;
  let ruta;
  try {
    raiz = realpathSync(dirQa(p.salida));
    ruta = join(raiz, nombre);
    const st = lstatSync(ruta);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('not a regular file');
    if (realpathSync(ruta) !== ruta) throw new Error('outside the folder');
    return readFileSync(ruta);
  } catch {
    throw falloHttp(404, 'File not found');
  }
}

// Strict base64 of an .xlsx upload: the decoded size is known before decoding.
function decodificarImportacion({ nombre, contenido }) {
  if (typeof nombre !== 'string' || !/\.xlsx$/i.test(nombre) || nombre.length > 255) throw falloHttp(400, 'The file name must end in .xlsx');
  if (typeof contenido !== 'string' || contenido.length === 0 || contenido.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(contenido)) throw falloHttp(400, 'The content must be base64');
  const bytes = contenido.length / 4 * 3 - (contenido.endsWith('==') ? 2 : contenido.endsWith('=') ? 1 : 0);
  if (bytes > MAX_ARCHIVO) throw falloHttp(413, 'The file exceeds 5 MB');
  return Buffer.from(contenido, 'base64');
}

// Explain jobs only for PR ids present in the snapshot; unknown ids are dropped.
export const soloPrsConocidos = (ids, validas) => ids.filter((x) => validas.has(x));

function opcionesGuia({ claves, desde, explicarFaltantes }) {
  if (claves !== undefined && (!Array.isArray(claves) || claves.length > 500 || claves.some((c) => typeof c !== 'string' || !c || c.length > 300))) throw falloHttp(400, 'claves must be a list of delivery keys');
  if (desde !== undefined && desde !== null && desde !== 'ultimo-corte') throw falloHttp(400, 'desde must be ultimo-corte');
  if (explicarFaltantes !== undefined && typeof explicarFaltantes !== 'boolean') throw falloHttp(400, 'explicarFaltantes must be a boolean');
  return { claves: claves?.length ? claves : undefined, desde: desde ?? undefined, explicarFaltantes: explicarFaltantes === true };
}

const nombreArchivo = (ruta) => (ruta ? ruta.split(/[\\/]/).pop() : null);
// The browser gets file names only, never absolute paths.
const rastreadorPublico = (r) => (r?.respaldo ? { ...r, respaldo: nombreArchivo(r.respaldo) } : r);
const opcionesIguales = (a, b) => JSON.stringify([[...(a.claves ?? [])].sort(), a.desde ?? null, a.explicarFaltantes]) === JSON.stringify([[...(b.claves ?? [])].sort(), b.desde ?? null, b.explicarFaltantes]);

const servidores = new Map();

function leerCuerpo(req) {
  return new Promise((ok, falla) => {
    let datos = '';
    req.on('data', (d) => {
      datos += d;
      if (datos.length > MAX_CUERPO) { falla(new Error('Request body too large')); req.destroy(); }
    });
    req.on('end', () => { try { ok(datos ? JSON.parse(datos) : {}); } catch { falla(new Error('Invalid JSON')); } });
  });
}

// Stricter reader for the deliveries endpoints: JSON content type, small cap answered with 413, an object body.
function leerJsonEstricto(req, max = MAX_CUERPO_ENTREGAS) {
  const error = (codigo, mensaje) => Object.assign(new Error(mensaje), { codigo });
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) return Promise.reject(error(415, 'The body must be application/json'));
  if (Number(req.headers['content-length']) > max) return Promise.reject(error(413, 'Request body too large'));
  return new Promise((ok, falla) => {
    const trozos = [];
    let largo = 0;
    let excedido = false;
    req.on('data', (d) => {
      if (excedido) return;
      largo += d.length;
      if (largo > max) { excedido = true; return falla(error(413, 'Request body too large')); }
      trozos.push(d);
    });
    req.on('end', () => {
      if (excedido) return;
      let v;
      try { v = JSON.parse(Buffer.concat(trozos).toString('utf8') || '{}'); } catch { return falla(error(400, 'Invalid JSON')); }
      if (!v || typeof v !== 'object' || Array.isArray(v)) return falla(error(400, 'The body must be a JSON object'));
      ok(v);
    });
    req.on('error', falla);
  });
}

const responder = (res, codigo, cuerpo, tipo = 'application/json; charset=utf-8') => {
  res.writeHead(codigo, { 'Content-Type': tipo, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo));
};

// "x.y.z" version compared numerically; no version (before 0.19.1) counts as the oldest.
export function esMasNueva(a, b) {
  const partes = (v) => String(v ?? '0').split('.').map((x) => Number(x) || 0);
  const [x, y] = [partes(a), partes(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

// Standby session: while another session serves the dashboard, check every few seconds. If that session closes
// (port free) or an older version becomes idle, this one takes the port on the same link.
const vigilantes = new Map();
function vigilar(proyecto, puerto) {
  if (vigilantes.has(proyecto)) return;
  const v = { reloj: null, revision: null };
  v.reloj = setInterval(() => {
    if (servidores.has(proyecto)) { clearInterval(v.reloj); vigilantes.delete(proyecto); return; }
    if (v.revision) return;
    v.revision = iniciarServidor({ proyecto, puerto, abrir: false, soloPuerto: true })
      .catch(() => { /* another session won the port; keep watching */ })
      .finally(() => { v.revision = null; });
  }, Number(process.env.SEKI_VIGILANCIA_MS) || 5000);
  v.reloj.unref();
  vigilantes.set(proyecto, v);
}

// Closes every dashboard this process serves and stops the standby watchers, even with jobs in progress: queued jobs
// are cancelled and it resolves once the running work has finished (see cerrar). A check already in flight may still
// take the port or start a new watcher, so it is awaited and the loop repeats.
export async function detenerServidores() {
  while (vigilantes.size) {
    const pendientes = [...vigilantes.values()];
    vigilantes.clear();
    for (const v of pendientes) clearInterval(v.reloj);
    await Promise.all(pendientes.map((v) => v.revision));
  }
  await Promise.all([...servidores.values()].map((s) => s.cerrar()));
}

// intervaloVigiaMs and relojVigia exist for tests only.
export async function iniciarServidor({ proyecto, puerto = PUERTO, abrir = true, soloPuerto = false, intervaloVigiaMs = null, relojVigia, ejecutarUltra = revisarUltra, ejecutarPlantillas = revisarPlantillas } = {}) {
  if (servidores.has(proyecto)) {
    const s = servidores.get(proyecto);
    if (abrir) execFile('open', [s.url]);
    return { url: s.url, yaEstaba: true };
  }
  const p = cargarProyecto(proyecto);
  const token = tokenDe(p);
  // Another Claude Code session may hold the dashboard. If it runs an older version and is idle, ask it for the
  // port; otherwise use that one and keep this session on standby in case the other closes.
  const otro = await estadoServidor(puerto, token);
  if (otro) {
    const url = `http://127.0.0.1:${puerto}/?t=${token}`;
    const vieja = esMasNueva(VERSION, otro.version);
    const ocupado = otro.refrescando || (otro.trabajos ?? []).some((t) => t.estado === 'en_cola' || t.estado === 'en_curso');
    const cedio = vieja && !ocupado && await pedirCeder(puerto, token);
    if (!cedio) {
      vigilar(proyecto, puerto);
      if (abrir && process.platform === 'darwin') execFile('open', [url]);
      const aviso = !vieja ? null
        : ocupado ? `Another Claude Code session is serving it with version ${otro.version ?? 'older'} and has jobs in progress; when they finish, this session takes over the dashboard with ${VERSION}.`
          : `Another Claude Code session is serving it with an older version that cannot hand over the port: close or restart that session and this one takes over the dashboard with ${VERSION}.`;
      return { url, yaEstaba: true, aviso };
    }
  }
  let refresco = null;
  let ultimoRefresco = null;
  let limpieza = null;

  const lanzar = (repos) => recolectar({ proyecto, repos }).then(
    (f) => {
      ultimoRefresco = { ok: true, fecha: f.generado };
      // Copies of closed PRs or unused for a week are deleted; traceability stays in the comments.
      limpieza = limpiarCopias(p, { abiertas: new Set(f.prs.filter((x) => x.estadoPr === 'OPEN').map((x) => x.id)) }).catch(() => {});
    },
    (e) => { ultimoRefresco = { ok: false, fecha: new Date().toISOString(), mensaje: e.message.slice(0, 300) }; },
  );
  // Single-flight with one pending refresh. A request made while a refresh runs merges its repos into the pending one
  // (a full request makes it full), which starts right after the running one ends. The returned promise resolves when
  // the refresh that covers the requested repos has finished, so nobody is answered by a refresh of other repos or by
  // one that started before their change. A full request while a full refresh runs and nothing is pending joins it.
  let enCursoCompleto = false;
  let pendiente = null;
  const iniciar = (repos) => {
    enCursoCompleto = !repos?.length;
    const mio = lanzar(repos).finally(() => { if (refresco === mio) { refresco = null; enCursoCompleto = false; } });
    refresco = mio;
    return mio;
  };
  const refrescar = (repos) => {
    const completo = !repos?.length;
    if (!refresco && !pendiente) return iniciar(repos);
    if (completo && !pendiente && enCursoCompleto) return refresco;
    if (!pendiente) {
      const lote = { repos: new Set(), completo: false };
      lote.promesa = refresco.then(() => { pendiente = null; return iniciar(lote.completo ? undefined : [...lote.repos]); });
      pendiente = lote;
    }
    if (completo) pendiente.completo = true;
    else for (const r of repos) pendiente.repos.add(r);
    return pendiente.promesa;
  };
  const refrescando = () => !!refresco || !!pendiente;

  // Each change to the review list refreshes its repo through the shared path.
  const refrescarRepo = (repo) => refrescar([repo]).catch((e) => console.error(`[seki-review/revisar] The refresh after a list change failed: ${e?.code ?? 'error'}`));

  // Repos whose list entries (added after the last snapshot, for example from the chat tool) are not in it yet.
  const reposConEntradasNuevas = () => {
    let foto = null;
    try { foto = leerJson(rutaInstantanea(p.salida)); } catch { return []; }
    const ids = new Set((foto?.prs ?? []).map((x) => x.id));
    const desde = foto?.generado ?? '';
    return [...new Set(leerRevisar(p).filter((e) => p.repos[e.repo] && String(e.agregada) > desde && !ids.has(idDe(e))).map((e) => e.repo))];
  };

  // Merge watcher. It shares the single-flight refresh: a probe is skipped while a manual refresh runs, and a
  // refresh that starts between probe and refresh is awaited first. The probe bound moves only after a good refresh.
  let ultimoTablero = 0;
  const sondeo = crearSondeo({
    owner: p.owner,
    repos: Object.keys(p.repos),
    instantanea: () => { try { return leerJson(rutaInstantanea(p.salida))?.generado ?? null; } catch { return null; } },
    gh: ghJson,
  });
  const vigia = crearVigia({
    intervaloMs: intervaloVigiaMs ?? p.vigia.intervaloSeg * 1000,
    reloj: relojVigia,
    tableroAbierto: () => Date.now() - ultimoTablero < VENTANA_TABLERO_MS,
    sondear: async () => (refrescando() ? [] : [...new Set([...(await sondeo.sondear()), ...reposConEntradasNuevas()])]),
    refrescar: async (repos) => {
      await refrescar(repos);
      if (!ultimoRefresco?.ok) throw new Error(ultimoRefresco?.mensaje ?? 'Refresh failed');
      sondeo.confirmar();
    },
  });

  // The limit is the served project's; the spend counts every configured project on this machine.
  let gastoAvisado = false;
  const presupuesto = crearPresupuesto({
    compartido: RESERVAS_PROCESO,
    limite: () => p.ia?.presupuestoDiarioUsd ?? null,
    gasto: () => {
      try { return gastoMaquina({ proyectos: cargarProyectos().proyectos }); } catch {
        if (!gastoAvisado) console.error('[seki-review/presupuesto] The project list could not be read: the budget counts only this project');
        gastoAvisado = true;
        return costosDelDia(p).total;
      }
    },
  });
  const cola = crearCola({ presupuesto });
  const modo = modoDe(p);
  // QA guide jobs run outside the AI queue (they wait for a lock and for Chrome, and spend no AI): one at a time,
  // a second request with the same options while one runs gets the same job, with other options it gets 409. The newest few states stay readable by id.
  const trabajosGuia = new Map();
  let guiaActiva = null;
  let secuenciaGuia = 0;
  const guiaEnCurso = () => [...trabajosGuia.values()].some((t) => t.estado === 'en_curso');
  const listaGuias = () => [...trabajosGuia.values()].map(({ resultado, ...t }) => t);
  const iniciarGuia = ({ claves, desde, explicarFaltantes }) => {
    if (guiaActiva) {
      if (opcionesIguales(guiaActiva.opciones, { claves, desde, explicarFaltantes })) return guiaActiva.id;
      throw falloHttp(409, 'A QA guide is being generated; try again when it finishes');
    }
    const id = `qa_guia:${Date.now()}:${++secuenciaGuia}`;
    const t = { id, tipo: 'qa_guia', estado: 'en_curso', encolado: new Date().toISOString(), inicio: new Date().toISOString() };
    trabajosGuia.set(id, t);
    while (trabajosGuia.size > MAX_RESULTADOS_GUIA) trabajosGuia.delete(trabajosGuia.keys().next().value);
    const promesa = (async () => {
      try {
        const r = await generarGuia(p, { claves, desde });
        const resultado = {
          id: r.id,
          archivos: { xlsx: nombreArchivo(r.archivos.xlsx), html: nombreArchivo(r.archivos.html), pdf: nombreArchivo(r.archivos.pdf) },
          filas: r.filas, pendientes: r.pendientes, avisoPdf: r.avisoPdf, vacia: r.vacia,
        };
        if (explicarFaltantes && r.pendientes.length) {
          // PRs merged into testing live in `recientes`, not in `prs`.
          const validas = mapaPrs(leerJson(rutaInstantanea(p.salida)));
          resultado.encolados = cola.encolar(soloPrsConocidos(r.pendientes, validas).map((x) => ({ id: x, tipo: 'explicar', prId: x, topeUsd: topeDeTrabajo({ tipo: 'explicar', modo }), ejecutar: () => explicarConIa(p, validas.get(x), { modo }) })));
        }
        Object.assign(t, { estado: 'terminado', resultado });
      } catch (e) {
        console.error(`[seki-review/qa] Guide job failed: ${typeof e?.codigo === 'string' ? e.codigo : 'error'}`);
        // Only tagged errors carry a message that is safe to show.
        Object.assign(t, { estado: 'error', mensaje: typeof e?.codigo === 'string' && String(e.message).startsWith('[seki-review/') ? e.message.slice(0, 400) : 'The guide could not be generated' });
      } finally {
        t.fin = new Date().toISOString();
        guiaActiva = null;
      }
    })();
    guiaActiva = { id, promesa, opciones: { claves, desde, explicarFaltantes } };
    return id;
  };
  recuperarInterrumpidos(p);
  // Whatever a job leaves queued or in progress when it fails or is cancelled becomes sendable again.
  const conRescate = (pr, ids, ejecutar) => ({
    ejecutar: async () => {
      try { return await ejecutar(); } finally { rescatarPendientes(p, pr.repo, pr.numero, ids, { estado: 'error', motivo: 'The job finished without completing this comment' }); }
    },
    alCancelar: () => rescatarPendientes(p, pr.repo, pr.numero, ids, { estado: 'borrador', motivo: null }),
  });

  const servidor = createServer(async (req, res) => {
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return responder(res, 421, { error: 'Host not allowed' });
    const url = new URL(req.url, `http://${host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      if (url.searchParams.get('t') !== token) return responder(res, 403, 'Missing access token. Open the link provided by seki-review.', 'text/plain; charset=utf-8');
      const foto = fotoConExplicaciones(p);
      if (!foto) return responder(res, 503, 'No data yet: refresh the state from Claude Code.', 'text/plain; charset=utf-8');
      return responder(res, 200, construirHtml(p, foto, { token }), 'text/html; charset=utf-8');
    }

    if (!url.pathname.startsWith('/api/')) return responder(res, 404, { error: 'Not found' });
    if (!req.headers['x-seki-token']) return responder(res, 401, { error: 'Missing token' });
    if (req.headers['x-seki-token'] !== token) return responder(res, 403, { error: 'Invalid token' });

    const datosRastreador = () => [leerJson(rutaEntregas(p.salida))?.entregas ?? [], mapaPrs(leerJson(rutaInstantanea(p.salida)))];
    const prDeFoto = (id) => {
      const pr = fotoConExplicaciones(p)?.prs.find((x) => x.id === id);
      if (!pr) throw Object.assign(new Error('PR not in the snapshot'), { codigo: 404 });
      return pr;
    };

    try {
      if (req.method === 'GET' && url.pathname === '/api/comentarios') {
        const pr = prDeFoto(url.searchParams.get('id'));
        return responder(res, 200, leerComentarios(p, pr.repo, pr.numero));
      }
      if (req.method === 'POST' && url.pathname === '/api/comentarios') {
        const { id, comentarios = [], borrados = [] } = await leerCuerpo(req);
        const pr = prDeFoto(id);
        if (!Array.isArray(comentarios) || !Array.isArray(borrados)) throw new Error('comentarios and borrados must be arrays');
        return responder(res, 200, guardarComentarios(p, pr.repo, pr.numero, comentarios, borrados));
      }
      if (req.method === 'POST' && url.pathname === '/api/enviar-revision') {
        const { id, ids = [], modo: modoPedido } = await leerCuerpo(req);
        const modo = modoDe(p, modoPedido);
        const pr = prDeFoto(id);
        if (!Array.isArray(ids)) throw new Error('ids must be an array');
        const lista = leerComentarios(p, pr.repo, pr.numero);
        const { preguntas: todas, cambios, desactualizados } = separarEnviables(lista, ids, pr.headSha);
        const conCodigo = new Set(lista.filter((c) => c.investigar).map((c) => c.id));
        const preguntas = todas.filter((cid) => !conCodigo.has(cid));
        const investigar = todas.filter((cid) => conCodigo.has(cid));
        if (cambios.length && pr.estadoPr !== 'OPEN') throw new Error('The PR is no longer open: changes cannot be requested');
        for (const cid of [...todas, ...cambios]) actualizarComentario(p, pr.repo, pr.numero, cid, { estado: 'en_cola', motivo: null });
        const ahora = Date.now();
        if (preguntas.length) cola.encolar([{ id: `${pr.id}:responder:${ahora}`, tipo: 'responder', prId: pr.id, // The number of uncached questions is not known here: the cap counts every question sent.
          topeUsd: topeDeTrabajo({ tipo: 'responder', modo, n: preguntas.length }), ...conRescate(pr, preguntas, () => responderPreguntas(p, pr, preguntas, { modo })) }]);
        if (cambios.length) cola.encolar([{ id: `${pr.id}:cambiar:${ahora}`, tipo: 'cambiar', prId: pr.id, topeUsd: topeDeTrabajo({ tipo: 'cambiar', modo, n: cambios.length }), ...conRescate(pr, cambios, () => proponerCambios(p, pr, cambios, { modo })) }]);
        for (const cid of investigar) cola.encolar([{ id: `${pr.id}:investigar:${cid}:${ahora}`, tipo: 'investigar', prId: pr.id, topeUsd: topeDeTrabajo({ tipo: 'investigar', modo }), ...conRescate(pr, [cid], () => investigarPregunta(p, pr, cid, { modo })) }]);
        return responder(res, 202, { preguntas: todas.length, cambios: cambios.length, desactualizados: desactualizados.length });
      }
      // Was the answer useful? Stored on the question and in the cost log to compare models.
      if (req.method === 'POST' && url.pathname === '/api/valorar') {
        const { id, comentario, util } = await leerCuerpo(req);
        if (util !== true && util !== false && util !== null) throw new Error('util must be true, false or null');
        const pr = prDeFoto(id);
        const c = leerComentarios(p, pr.repo, pr.numero).find((x) => x.id === comentario && x.tipo === 'pregunta');
        if (!c) throw Object.assign(new Error('The question does not exist'), { codigo: 404 });
        if (c.estado !== 'respondido') throw new Error('Only an answered question can be rated');
        actualizarComentario(p, pr.repo, pr.numero, c.id, { valoracion: util ?? undefined });
        registrarCosto(p, { tipo: 'valoracion', prId: pr.id, comentario: c.id, modelo: c.modelo, modo: c.modo, investigado: !!c.investigado, util, costo: 0 });
        return responder(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/costos') return responder(res, 200, resumenCostos(p));
      if (req.method === 'POST' && url.pathname === '/api/filtrar') {
        const { consulta, forzar, modo: modoPedido } = await leerCuerpo(req);
        const modo = modoDe(p, modoPedido);
        const foto = fotoConExplicaciones(p);
        if (!foto) throw Object.assign(new Error('No PR data yet.'), { codigo: 503 });
        return responder(res, 200, await filtrarPrs(p, foto.prs, consulta, { modo, presupuesto, forzar: forzar === true }));
      }
      if (req.method === 'POST' && url.pathname === '/api/investigar') {
        const { id, comentario, modo: modoPedido } = await leerCuerpo(req);
        const modo = modoDe(p, modoPedido);
        const pr = prDeFoto(id);
        const c = leerComentarios(p, pr.repo, pr.numero).find((x) => x.id === comentario && x.tipo === 'pregunta');
        if (!c) throw Object.assign(new Error('The question does not exist'), { codigo: 404 });
        if (!['respondido', 'error'].includes(c.estado)) throw new Error('The question is still in progress');
        if (c.headSha && c.headSha !== pr.headSha) throw new Error('The question belongs to an earlier commit of the PR');
        actualizarComentario(p, pr.repo, pr.numero, c.id, { estado: 'en_cola', investigar: true, motivo: null });
        cola.encolar([{ id: `${pr.id}:investigar:${c.id}:${Date.now()}`, tipo: 'investigar', prId: pr.id, topeUsd: topeDeTrabajo({ tipo: 'investigar', modo }), ...conRescate(pr, [c.id], () => investigarPregunta(p, pr, c.id, { modo })) }]);
        return responder(res, 202, { encolado: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/propuesta') {
        const pr = prDeFoto(url.searchParams.get('pr'));
        return responder(res, 200, leerPropuesta(p, pr.repo, pr.numero, url.searchParams.get('id')));
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/propuesta/')) {
        const { pr: prId, id, indicacion, confirmarFallos, modo: modoPedido } = await leerCuerpo(req);
        const modo = modoDe(p, modoPedido);
        const pr = prDeFoto(prId);
        leerPropuesta(p, pr.repo, pr.numero, id);
        const accion = url.pathname.slice('/api/propuesta/'.length);
        if (accion === 'ajustar') {
          if (typeof indicacion !== 'string' || !indicacion.trim() || indicacion.length > 4000) throw new Error('Instruction empty or longer than 4000 characters');
          cola.encolar([{ id: `${pr.id}:ajustar:${Date.now()}`, tipo: 'cambiar', prId: pr.id, topeUsd: topeDeTrabajo({ tipo: 'cambiar', modo }), ejecutar: () => ajustarPropuesta(p, pr, id, indicacion.trim(), { modo }) }]);
          return responder(res, 202, { encolado: true });
        }
        if (accion === 'aprobar') {
          const r = await aprobar(p, pr, id, { confirmarFallos: confirmarFallos === true });
          if (r.ok) refrescar();
          return responder(res, 200, r);
        }
        if (accion === 'descartar') return responder(res, 200, await descartar(p, pr, id));
        if (accion === 'regenerar') {
          const prop = leerPropuesta(p, pr.repo, pr.numero, id);
          if (!['conflicto', 'rechazada'].includes(prop.estado)) throw new Error('Only a conflicting or rejected proposal can be regenerated');
          if (pr.estadoPr !== 'OPEN') throw new Error('The PR is no longer open: changes cannot be requested');
          actualizarComentario(p, pr.repo, pr.numero, prop.comentarioId, { estado: 'en_cola', motivo: null });
          cola.encolar([{ id: `${pr.id}:cambiar:${Date.now()}`, tipo: 'cambiar', prId: pr.id, topeUsd: topeDeTrabajo({ tipo: 'cambiar', modo }), ...conRescate(pr, [prop.comentarioId], () => proponerCambios(p, pr, [prop.comentarioId], { modo })) }]);
          return responder(res, 202, { encolado: true });
        }
        return responder(res, 404, { error: 'Not found' });
      }
      if (req.method === 'GET' && url.pathname === '/api/entregas') {
        const datos = datosEntregas(p);
        if (!datos) return responder(res, 503, { error: 'No deliveries yet: refresh the state first.' });
        return responder(res, 200, datos);
      }
      if (req.method === 'POST' && url.pathname === '/api/entregas/ajuste') return responder(res, 200, await aplicarAjuste(p, await leerJsonEstricto(req)));
      if (req.method === 'POST' && url.pathname === '/api/entregas/cerrar') {
        const { clave } = await leerJsonEstricto(req);
        return responder(res, 200, await cerrarEntrega(p, clave));
      }
      if (req.method === 'POST' && url.pathname === '/api/visita') {
        await leerJsonEstricto(req);
        return responder(res, 200, marcarVisita(p));
      }
      if (req.method === 'POST' && url.pathname === '/api/qa/guia') {
        return responder(res, 202, { trabajo: iniciarGuia(opcionesGuia(await leerJsonEstricto(req))) });
      }
      if (req.method === 'GET' && url.pathname === '/api/qa/guia') {
        const t = trabajosGuia.get(url.searchParams.get('trabajo'));
        if (!t) return responder(res, 404, { error: 'Unknown job' });
        return responder(res, 200, { trabajo: t.id, estado: t.estado, mensaje: t.mensaje ?? null, resultado: t.resultado ?? null });
      }
      if (req.method === 'GET' && url.pathname === '/api/qa/archivo') {
        const nombre = url.searchParams.get('nombre');
        const datos = leerArchivoGuia(p, nombre);
        res.writeHead(200, {
          'Content-Type': TIPOS_GUIA[nombre.split('.').pop()],
          'Content-Length': datos.length,
          'Content-Disposition': `attachment; filename="${nombre}"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': 'sandbox',
          'Referrer-Policy': 'no-referrer',
        });
        return res.end(datos);
      }
      if (req.method === 'POST' && url.pathname === '/api/qa/importar') {
        const r = await importarQa(p, { buf: decodificarImportacion(await leerJsonEstricto(req, MAX_CUERPO_IMPORTAR)) });
        return responder(res, 200, { ...r, rastreador: rastreadorPublico(r.rastreador) });
      }
      if (req.method === 'GET' && url.pathname === '/api/qa/rastreador') {
        const cfg = p.qa?.rastreador;
        if (!cfg) return responder(res, 200, { configurado: false, pendientes: 0, muestra: [] });
        try {
          const cambios = cambiosPendientes(cfg, ...datosRastreador());
          return responder(res, 200, { configurado: true, pendientes: cambios.length, muestra: cambios.slice(0, 20) });
        } catch (e) {
          const seguro = typeof e?.codigo === 'string' && String(e.message).startsWith('[seki-review/');
          return responder(res, 200, { configurado: true, pendientes: 0, muestra: [], aviso: seguro ? e.message.slice(0, 300) : 'The tracker could not be read' });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/qa/rastreador') {
        if (Object.keys(await leerJsonEstricto(req)).length) throw falloHttp(400, 'The body must be an empty object');
        return responder(res, 200, rastreadorPublico(await enSerieEntregas(() => aplicarRastreador(p, ...datosRastreador()))));
      }
      if (req.method === 'GET' && url.pathname === '/api/foto') return responder(res, 200, fotoConExplicaciones(p));
      if (req.method === 'GET' && url.pathname === '/api/diff') {
        const pr = fotoConExplicaciones(p).prs.find((x) => x.id === url.searchParams.get('id'));
        if (!pr) return responder(res, 404, { error: 'PR not in the snapshot' });
        return responder(res, 200, diffParaTablero(await asegurarDiff(p, pr.repo, pr.numero, pr.headSha)));
      }
      if (req.method === 'GET' && url.pathname === '/api/estado') {
        if (req.headers['x-seki-tablero'] === '1') ultimoTablero = Date.now();
        return responder(res, 200, { vigia: vigia.estado(), refrescando: refrescando(), ultimoRefresco, trabajos: [...cola.lista(), ...listaGuias()], comentarios: marcasComentarios(), avances: avances(), costoHoy: costosDelDia(p), presupuesto: presupuesto.estado(), modo, version: VERSION });
      }
      if (req.method === 'POST' && url.pathname === '/api/refrescar') {
        refrescar();
        return responder(res, 202, { refrescando: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/revisar') {
        const { enlace } = await leerJsonEstricto(req);
        const r = await incorporarEnlace(p, enlace).catch(errorRevisar);
        let enFoto = false;
        try { enFoto = !!leerJson(rutaInstantanea(p.salida))?.prs?.some((x) => x.id === r.id); } catch { /* unreadable: refreshed below */ }
        if (r.estado === 'agregada' || !enFoto) refrescarRepo(r.repo);
        return responder(res, 202, { id: r.id, estado: r.estado });
      }
      if (req.method === 'POST' && url.pathname === '/api/revisar/quitar') {
        const { id } = await leerJsonEstricto(req);
        const m = typeof id === 'string' && id.length <= 200 ? /^([\w.-]+)#\d+$/.exec(id) : null;
        if (!m) throw falloHttp(400, 'The PR id must look like repo#number');
        if (!quitarRevisar(p, id)) throw falloHttp(404, 'The PR is not in the To review list');
        if (p.repos[m[1]]) refrescarRepo(m[1]);
        return responder(res, 202, { id, quitada: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/analizar') {
        const { prs = [], completar = false, modo: modoPedido } = await leerCuerpo(req);
        const modo = modoDe(p, modoPedido);
        const validas = fotoConExplicaciones(p).prs;
        const pedidas = validas.filter((v) => prs.some((x) => v.repo === x.repo && v.numero === x.numero));
        // Saving mode reuses an explanation that already covers the current commit.
        const reutilizadas = modo === 'ahorro' && completar !== true ? pedidas.filter((v) => v.explicacion && !v.explicacion.desactualizada) : [];
        const items = pedidas
          .filter((v) => !reutilizadas.includes(v))
          .map((pr) => ({ id: pr.id, tipo: 'explicar', prId: pr.id, topeUsd: topeDeTrabajo({ tipo: 'explicar', modo, completar: completar === true }), ejecutar: () => explicarConIa(p, pr, { completar: completar === true, modo }) }));
        return responder(res, 202, { encolados: cola.encolar(items), reutilizados: reutilizadas.length });
      }
      if (req.method === 'GET' && url.pathname === '/api/ultra') {
        const pr = prDeFoto(`${url.searchParams.get('repo')}#${url.searchParams.get('numero')}`);
        return responder(res, 200, datosUltra(p, pr, nombresDeArchivos(p, pr)));
      }
      if (req.method === 'POST' && url.pathname === '/api/ultra') {
        const { repo, numero, repetir, modo: modoPedido, confirmar } = await leerJsonEstricto(req);
        if (confirmar !== true) throw Object.assign(new Error('The Ultra review must be confirmed'), { codigo: 400 });
        let pr;
        try { pr = prDeFoto(`${repo}#${numero}`); } catch { throw Object.assign(new Error('The PR is not in the snapshot'), { codigo: 409 }); }
        if (modoDe(p, modoPedido) === 'ahorro') throw Object.assign(new Error('Ultra review is not available in saving mode'), { codigo: 409 });
        if (pr.estadoPr !== 'OPEN') throw Object.assign(new Error('The PR is no longer open'), { codigo: 409 });
        // A stored result for this commit is returned as is: no job, no reservation, no spend.
        const guardado = repetir === true ? null : leerUltra(p, pr.repo, pr.numero, pr.headSha);
        if (guardado && !guardado.desactualizada) return responder(res, 200, { desdeCache: true, resultado: guardado });
        const n = cola.encolar([{ id: `${pr.id}:ultra`, tipo: 'revisar_ultra', prId: pr.id, topeUsd: topeRevisarUltra(), ejecutar: () => ejecutarUltra(p, pr, { repetir: repetir === true }) }]);
        if (!n) throw Object.assign(new Error('An Ultra review of this PR is already queued'), { codigo: 409 });
        return responder(res, 202, { encolado: `${pr.id}:ultra` });
      }
      // The selection is the core of the templates tab and sets the job reservation: it uses the PR diff (the job
      // fetches it anyway), and the cached file names only if GitHub cannot be reached.
      const rutasPlantillas = async (pr) => {
        try { return (await asegurarDiff(p, pr.repo, pr.numero, pr.headSha)).map((a) => a.filename).filter(Boolean); } catch { return nombresDeArchivos(p, pr); }
      };
      if (req.method === 'GET' && url.pathname === '/api/plantillas') {
        const pr = prDeFoto(`${url.searchParams.get('repo')}#${url.searchParams.get('numero')}`);
        return responder(res, 200, datosPlantillas(p, pr, await rutasPlantillas(pr)));
      }
      // Allowed in every AI mode: the template calls always use their own profile. A selection without AI items
      // is queued too, at cap 0: the job runs only the deterministic part.
      if (req.method === 'POST' && url.pathname === '/api/plantillas') {
        const { repo, numero, repetir, confirmar } = await leerJsonEstricto(req);
        if (confirmar !== true) throw falloHttp(400, 'The template review must be confirmed');
        let pr;
        try { pr = prDeFoto(`${repo}#${numero}`); } catch { throw falloHttp(409, 'The PR is not in the snapshot'); }
        if (pr.estadoPr !== 'OPEN') throw falloHttp(409, 'The PR is no longer open');
        // A stored result for this commit is returned as is: no job, no reservation, no spend.
        const guardado = repetir === true ? null : leerPlantillasPr(p, pr.repo, pr.numero, pr.headSha);
        if (guardado && !guardado.desactualizada) return responder(res, 200, { desdeCache: true, resultado: guardado });
        const { topeUsd } = datosPlantillas(p, pr, await rutasPlantillas(pr));
        const id = `${pr.id}:plantillas`;
        const n = cola.encolar([{ id, tipo: 'revisar_plantillas', prId: pr.id, topeUsd, ejecutar: () => ejecutarPlantillas(p, pr, { repetir: repetir === true }) }]);
        if (!n) throw falloHttp(409, 'A template review of this PR is already queued');
        return responder(res, 202, { encolado: id });
      }
      if (req.method === 'POST' && url.pathname === '/api/trabajos/forzar') {
        const { id } = await leerJsonEstricto(req);
        if (typeof id !== 'string' || !cola.forzar(id)) throw Object.assign(new Error('No blocked job with that id'), { codigo: 404 });
        return responder(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/cancelar-cola') return responder(res, 200, { cancelados: cola.vaciar() });
      // Another session with another version asks for the port: release it only if no jobs would be cut off.
      if (req.method === 'POST' && url.pathname === '/api/ceder') {
        if (refrescando() || vigia.ocupado() || guiaEnCurso() || cola.lista().some((t) => ['en_cola', 'bloqueado_presupuesto', 'en_curso'].includes(t.estado))) return responder(res, 409, { error: 'Jobs in progress' });
        responder(res, 200, { ok: true });
        cerrar();
        return;
      }
      return responder(res, 404, { error: 'Not found' });
    } catch (e) {
      const c = e.codigo;
      if (Number.isInteger(c) && c >= 400 && c <= 599) return responder(res, c, { error: e.message, ...(e.forzar ? { forzar: true } : {}) });
      if (typeof c === 'string') return responder(res, 400, { error: e.message });
      // An untagged failure on a QA route is internal: its message may carry paths or cell contents.
      if (url.pathname.startsWith('/api/qa/')) {
        console.error(`[seki-review/qa] Internal failure on ${req.method} ${url.pathname}: ${e?.code ?? 'error'}`);
        return responder(res, 500, { error: 'Internal error' });
      }
      return responder(res, 400, { error: e.message });
    }
  });

  // Stops serving at once; resolves when the watcher cycle, the refreshes (a cycle may start one), the copy clean-up
  // and the running jobs have finished. Queued jobs are cancelled.
  const cerrar = async () => {
    const ciclo = vigia.detener();
    servidores.delete(proyecto);
    const cerrado = new Promise((ok) => servidor.close(() => ok()));
    servidor.closeAllConnections?.();
    await Promise.all([cerrado, ciclo, cola.detener(), guiaActiva?.promesa]);
    while (refrescando()) await (pendiente?.promesa ?? refresco);
    await limpieza;
    presupuesto.soltar();
  };
  const escuchar = (n) => new Promise((ok, falla) => {
    servidor.once('error', falla);
    servidor.listen(n, '127.0.0.1', () => { servidor.off('error', falla); ok(servidor.address().port); });
  });
  // After handing over, the port may take a moment to become free.
  const conReintento = async (n, intentos = 10) => {
    try { return await escuchar(n); } catch (e) {
      if (e.code !== 'EADDRINUSE' || intentos <= 1) throw e;
      await new Promise((ok) => setTimeout(ok, 200));
      return conReintento(n, intentos - 1);
    }
  };
  const real = await conReintento(puerto, otro ? 10 : 1).catch((e) => (e.code === 'EADDRINUSE' && !soloPuerto ? escuchar(0) : Promise.reject(e)));
  const url = `http://127.0.0.1:${real}/?t=${token}`;
  servidor.on('close', () => vigia.detener());
  vigia.iniciar();
  servidores.set(proyecto, { url, servidor, cerrar });
  if (abrir && process.platform === 'darwin') execFile('open', [url]);
  return { url, yaEstaba: false };
}
