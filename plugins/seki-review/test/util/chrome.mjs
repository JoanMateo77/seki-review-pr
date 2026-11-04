// Fake Chrome: a Node script. Every call appends its argv (JSON) to `<ruta>.llamadas` and its pid to `<ruta>.pid`.
// modo 'bloquea' is 'ok' leaving a profile subfolder that cannot be removed; 'ok' writes %PDF-1.4 to the --print-to-pdf path, 'falla' exits 1, 'cuelga' sleeps until killed.
// Test files register `after(limpiarChrome)` to remove the temp folders.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GUION = (modo, base) => `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(`${base}.llamadas`)}, JSON.stringify(args) + '\\n');
fs.writeFileSync(${JSON.stringify(`${base}.pid`)}, String(process.pid));
const modo = ${JSON.stringify(modo)};
if (modo === 'falla') process.exit(1);
if (modo === 'bloquea') {
  const perfil = args.find((a) => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
  fs.mkdirSync(perfil + '/cerrado');
  fs.writeFileSync(perfil + '/cerrado/x', 'x');
  fs.chmodSync(perfil + '/cerrado', 0);
}
if (modo === 'cuelga') setInterval(() => {}, 1000);
else {
  const destino = args.find((a) => a.startsWith('--print-to-pdf=')).slice('--print-to-pdf='.length);
  fs.writeFileSync(destino, '%PDF-1.4\\n');
}
`;

const creadas = [];
export function limpiarChrome() {
  for (const dir of creadas.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function chromeFalso({ modo = 'ok' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'seki-chrome-falso-'));
  creadas.push(dir);
  const ruta = join(dir, 'chrome');
  writeFileSync(ruta, GUION(modo, ruta));
  chmodSync(ruta, 0o755);
  return ruta;
}

export const llamadasChrome = (ruta) => (existsSync(`${ruta}.llamadas`) ? readFileSync(`${ruta}.llamadas`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
export const pidChrome = (ruta) => (existsSync(`${ruta}.pid`) ? Number(readFileSync(`${ruta}.pid`, 'utf8')) : null);
