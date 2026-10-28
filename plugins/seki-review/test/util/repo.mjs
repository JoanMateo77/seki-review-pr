// Repos git temporales para pruebas: un remoto bare con refs/pull/<n>/head y un clon como checkout.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sh = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Prueba', GIT_AUTHOR_EMAIL: 'p@x', GIT_COMMITTER_NAME: 'Prueba', GIT_COMMITTER_EMAIL: 'p@x' } }).trim();

// Devuelve { remoto, checkout, base, head } con una PR número `n` que cambia `archivo`.
export function repoConPr({ n = 7, archivo = 'a.ts', antes, despues, rama = 'fix/x' }) {
  const raiz = mkdtempSync(join(tmpdir(), 'seki-repo-'));
  const remoto = join(raiz, 'remoto.git');
  const trabajo = join(raiz, 'trabajo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remoto]);
  execFileSync('git', ['init', '-q', '-b', 'main', trabajo]);
  writeFileSync(join(trabajo, archivo), antes);
  sh(trabajo, 'add', '.');
  sh(trabajo, 'commit', '-qm', 'base');
  const base = sh(trabajo, 'rev-parse', 'HEAD');
  sh(trabajo, 'checkout', '-qb', rama);
  writeFileSync(join(trabajo, archivo), despues);
  // `commit -a` confía en el tamaño y la hora del archivo: si cambia en el mismo instante y con el mismo tamaño
  // (a → b), git lo da por igual y no hay nada que commitear. Sacarlo del índice obliga a leer el contenido.
  sh(trabajo, 'rm', '-q', '--cached', archivo);
  sh(trabajo, 'add', archivo);
  sh(trabajo, 'commit', '-qm', 'cambio');
  const head = sh(trabajo, 'rev-parse', 'HEAD');
  sh(trabajo, 'remote', 'add', 'origin', remoto);
  sh(trabajo, 'push', '-q', 'origin', 'main', rama, `${rama}:refs/pull/${n}/head`);
  const checkout = join(raiz, 'checkout');
  execFileSync('git', ['clone', '-q', remoto, checkout]);
  return { raiz, remoto, checkout, base, head, rama };
}
