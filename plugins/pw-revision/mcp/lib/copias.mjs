// Copia de trabajo por PR: un git worktree desacoplado en el commit de la PR, aparte del checkout principal y de
// los worktrees del usuario. Ahí trabaja la IA y se prueban los cambios; nada sale de ahí sin Aprobar.
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { rutaCopia } from './cache.mjs';
import { expandir } from './config.mjs';
import { enCola } from './estado.mjs';
import { git } from './proceso.mjs';

const checkoutDe = (p, repo) => expandir(p.repos[repo].checkout);

async function excluirNodeModules(checkout) {
  const comun = (await git(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  const ruta = join(comun, 'info/exclude');
  const actual = existsSync(ruta) ? readFileSync(ruta, 'utf8') : '';
  // Sin barra final: "node_modules/" no coincide con un enlace simbólico.
  if (!actual.split('\n').includes('node_modules')) {
    mkdirSync(dirname(ruta), { recursive: true });
    appendFileSync(ruta, `${actual && !actual.endsWith('\n') ? '\n' : ''}node_modules\n`);
  }
}

async function traerSha(checkout, numero, headSha) {
  const existe = await git(checkout, ['cat-file', '-e', `${headSha}^{commit}`]).then(() => true, () => false);
  if (existe) return;
  const ref = `refs/pw-revision/${numero}/copia`;
  await enCola(checkout, async () => {
    try { await git(checkout, ['fetch', '-q', '--no-write-fetch-head', 'origin', `+pull/${numero}/head:${ref}`]); }
    finally { await git(checkout, ['update-ref', '-d', ref]).catch(() => {}); }
  });
}

export async function crearCopia(p, repo, numero, headSha) {
  const checkout = checkoutDe(p, repo);
  const dir = rutaCopia(p, repo, numero);
  if (existsSync(join(dir, '.git'))) {
    const actual = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    if (actual === headSha) return dir;
    await traerSha(checkout, numero, headSha);
    await reiniciarCopia(dir, headSha);
    return dir;
  }
  await traerSha(checkout, numero, headSha);
  mkdirSync(dirname(dir), { recursive: true });
  await git(checkout, ['worktree', 'add', '-q', '--detach', dir, headSha]);
  await excluirNodeModules(checkout);
  const modulos = join(checkout, 'node_modules');
  if (existsSync(modulos) && !existsSync(join(dir, 'node_modules'))) symlinkSync(modulos, join(dir, 'node_modules'));
  return dir;
}

export async function diffCopia(dir) {
  await git(dir, ['add', '-A', '-N']);
  return git(dir, ['diff', '--binary', '--no-color', '--no-ext-diff']);
}

export async function reiniciarCopia(dir, headSha) {
  await git(dir, ['reset', '-q', '--hard', headSha]);
  await git(dir, ['clean', '-q', '-fd', '-e', 'node_modules']);
}

export async function borrarCopia(p, repo, numero) {
  const checkout = checkoutDe(p, repo);
  const dir = rutaCopia(p, repo, numero);
  if (existsSync(dir)) await git(checkout, ['worktree', 'remove', '--force', dir]);
  await git(checkout, ['worktree', 'prune']);
}
