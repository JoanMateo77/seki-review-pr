// Routing fake `gh`: a Node script that joins argv with spaces and answers with the first route whose
// `patron` matches. `patron` is a regex source over the space-joined args and is NOT anchored: anchor
// it (`^...$`) and escape metacharacters (`\\.`, `\\?`), or `pulls/1` also matches `pulls/10`.
// A route answers with `json` (serialized), or `texto` (raw stdout); `stderr` is written to stderr and
// `salida` is the exit code (default 0). Unmatched calls exit 1 with `no route: <args>`. Every call is
// appended to a calls file as one JSON line (the argv array). A route with `esperaMs` sleeps that long and
// `maxSimultaneas()` reports how many such calls overlapped at most. Routes can be replaced during a test.
// Test files register `after(limpiarGhRutas)` to remove the temp folders.
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GUION = (rutas, llamadas, ocupacion) => `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(llamadas)}, JSON.stringify(args) + '\\n');
const linea = args.join(' ');
for (const r of JSON.parse(fs.readFileSync(${JSON.stringify(rutas)}, 'utf8'))) {
  if (new RegExp(r.patron).test(linea)) {
    // esperaMs keeps the call alive that long, marking its start (+) and end (-) in the occupancy file.
    if (r.esperaMs) { fs.appendFileSync(${JSON.stringify(ocupacion)}, '+'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, r.esperaMs); fs.appendFileSync(${JSON.stringify(ocupacion)}, '-'); }
    if (r.stderr !== undefined) process.stderr.write(r.stderr);
    if (r.texto !== undefined) process.stdout.write(r.texto);
    else if (r.json !== undefined) process.stdout.write(JSON.stringify(r.json));
    process.exit(r.salida ?? 0);
  }
}
process.stderr.write('no route: ' + linea);
process.exit(1);
`;

const creadas = [];
export function limpiarGhRutas() {
  for (const dir of creadas.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function falsoGhRutas(rutas) {
  const dir = mkdtempSync(join(tmpdir(), 'seki-gh-rutas-'));
  creadas.push(dir);
  const archivoRutas = join(dir, 'rutas.json');
  const archivoLlamadas = join(dir, 'llamadas.jsonl');
  const archivoOcupacion = join(dir, 'ocupacion.txt');
  const ruta = join(dir, 'gh');
  writeFileSync(ruta, GUION(archivoRutas, archivoLlamadas, archivoOcupacion));
  chmodSync(ruta, 0o755);
  // Atomic: a gh call running while routes change reads either the old or the new file, never half of it.
  const fijar = (nuevas) => {
    writeFileSync(`${archivoRutas}.tmp`, JSON.stringify(nuevas));
    renameSync(`${archivoRutas}.tmp`, archivoRutas);
  };
  const llamadas = () => (existsSync(archivoLlamadas) ? readFileSync(archivoLlamadas, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const maxSimultaneas = () => {
    let ahora = 0;
    let max = 0;
    for (const c of existsSync(archivoOcupacion) ? readFileSync(archivoOcupacion, 'utf8') : '') { ahora += c === '+' ? 1 : -1; max = Math.max(max, ahora); }
    return max;
  };
  fijar(rutas);
  return { ruta, llamadas, fijar, maxSimultaneas };
}
