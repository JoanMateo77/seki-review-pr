// Fake `claude`: prints the given JSON, exits with the given code and records each invocation in `llamadas`.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// script: sh commands that run before printing (for example, editing a file in the cwd). $N is the call number.
export function falsoClaude(json, codigo = 0, script = '') {
  const dir = mkdtempSync(join(tmpdir(), 'seki-claude-'));
  const ruta = join(dir, 'claude');
  writeFileSync(join(dir, 'salida.json'), JSON.stringify(json));
  writeFileSync(ruta, `#!/bin/sh\necho x >> "${join(dir, 'llamadas')}"\nN=$(wc -l < "${join(dir, 'llamadas')}" | tr -d ' ')\n${script}\ncat "${join(dir, 'salida.json')}"\nexit ${codigo}\n`);
  chmodSync(ruta, 0o755);
  return ruta;
}

export const llamadas = (ruta) => {
  const f = join(ruta, '..', 'llamadas');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').length : 0;
};
