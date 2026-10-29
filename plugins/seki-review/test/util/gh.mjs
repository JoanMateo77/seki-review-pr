// Fake `gh`: answers `pr view` with the JSON of the given file (it can be rewritten during the test).
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function falsoGh(datos) {
  const dir = mkdtempSync(join(tmpdir(), 'seki-gh-'));
  const archivo = join(dir, 'pr.json');
  const ruta = join(dir, 'gh');
  writeFileSync(ruta, `#!/bin/sh\ncat "${archivo}"\n`);
  chmodSync(ruta, 0o755);
  const fijar = (d) => writeFileSync(archivo, JSON.stringify(d));
  fijar(datos);
  return { ruta, fijar };
}
