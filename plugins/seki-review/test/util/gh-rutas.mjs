// Routing fake `gh`: a Node script that joins argv with spaces and answers with the first route whose
// `patron` matches. `patron` is a regex source over the space-joined args and is NOT anchored: anchor
// it (`^...$`) and escape metacharacters (`\\.`, `\\?`), or `pulls/1` also matches `pulls/10`.
// A route answers with `json` (serialized), or `texto` (raw stdout); `stderr` is written to stderr and
// `salida` is the exit code (default 0). Unmatched calls exit 1 with `no route: <args>`. Every call is
// appended to a calls file as one JSON line (the argv array). Routes can be replaced during a test.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GUION = (rutas, llamadas) => `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(llamadas)}, JSON.stringify(args) + '\\n');
const linea = args.join(' ');
for (const r of JSON.parse(fs.readFileSync(${JSON.stringify(rutas)}, 'utf8'))) {
  if (new RegExp(r.patron).test(linea)) {
    if (r.stderr !== undefined) process.stderr.write(r.stderr);
    if (r.texto !== undefined) process.stdout.write(r.texto);
    else if (r.json !== undefined) process.stdout.write(JSON.stringify(r.json));
    process.exit(r.salida ?? 0);
  }
}
process.stderr.write('no route: ' + linea);
process.exit(1);
`;

export function falsoGhRutas(rutas) {
  const dir = mkdtempSync(join(tmpdir(), 'seki-gh-rutas-'));
  const archivoRutas = join(dir, 'rutas.json');
  const archivoLlamadas = join(dir, 'llamadas.jsonl');
  const ruta = join(dir, 'gh');
  writeFileSync(ruta, GUION(archivoRutas, archivoLlamadas));
  chmodSync(ruta, 0o755);
  const fijar = (nuevas) => writeFileSync(archivoRutas, JSON.stringify(nuevas));
  const llamadas = () => (existsSync(archivoLlamadas) ? readFileSync(archivoLlamadas, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  fijar(rutas);
  return { ruta, llamadas, fijar };
}
