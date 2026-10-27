// Falso `claude`: imprime el JSON indicado, sale con el código indicado y anota cada invocación en `llamadas`.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function falsoClaude(json, codigo = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'pw-claude-'));
  const ruta = join(dir, 'claude');
  writeFileSync(join(dir, 'salida.json'), JSON.stringify(json));
  writeFileSync(ruta, `#!/bin/sh\necho x >> "${join(dir, 'llamadas')}"\ncat "${join(dir, 'salida.json')}"\nexit ${codigo}\n`);
  chmodSync(ruta, 0o755);
  return ruta;
}

export const llamadas = (ruta) => {
  const f = join(ruta, '..', 'llamadas');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').length : 0;
};
