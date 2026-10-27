// Cola de análisis con IA: cada trabajo lanza `claude -p` en modo no interactivo con solo las
// herramientas de pw-revision y de lectura, para que pueda explicar la PR pero no tocar archivos.
import { spawn } from 'node:child_process';

const HERRAMIENTAS = ['mcp__plugin_pw-revision_pw-revision', 'Read', 'Grep', 'Glob'].join(' ');
const LIMITE_MS = 10 * 60 * 1000;
const PARALELO = Math.min(2, Math.max(1, Number(process.env.PW_IA_PARALELO) || 1));

const prompt = (repo, numero, proyecto) =>
  `Usar la skill revisar-prs del plugin pw-revision para explicar la PR ${repo}#${numero} del proyecto ${proyecto}. ` +
  'Llamar pr_detalle y pr_verificaciones, leer solo lo necesario del checkout local y guardar con pr_guardar_explicacion, ' +
  'incluidos esfuerzo y orden_lectura, y diagrama solo si cambia un flujo. No modificar archivos, no hacer commits ni push. ' +
  'Responder en una línea: "listo" o el motivo por el que no se pudo.';

export function crearCola({ proyecto, cwd, alTerminar }) {
  const trabajos = new Map();
  let activos = 0;

  function siguiente() {
    while (activos < PARALELO) {
      const t = [...trabajos.values()].find((x) => x.estado === 'en_cola');
      if (!t) return;
      ejecutar(t);
    }
  }

  function ejecutar(t) {
    activos++;
    Object.assign(t, { estado: 'en_curso', inicio: new Date().toISOString() });
    const args = ['-p', prompt(t.repo, t.numero, proyecto), '--model', process.env.PW_IA_MODELO ?? 'sonnet', '--allowedTools', HERRAMIENTAS, '--max-turns', '40', '--output-format', 'json'];
    const hijo = spawn(process.env.PW_CLAUDE ?? 'claude', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let salida = '';
    let errores = '';
    hijo.stdout.on('data', (d) => { salida += d; });
    hijo.stderr.on('data', (d) => { errores += d; });
    const reloj = setTimeout(() => hijo.kill('SIGTERM'), LIMITE_MS);
    const cerrar = (codigo) => {
      clearTimeout(reloj);
      activos--;
      let r = null;
      try { r = JSON.parse(salida.trim().split('\n').pop()); } catch { /* salida no JSON */ }
      const texto = (r?.result ?? errores ?? '').trim();
      const ok = codigo === 0 && r && !r.is_error && /listo/i.test(texto);
      Object.assign(t, {
        estado: ok ? 'terminado' : 'error',
        fin: new Date().toISOString(),
        mensaje: ok ? null : (texto || `claude terminó con código ${codigo}`).slice(0, 400),
        costo: r?.total_cost_usd ?? null,
      });
      alTerminar?.(t);
      siguiente();
    };
    hijo.on('close', cerrar);
    hijo.on('error', (e) => { errores = e.message; cerrar(-1); });
  }

  return {
    encolar(items) {
      let n = 0;
      for (const { repo, numero } of items) {
        const id = `${repo}#${numero}`;
        const previo = trabajos.get(id);
        if (previo && (previo.estado === 'en_cola' || previo.estado === 'en_curso')) continue;
        trabajos.set(id, { id, repo, numero, estado: 'en_cola', encolado: new Date().toISOString() });
        n++;
      }
      siguiente();
      return n;
    },
    vaciar() {
      let n = 0;
      for (const t of trabajos.values()) if (t.estado === 'en_cola') { t.estado = 'cancelado'; n++; }
      return n;
    },
    lista: () => [...trabajos.values()],
  };
}
