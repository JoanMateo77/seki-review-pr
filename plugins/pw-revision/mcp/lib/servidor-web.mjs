// Sirve el tablero en 127.0.0.1 con acciones: actualizar el estado (GitHub + git, sin IA) y
// analizar PRs con IA. Solo atiende a este equipo y exige el token de la URL en cada llamada.
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { proyecto as cargarProyecto } from './config.mjs';
import { recolectar } from './recolectar.mjs';
import { construirHtml, fotoConExplicaciones } from './tablero.mjs';
import { crearCola } from './trabajos.mjs';
import { asegurarDiff, diffParaTablero } from './diffs.mjs';
import { actualizarComentario, guardarComentarios, leerComentarios, marcasComentarios, recuperarInterrumpidos, rescatarPendientes, separarEnviables } from './comentarios.mjs';
import { investigarPregunta, responderPreguntas } from './preguntas.mjs';
import { ajustarPropuesta, aprobar, descartar, leerPropuesta, proponerCambios } from './propuestas.mjs';
import { explicarConIa } from './explicar.mjs';
import { costosDelDia } from './ia.mjs';
import { servidorActivo, tokenDe } from './acceso.mjs';

const PUERTO = 4317;
const MAX_CUERPO = 64 * 1024;

const servidores = new Map();

function leerCuerpo(req) {
  return new Promise((ok, falla) => {
    let datos = '';
    req.on('data', (d) => {
      datos += d;
      if (datos.length > MAX_CUERPO) { falla(new Error('Cuerpo demasiado grande')); req.destroy(); }
    });
    req.on('end', () => { try { ok(datos ? JSON.parse(datos) : {}); } catch { falla(new Error('JSON inválido')); } });
  });
}

const responder = (res, codigo, cuerpo, tipo = 'application/json; charset=utf-8') => {
  res.writeHead(codigo, { 'Content-Type': tipo, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo));
};

