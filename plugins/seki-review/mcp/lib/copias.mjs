// Working copy per PR: a detached git worktree at the PR's commit, separate from the main checkout and from
// the user's worktrees. The AI works there and changes are tested there; nothing leaves it without Approve.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { rutaCopia } from './cache.mjs';
import { clasificarBase, expandir } from './config.mjs';
import { enCola } from './estado.mjs';
import { git } from './proceso.mjs';

const checkoutDe = (p, repo) => expandir(p.repos[repo].checkout);

async function excluirNodeModules(checkout) {
  const comun = (await git(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  const ruta = join(comun, 'info/exclude');
  const actual = existsSync(ruta) ? readFileSync(ruta, 'utf8') : '';
  // No trailing slash: "node_modules/" does not match a symbolic link.
  if (!actual.split('\n').includes('node_modules')) {
    mkdirSync(dirname(ruta), { recursive: true });
    appendFileSync(ruta, `${actual && !actual.endsWith('\n') ? '\n' : ''}node_modules\n`);
  }
}

async function traerSha(checkout, numero, headSha) {
  const existe = await git(checkout, ['cat-file', '-e', `${headSha}^{commit}`]).then(() => true, () => false);
  if (existe) return;
  const ref = `refs/seki-review/${numero}/copia`;
  await enCola(checkout, async () => {
    try { await git(checkout, ['fetch', '-q', '--no-write-fetch-head', 'origin', `+pull/${numero}/head:${ref}`]); }
    finally { await git(checkout, ['update-ref', '-d', ref]).catch(() => {}); }
  });
}

export async function crearCopia(p, repo, numero, headSha, { sufijo = '' } = {}) {
  const checkout = checkoutDe(p, repo);
  const dir = rutaCopia(p, repo, numero, sufijo);
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
  marcarUso(p, dir);
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
  // reset --hard and clean from a subfolder would operate on the repo that contains it.
  const raiz = await git(dir, ['rev-parse', '--show-toplevel']).then((x) => realpathSync(x.trim()), () => null);
  if (raiz !== realpathSync(dir)) throw new Error(`${dir} is not the root of a working copy`);
  await git(dir, ['reset', '-q', '--hard', headSha]);
  await git(dir, ['clean', '-q', '-fd', '-e', 'node_modules']);
}

export async function borrarCopia(p, repo, numero) {
  const checkout = checkoutDe(p, repo);
  const dir = rutaCopia(p, repo, numero);
  // No general prune: it would also prune the user's worktrees whose directory is not mounted.
  if (existsSync(dir)) await git(checkout, ['worktree', 'remove', '--force', dir]);
  else await git(checkout, ['worktree', 'remove', '--force', dir]).catch(() => {});
}

// For investigation, the other repos are read on the branch matching the PR's environment (testing or production),
// one per portal, never on whatever branch the user's checkout is on.
export function ramasEquivalentes(p, pr) {
  const clase = clasificarBase({ lineas: [], ...p.repos[pr.repo] }, pr.base);
  const ambiente = clase.ambiente === 'prod' ? 'prod' : 'pruebas';
  const ramas = [];
  for (const [repo, cfg] of Object.entries(p.repos)) {
    if (repo === pr.repo) continue;
    for (const linea of cfg.lineas ?? []) if (linea[ambiente]) ramas.push({ repo, portal: linea.portal, rama: linea[ambiente] });
  }
  return { ambiente, ramas };
}

const rutaUsos = (p) => join(p.copias ?? join(p.salida, 'copias'), 'usos.json');
export function marcarUso(p, dir) {
  const ruta = rutaUsos(p);
  let usos = {};
  try { usos = JSON.parse(readFileSync(ruta, 'utf8')); } catch { /* first time */ }
  usos[dir] = Date.now();
  mkdirSync(dirname(ruta), { recursive: true });
  writeFileSync(ruta, JSON.stringify(usos));
}
const leerUsos = (p) => { try { return JSON.parse(readFileSync(rutaUsos(p), 'utf8')); } catch { return {}; } };

// Read-only copy of a branch, fetched fresh from the remote into a private ref that is deleted right away.
export async function copiaDeRama(p, repo, rama) {
  const checkout = checkoutDe(p, repo);
  const dir = join(p.copias ?? join(p.salida, 'copias'), 'ramas', `${repo}--${rama.replace(/[^\w.-]+/g, '_')}`);
  const ref = `refs/seki-review/ramas/${rama}`;
  const sha = await enCola(checkout, async () => {
    try {
      await git(checkout, ['fetch', '-q', '--no-write-fetch-head', 'origin', `+refs/heads/${rama}:${ref}`]);
      const s = (await git(checkout, ['rev-parse', ref])).trim();
      if (existsSync(join(dir, '.git'))) await reiniciarCopia(dir, s);
      else {
        mkdirSync(dirname(dir), { recursive: true });
        await git(checkout, ['worktree', 'add', '-q', '--detach', dir, s]);
      }
      return s;
    } finally {
      await git(checkout, ['update-ref', '-d', ref]).catch(() => {});
    }
  });
  marcarUso(p, dir);
  return { dir, sha };
}

// Deletes the plugin's copies for PRs that are no longer open and those unused for more than 7 days. It only touches
// worktrees inside the copies folder; the user's are left alone even if they belong to the same repo.
export async function limpiarCopias(p, { abiertas, ahora = Date.now(), usos = leerUsos(p), dias = 7 }) {
  const raiz = p.copias ?? join(p.salida, 'copias');
  if (!existsSync(raiz)) return [];
  const raizReal = realpathSync(raiz);
  const borradas = [];
  for (const [repo, cfg] of Object.entries(p.repos)) {
    const checkout = expandir(cfg.checkout);
    if (!checkout || !existsSync(checkout)) continue;
    const lista = await git(checkout, ['worktree', 'list', '--porcelain']).catch(() => '');
    for (const listado of lista.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9))) {
      if (!listado.startsWith(`${raizReal}/`) && !listado.startsWith(`${raiz}/`)) continue;
      const dir = listado.startsWith(`${raizReal}/`) ? raiz + listado.slice(raizReal.length) : listado;
      const nombre = dir.split('/').pop();
      const pr = new RegExp(`^${repo}-(\\d+)(?:-lectura)?$`).exec(nombre);
      const uso = usos[dir] ?? usos[listado];
      const cerrada = pr && !abiertas.has(`${repo}#${pr[1]}`);
      const vieja = uso !== undefined && ahora - uso > dias * 24 * 3600 * 1000;
      if (!cerrada && !vieja) continue;
      await git(checkout, ['worktree', 'remove', '--force', dir]).catch(() => {});
      borradas.push(dir);
    }
  }
  return borradas;
}
