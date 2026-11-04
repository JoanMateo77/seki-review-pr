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
  const propia = p?.qa?.chrome ? expandir(p.qa.chrome) : null;
  return [propia, ...CANDIDATOS].filter(Boolean).find(esArchivo) ?? null;
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

export function htmlAPdf(chrome, html, pdf, { limiteMs = 60_000 } = {}) {
  return enTurno(async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'seki-chrome-'));
    let pid;
    try {
      const args = ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${tmp}`, '--no-pdf-header-footer', `--print-to-pdf=${pdf}`, pathToFileURL(html).href];
      const fin = await new Promise((ok) => {
        let vencido = false;
        let hijo;
        try {
          hijo = spawn(chrome, args, { stdio: 'ignore' });
          pid = hijo.pid;
        } catch {
          ok({ error: true });
          return;
        }
        const reloj = setTimeout(() => { vencido = true; hijo.kill('SIGKILL'); }, limiteMs);
        hijo.on('error', () => { clearTimeout(reloj); ok({ error: true }); });
        hijo.on('close', (codigo) => { clearTimeout(reloj); ok({ codigo, vencido }); });
      });
      const traza = { pid, perfil: tmp };
      if (fin.error) return { ok: false, motivo: 'Chrome could not be started', ...traza };
      if (fin.vencido) return { ok: false, motivo: 'Chrome did not finish in time', ...traza };
      if (fin.codigo !== 0) return { ok: false, motivo: `Chrome exited with code ${fin.codigo}`, ...traza };
      return tieneContenido(pdf) ? { ok: true } : { ok: false, motivo: 'Chrome produced no PDF', ...traza };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}
