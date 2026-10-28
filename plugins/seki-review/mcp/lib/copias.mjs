// Copia de trabajo por PR: un git worktree desacoplado en el commit de la PR, aparte del checkout principal y de
// los worktrees del usuario. Ahí trabaja la IA y se prueban los cambios; nada sale de ahí sin Aprobar.
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
  // Sin barra final: "node_modules/" no coincide con un enlace simbólico.
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
  // reset --hard y clean desde una subcarpeta operarían sobre el repo que la contiene.
  const raiz = await git(dir, ['rev-parse', '--show-toplevel']).then((x) => realpathSync(x.trim()), () => null);
  if (raiz !== realpathSync(dir)) throw new Error(`${dir} no es la raíz de una copia de trabajo`);
  await git(dir, ['reset', '-q', '--hard', headSha]);
  await git(dir, ['clean', '-q', '-fd', '-e', 'node_modules']);
}

export async function borrarCopia(p, repo, numero) {
  const checkout = checkoutDe(p, repo);
  const dir = rutaCopia(p, repo, numero);
  // Sin prune general: podaría también worktrees del usuario cuyo directorio no está montado.
  if (existsSync(dir)) await git(checkout, ['worktree', 'remove', '--force', dir]);
  else await git(checkout, ['worktree', 'remove', '--force', dir]).catch(() => {});
}

// Para investigar, los otros repos se leen en la rama que corresponde al ambiente de la PR (pruebas o producción),
// una por cada portal, nunca en la rama en que esté parado el checkout del usuario.
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
  try { usos = JSON.parse(readFileSync(ruta, 'utf8')); } catch { /* primera vez */ }
  usos[dir] = Date.now();
  mkdirSync(dirname(ruta), { recursive: true });
  writeFileSync(ruta, JSON.stringify(usos));
}
const leerUsos = (p) => { try { return JSON.parse(readFileSync(rutaUsos(p), 'utf8')); } catch { return {}; } };

// Copia de solo lectura de una rama, traída fresca del remoto a una ref propia que se borra enseguida.
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

// Borra las copias del plugin de PRs que ya no están abiertas y las que llevan más de 7 días sin uso. Solo toca
// worktrees que viven dentro de la carpeta de copias; los del usuario quedan fuera aunque sean del mismo repo.
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
