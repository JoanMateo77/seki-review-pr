// Temporary git repos for tests: a bare remote with refs/pull/<n>/head and a clone as the checkout.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sh = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'p@x', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'p@x' } }).trim();

// Returns { remoto, checkout, base, head } with PR number `n` that changes `archivo`.
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
  // `commit -a` trusts the file's size and mtime: if it changes in the same instant with the same size
  // (a → b), git treats it as unchanged and there is nothing to commit. Removing it from the index forces reading the content.
  sh(trabajo, 'rm', '-q', '--cached', archivo);
  sh(trabajo, 'add', archivo);
  sh(trabajo, 'commit', '-qm', 'change');
  const head = sh(trabajo, 'rev-parse', 'HEAD');
  sh(trabajo, 'remote', 'add', 'origin', remoto);
  sh(trabajo, 'push', '-q', 'origin', 'main', rama, `${rama}:refs/pull/${n}/head`);
  const checkout = join(raiz, 'checkout');
  execFileSync('git', ['clone', '-q', remoto, checkout]);
  return { raiz, remoto, checkout, base, head, rama };
}
