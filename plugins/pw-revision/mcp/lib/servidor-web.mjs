// Sirve el tablero en 127.0.0.1 con acciones: actualizar el estado (GitHub + git, sin IA) y
// analizar PRs con IA. Solo atiende a este equipo y exige el token de la URL en cada llamada.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { proyecto as cargarProyecto } from './config.mjs';
import { recolectar } from './recolectar.mjs';
import { construirHtml, fotoConExplicaciones } from './tablero.mjs';
import { crearCola } from './trabajos.mjs';
import { asegurarDiff, diffParaTablero } from './diffs.mjs';
import { actualizarComentario, guardarComentarios, leerComentarios, marcasComentarios } from './comentarios.mjs';
import { responderPreguntas } from './preguntas.mjs';
import { explicarConIa } from './explicar.mjs';
import { costosDelDia } from './ia.mjs';

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
  const token = randomBytes(18).toString('base64url');
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
        const pedidos = new Set(ids);
        const enviables = leerComentarios(p, pr.repo, pr.numero).filter((c) => pedidos.has(c.id) && (c.estado === 'borrador' || c.estado === 'error'));
        const preguntas = enviables.filter((c) => c.tipo === 'pregunta').map((c) => c.id);
        const cambios = enviables.filter((c) => c.tipo === 'cambio').map((c) => c.id);
        if (cambios.length) throw new Error('Pedir cambio todavía no está disponible');
        for (const cid of preguntas) actualizarComentario(p, pr.repo, pr.numero, cid, { estado: 'en_cola', motivo: null });
        if (preguntas.length) cola.encolar([{ id: `${pr.id}:responder:${Date.now()}`, tipo: 'responder', prId: pr.id, ejecutar: () => responderPreguntas(p, pr, preguntas) }]);
        return responder(res, 202, { preguntas: preguntas.length, cambios: cambios.length });
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
