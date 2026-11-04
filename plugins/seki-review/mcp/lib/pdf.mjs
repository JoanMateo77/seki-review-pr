// HTML to PDF with headless Chrome. One render at a time: Chrome is heavy and each run uses its own profile.
// A failure carries the child pid and the profile path (removed on return) so callers can verify the cleanup.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expandir } from './config.mjs';

const CANDIDATOS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const esArchivo = (ruta) => {
  try {
    return statSync(ruta).isFile();
  } catch {
    return false;
  }
};

export function rutaChrome(p) {
  // A configured path is never replaced by an auto-detected browser: if it is missing there is no Chrome.
  if (p?.qa?.chrome) {
    const propia = expandir(p.qa.chrome);
    return esArchivo(propia) ? propia : null;
  }
  return CANDIDATOS.find(esArchivo) ?? null;
}

let turno = Promise.resolve();
const enTurno = (fn) => { const t = turno.then(fn, fn); turno = t.catch(() => {}); return t; };

const tieneContenido = (ruta) => {
  try {
    return statSync(ruta).size > 0;
  } catch {
    return false;
  }
};

// Detached child = its own process group: helpers that outlive the browser die with the group.
function matar(hijo) {
  try {
    process.kill(-hijo.pid, 'SIGKILL');
  } catch {
    try {
      hijo.kill('SIGKILL');
    } catch { /* already gone */ }
  }
}

export function htmlAPdf(chrome, html, pdf, { limiteMs = 60_000, senal } = {}) {
  return enTurno(async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'seki-chrome-'));
    let pid;
    try {
      const args = ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${tmp}`, '--no-pdf-header-footer', `--print-to-pdf=${pdf}`, pathToFileURL(html).href];
      const fin = await new Promise((ok) => {
        let vencido = false;
        let cancelado = false;
        let hijo;
        try {
          hijo = spawn(chrome, args, { stdio: 'ignore', detached: true });
          pid = hijo.pid;
        } catch {
          ok({ error: true });
          return;
        }
        const reloj = setTimeout(() => { vencido = true; matar(hijo); }, limiteMs);
        const cancelar = () => { cancelado = true; matar(hijo); };
        if (senal?.aborted) cancelar();
        else senal?.addEventListener('abort', cancelar, { once: true });
        const soltar = () => { clearTimeout(reloj); senal?.removeEventListener('abort', cancelar); };
        hijo.on('error', () => { soltar(); ok({ error: true }); });
        hijo.on('close', (codigo) => { soltar(); ok({ codigo, vencido, cancelado }); });
      });
      const traza = { pid, perfil: tmp };
      if (fin.error) return { ok: false, motivo: 'Chrome could not be started', ...traza };
      if (fin.cancelado) return { ok: false, motivo: 'Cancelled', ...traza };
      if (fin.vencido) return { ok: false, motivo: 'Chrome did not finish in time', ...traza };
      if (fin.codigo !== 0) return { ok: false, motivo: `Chrome exited with code ${fin.codigo}`, ...traza };
      return tieneContenido(pdf) ? { ok: true, ...traza } : { ok: false, motivo: 'Chrome produced no PDF', ...traza };
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
      } catch (e) {
        process.stderr.write(`[seki-review/qa] Chrome profile could not be removed: ${e.code ?? 'error'}\n`);
      }
    }
  });
}
