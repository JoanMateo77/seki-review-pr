// Falso `gh`: responde `pr view` con el JSON del archivo indicado (se puede reescribir durante la prueba).
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
