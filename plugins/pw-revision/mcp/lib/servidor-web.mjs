// Sirve el tablero en 127.0.0.1 con acciones: actualizar el estado (GitHub + git, sin IA) y
// analizar PRs con IA. Solo atiende a este equipo y exige el token de la URL en cada llamada.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { proyecto as cargarProyecto } from './config.mjs';
import { recolectar } from './recolectar.mjs';
import { construirHtml, fotoConExplicaciones } from './tablero.mjs';
import { crearCola } from './trabajos.mjs';

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
  const espacio = p.espacio ? p.espacio.replace(/^~\//, `${process.env.HOME}/`) : dirname(p.salida);
  let refresco = null;
  let ultimoRefresco = null;

  const refrescar = () => {
    refresco ??= recolectar({ proyecto }).then(
      (f) => { ultimoRefresco = { ok: true, fecha: f.generado }; },
      (e) => { ultimoRefresco = { ok: false, fecha: new Date().toISOString(), mensaje: e.message.slice(0, 300) }; },
    ).finally(() => { refresco = null; });
    return refresco;
  };

  const cola = crearCola({ proyecto, cwd: espacio });

  const servidor = createServer(async (req, res) => {
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return responder(res, 421, { error: 'Host no permitido' });
    const url = new URL(req.url, `http://${host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      if (url.searchParams.get('t') !== token) return responder(res, 403, 'Falta el token de acceso. Abra el enlace que entregó pw-revision.', 'text/plain; charset=utf-8');
      const foto = fotoConExplicaciones(p);
      if (!foto) return responder(res, 503, 'Todavía no hay datos: actualice el estado desde Claude Code.', 'text/plain; charset=utf-8');
      return responder(res, 200, construirHtml(foto, { token }), 'text/html; charset=utf-8');
    }

    if (!url.pathname.startsWith('/api/')) return responder(res, 404, { error: 'No existe' });
    if (req.headers['x-pw-token'] !== token) return responder(res, 403, { error: 'Token inválido' });

    try {
      if (req.method === 'GET' && url.pathname === '/api/foto') return responder(res, 200, fotoConExplicaciones(p));
      if (req.method === 'GET' && url.pathname === '/api/estado') {
        return responder(res, 200, { refrescando: !!refresco, ultimoRefresco, trabajos: cola.lista() });
      }
      if (req.method === 'POST' && url.pathname === '/api/refrescar') {
        refrescar();
        return responder(res, 202, { refrescando: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/analizar') {
        const { prs = [] } = await leerCuerpo(req);
        const validas = fotoConExplicaciones(p).prs;
        const items = prs
          .filter((x) => validas.some((v) => v.repo === x.repo && v.numero === x.numero))
          .map(({ repo, numero }) => ({ repo, numero }));
        return responder(res, 202, { encolados: cola.encolar(items) });
      }
      if (req.method === 'POST' && url.pathname === '/api/cancelar-cola') return responder(res, 200, { cancelados: cola.vaciar() });
      return responder(res, 404, { error: 'No existe' });
    } catch (e) {
      return responder(res, 400, { error: e.message });
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
