// Routing fake `gh`: a Node script that joins argv with spaces and answers with the JSON of the first
// route whose `patron` (regex source) matches. Unmatched calls exit 1 with `no route`. Every call is
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
    process.stdout.write(JSON.stringify(r.json));
    process.exit(0);
  }
}
process.stderr.write('no route');
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