export async function iniciarServidor({ proyecto = 'demo', puerto = PUERTO, abrir = true } = {}) {
  if (servidores.has(proyecto)) {
    const s = servidores.get(proyecto);
    if (abrir) execFile('open', [s.url]);
    return { url: s.url, yaEstaba: true };
  }
  const p = cargarProyecto(proyecto);
  const token = tokenDe(p);
  if (await servidorActivo(puerto, token)) {
    const url = `http://127.0.0.1:${puerto}/?t=${token}`;
    if (abrir && process.platform === 'darwin') execFile('open', [url]);
    return { url, yaEstaba: true };
  }
  let refresco = null;
  let ultimoRefresco = null;

  const refrescar = () => {
    refresco ??= recolectar({ proyecto }).then(
      (f) => { ultimoRefresco = { ok: true, fecha: f.generado }; },
      (e) => { ultimoRefresco = { ok: false, fecha: new Date().toISOString(), mensaje: e.message.slice(0, 300) }; },
    ).finally(() => { refresco = null; });
    return refresco;
  };

  const cola = crearCola();
  recuperarInterrumpidos(p);
  // Lo que un trabajo deje en cola o en curso al fallar o al cancelarse vuelve a quedar enviable.
  const conRescate = (pr, ids, ejecutar) => ({
    ejecutar: async () => {
      try { return await ejecutar(); } finally { rescatarPendientes(p, pr.repo, pr.numero, ids, { estado: 'error', motivo: 'El trabajo terminó sin completar este comentario' }); }
    },
    alCancelar: () => rescatarPendientes(p, pr.repo, pr.numero, ids, { estado: 'borrador', motivo: null }),
  });

  const servidor = createServer(async (req, res) => {
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return responder(res, 421, { error: 'Host no permitido' });
    const url = new URL(req.url, `http://${host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      if (url.searchParams.get('t') !== token) return responder(res, 403, 'Falta el token de acceso. Abra el enlace que entregó pw-revision.', 'text/plain; charset=utf-8');
      const foto = fotoConExplicaciones(p);
      if (!foto) return responder(res, 503, 'Todavía no hay datos: actualice el estado desde Claude Code.', 'text/plain; charset=utf-8');
      return responder(res, 200, construirHtml(p, foto, { token }), 'text/html; charset=utf-8');
    }

    if (!url.pathname.startsWith('/api/')) return responder(res, 404, { error: 'No existe' });
    if (req.headers['x-pw-token'] !== token) return responder(res, 403, { error: 'Token inválido' });

    const prDeFoto = (id) => {
      const pr = fotoConExplicaciones(p)?.prs.find((x) => x.id === id);
      if (!pr) throw Object.assign(new Error('PR fuera de la foto'), { codigo: 404 });
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
        if (!Array.isArray(comentarios) || !Array.isArray(borrados)) throw new Error('comentarios y borrados deben ser listas');
        return responder(res, 200, guardarComentarios(p, pr.repo, pr.numero, comentarios, borrados));
      }
      if (req.method === 'POST' && url.pathname === '/api/enviar-revision') {
        const { id, ids = [] } = await leerCuerpo(req);
        const pr = prDeFoto(id);
        if (!Array.isArray(ids)) throw new Error('ids debe ser una lista');
        const lista = leerComentarios(p, pr.repo, pr.numero);
        const { preguntas: todas, cambios, desactualizados } = separarEnviables(lista, ids, pr.headSha);
        const conCodigo = new Set(lista.filter((c) => c.investigar).map((c) => c.id));
        const preguntas = todas.filter((cid) => !conCodigo.has(cid));
        const investigar = todas.filter((cid) => conCodigo.has(cid));
        if (cambios.length && pr.estadoPr !== 'OPEN') throw new Error('La PR ya no está abierta: no se pueden pedir cambios');
        for (const cid of [...todas, ...cambios]) actualizarComentario(p, pr.repo, pr.numero, cid, { estado: 'en_cola', motivo: null });
        const ahora = Date.now();
        if (preguntas.length) cola.encolar([{ id: `${pr.id}:responder:${ahora}`, tipo: 'responder', prId: pr.id, ...conRescate(pr, preguntas, () => responderPreguntas(p, pr, preguntas)) }]);
        if (cambios.length) cola.encolar([{ id: `${pr.id}:cambiar:${ahora}`, tipo: 'cambiar', prId: pr.id, ...conRescate(pr, cambios, () => proponerCambios(p, pr, cambios)) }]);
        for (const cid of investigar) cola.encolar([{ id: `${pr.id}:investigar:${cid}:${ahora}`, tipo: 'investigar', prId: pr.id, ...conRescate(pr, [cid], () => investigarPregunta(p, pr, cid)) }]);
        return responder(res, 202, { preguntas: todas.length, cambios: cambios.length, desactualizados: desactualizados.length });
      }
      if (req.method === 'POST' && url.pathname === '/api/investigar') {
        const { id, comentario } = await leerCuerpo(req);
        const pr = prDeFoto(id);
        const c = leerComentarios(p, pr.repo, pr.numero).find((x) => x.id === comentario && x.tipo === 'pregunta');
        if (!c) throw Object.assign(new Error('La pregunta no existe'), { codigo: 404 });
        if (!['respondido', 'error'].includes(c.estado)) throw new Error('La pregunta todavía está en curso');
        if (c.headSha && c.headSha !== pr.headSha) throw new Error('La pregunta es de un commit anterior de la PR');
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
          if (typeof indicacion !== 'string' || !indicacion.trim() || indicacion.length > 4000) throw new Error('Indicación vacía o de más de 4000 caracteres');
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
          if (!['conflicto', 'rechazada'].includes(prop.estado)) throw new Error('Solo se regenera una propuesta en conflicto o rechazada');
          if (pr.estadoPr !== 'OPEN') throw new Error('La PR ya no está abierta: no se pueden pedir cambios');
          actualizarComentario(p, pr.repo, pr.numero, prop.comentarioId, { estado: 'en_cola', motivo: null });
          cola.encolar([{ id: `${pr.id}:cambiar:${Date.now()}`, tipo: 'cambiar', prId: pr.id, ...conRescate(pr, [prop.comentarioId], () => proponerCambios(p, pr, [prop.comentarioId])) }]);
          return responder(res, 202, { encolado: true });
        }
        return responder(res, 404, { error: 'No existe' });
      }
      if (req.method === 'GET' && url.pathname === '/api/foto') return responder(res, 200, fotoConExplicaciones(p));
      if (req.method === 'GET' && url.pathname === '/api/diff') {
        const pr = fotoConExplicaciones(p).prs.find((x) => x.id === url.searchParams.get('id'));
        if (!pr) return responder(res, 404, { error: 'PR fuera de la foto' });
        return responder(res, 200, diffParaTablero(await asegurarDiff(p, pr.repo, pr.numero, pr.headSha)));
      }
      if (req.method === 'GET' && url.pathname === '/api/estado') {
        return responder(res, 200, { refrescando: !!refresco, ultimoRefresco, trabajos: cola.lista(), comentarios: marcasComentarios(), costoHoy: costosDelDia(p) });
      }
      if (req.method === 'POST' && url.pathname === '/api/refrescar') {
        refrescar();
        return responder(res, 202, { refrescando: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/analizar') {
        const { prs = [] } = await leerCuerpo(req);
        const validas = fotoConExplicaciones(p).prs;
        const items = validas
          .filter((v) => prs.some((x) => v.repo === x.repo && v.numero === x.numero))
          .map((pr) => ({ id: pr.id, tipo: 'explicar', prId: pr.id, ejecutar: () => explicarConIa(p, pr) }));
        return responder(res, 202, { encolados: cola.encolar(items) });
      }
      if (req.method === 'POST' && url.pathname === '/api/cancelar-cola') return responder(res, 200, { cancelados: cola.vaciar() });
      return responder(res, 404, { error: 'No existe' });
    } catch (e) {
      return responder(res, e.codigo ?? 400, { error: e.message });
    }
  });

  const escuchar = (n) => new Promise((ok, falla) => {
    servidor.once('error', falla);
    servidor.listen(n, '127.0.0.1', () => { servidor.off('error', falla); ok(servidor.address().port); });
  });
  const real = await escuchar(puerto).catch((e) => (e.code === 'EADDRINUSE' ? escuchar(0) : Promise.reject(e)));
  const url = `http://127.0.0.1:${real}/?t=${token}`;
  servidores.set(proyecto, { url, servidor });
  if (abrir && process.platform === 'darwin') execFile('open', [url]);
  return { url, yaEstaba: false };
}
