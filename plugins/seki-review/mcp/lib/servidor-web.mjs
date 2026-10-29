// Serves the dashboard on 127.0.0.1 with actions: refresh the state (GitHub + git, no AI) and
// analyze PRs with AI. It only serves this machine and requires the URL token on every call.
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { proyecto as cargarProyecto } from './config.mjs';
import { recolectar } from './recolectar.mjs';
import { construirHtml, fotoConExplicaciones, versionEnDisco } from './tablero.mjs';

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
import { estadoServidor, pedirCeder, tokenDe } from './acceso.mjs';
import { limpiarCopias } from './copias.mjs';

const PUERTO = 4317;
const MAX_CUERPO = 64 * 1024;

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
  let revisando = false;
  const reloj = setInterval(async () => {
    if (servidores.has(proyecto)) { clearInterval(reloj); vigilantes.delete(proyecto); return; }
    if (revisando) return;
    revisando = true;
    try { await iniciarServidor({ proyecto, puerto, abrir: false, soloPuerto: true }); } catch { /* another session won the port; keep watching */ }
    revisando = false;
  }, Number(process.env.SEKI_VIGILANCIA_MS) || 5000);
  reloj.unref();
  vigilantes.set(proyecto, reloj);
}

export async function iniciarServidor({ proyecto, puerto = PUERTO, abrir = true, soloPuerto = false } = {}) {
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

  const refrescar = () => {
    refresco ??= recolectar({ proyecto }).then(
      (f) => {
        ultimoRefresco = { ok: true, fecha: f.generado };
        // Copies of closed PRs or unused for a week are deleted; traceability stays in the comments.
        limpiarCopias(p, { abiertas: new Set(f.prs.filter((x) => x.estadoPr === 'OPEN').map((x) => x.id)) }).catch(() => {});
      },
      (e) => { ultimoRefresco = { ok: false, fecha: new Date().toISOString(), mensaje: e.message.slice(0, 300) }; },
    ).finally(() => { refresco = null; });
    return refresco;
  };

  const cola = crearCola();
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
    if (req.headers['x-seki-token'] !== token) return responder(res, 403, { error: 'Invalid token' });

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
        const { id, ids = [] } = await leerCuerpo(req);
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
        if (preguntas.length) cola.encolar([{ id: `${pr.id}:responder:${ahora}`, tipo: 'responder', prId: pr.id, ...conRescate(pr, preguntas, () => responderPreguntas(p, pr, preguntas)) }]);
        if (cambios.length) cola.encolar([{ id: `${pr.id}:cambiar:${ahora}`, tipo: 'cambiar', prId: pr.id, ...conRescate(pr, cambios, () => proponerCambios(p, pr, cambios)) }]);
        for (const cid of investigar) cola.encolar([{ id: `${pr.id}:investigar:${cid}:${ahora}`, tipo: 'investigar', prId: pr.id, ...conRescate(pr, [cid], () => investigarPregunta(p, pr, cid)) }]);
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
        registrarCosto(p, { tipo: 'valoracion', prId: pr.id, comentario: c.id, modelo: c.modelo, investigado: !!c.investigado, util, costo: 0 });
        return responder(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/costos') return responder(res, 200, resumenCostos(p));
      if (req.method === 'POST' && url.pathname === '/api/filtrar') {
        const { consulta } = await leerCuerpo(req);
        const foto = fotoConExplicaciones(p);
        if (!foto) throw Object.assign(new Error('No PR data yet.'), { codigo: 503 });
        return responder(res, 200, await filtrarPrs(p, foto.prs, consulta));
      }
      if (req.method === 'POST' && url.pathname === '/api/investigar') {
        const { id, comentario } = await leerCuerpo(req);
        const pr = prDeFoto(id);
        const c = leerComentarios(p, pr.repo, pr.numero).find((x) => x.id === comentario && x.tipo === 'pregunta');
        if (!c) throw Object.assign(new Error('The question does not exist'), { codigo: 404 });
        if (!['respondido', 'error'].includes(c.estado)) throw new Error('The question is still in progress');
        if (c.headSha && c.headSha !== pr.headSha) throw new Error('The question belongs to an earlier commit of the PR');
        actualizarComentario(p, pr.repo, pr.numero, c.id, { estado: 'en_cola', investigar: true, motivo: null });
        cola.encolar([{ id: `${pr.id}:investigar:${c.id}:${Date.now()}`, tipo: 'investigar', prId: pr.id, ...conRescate(pr, [c.id], () => investigarPregunta(p, pr, c.id)) }]);
        return responder(res, 202, { encolado: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/propuesta') {
        const pr = prDeFoto(url.searchParams.get('pr'));
        return responder(res, 200, leerPropuesta(p, pr.repo, pr.numero, url.searchParams.get('id')));
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/propuesta/')) {
        const { pr: prId, id, indicacion, confirmarFallos } = await leerCuerpo(req);
        const pr = prDeFoto(prId);
        leerPropuesta(p, pr.repo, pr.numero, id);
        const accion = url.pathname.slice('/api/propuesta/'.length);
        if (accion === 'ajustar') {
          if (typeof indicacion !== 'string' || !indicacion.trim() || indicacion.length > 4000) throw new Error('Instruction empty or longer than 4000 characters');
          cola.encolar([{ id: `${pr.id}:ajustar:${Date.now()}`, tipo: 'cambiar', prId: pr.id, ejecutar: () => ajustarPropuesta(p, pr, id, indicacion.trim()) }]);
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
          cola.encolar([{ id: `${pr.id}:cambiar:${Date.now()}`, tipo: 'cambiar', prId: pr.id, ...conRescate(pr, [prop.comentarioId], () => proponerCambios(p, pr, [prop.comentarioId])) }]);
          return responder(res, 202, { encolado: true });
        }
        return responder(res, 404, { error: 'Not found' });
      }
      if (req.method === 'GET' && url.pathname === '/api/foto') return responder(res, 200, fotoConExplicaciones(p));
      if (req.method === 'GET' && url.pathname === '/api/diff') {
        const pr = fotoConExplicaciones(p).prs.find((x) => x.id === url.searchParams.get('id'));
        if (!pr) return responder(res, 404, { error: 'PR not in the snapshot' });
        return responder(res, 200, diffParaTablero(await asegurarDiff(p, pr.repo, pr.numero, pr.headSha)));
      }
      if (req.method === 'GET' && url.pathname === '/api/estado') {
        return responder(res, 200, { refrescando: !!refresco, ultimoRefresco, trabajos: cola.lista(), comentarios: marcasComentarios(), avances: avances(), costoHoy: costosDelDia(p), version: VERSION });
      }
      if (req.method === 'POST' && url.pathname === '/api/refrescar') {
        refrescar();
        return responder(res, 202, { refrescando: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/analizar') {
        const { prs = [], completar = false } = await leerCuerpo(req);
        const validas = fotoConExplicaciones(p).prs;
        const items = validas
          .filter((v) => prs.some((x) => v.repo === x.repo && v.numero === x.numero))
          .map((pr) => ({ id: pr.id, tipo: 'explicar', prId: pr.id, ejecutar: () => explicarConIa(p, pr, { completar: completar === true }) }));
        return responder(res, 202, { encolados: cola.encolar(items) });
      }
      if (req.method === 'POST' && url.pathname === '/api/cancelar-cola') return responder(res, 200, { cancelados: cola.vaciar() });
      // Another session with another version asks for the port: release it only if no jobs would be cut off.
      if (req.method === 'POST' && url.pathname === '/api/ceder') {
        if (refresco || cola.lista().some((t) => t.estado === 'en_cola' || t.estado === 'en_curso')) return responder(res, 409, { error: 'Jobs in progress' });
        responder(res, 200, { ok: true });
        servidores.delete(proyecto);
        servidor.close();
        servidor.closeAllConnections?.();
        return;
      }
      return responder(res, 404, { error: 'Not found' });
    } catch (e) {
      return responder(res, e.codigo ?? 400, { error: e.message });
    }
  });

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
  servidores.set(proyecto, { url, servidor });
  if (abrir && process.platform === 'darwin') execFile('open', [url]);
  return { url, yaEstaba: false };
}
