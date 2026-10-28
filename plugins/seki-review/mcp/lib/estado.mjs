// ¿El cambio de una PR hacia prod ya está en la rama de pruebas?
// 1) Compara blob por blob los archivos de la PR contra el árbol de pruebas (API, sin checkout).
// 2) Si no todo coincide y hay checkout local, intenta aplicar el parche al revés sobre pruebas:
//    si entra, el cambio ya está aunque pruebas haya tocado otras líneas de esos archivos.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandir } from './config.mjs';
import { ghApiLista, ghJson, git } from './proceso.mjs';

const arboles = new Map();
export async function arbolRama(owner, repo, rama) {
  const clave = `${owner}/${repo}@${rama}`;
  if (!arboles.has(clave)) {
    arboles.set(clave, (async () => {
      const r = await ghJson(['api', `repos/${owner}/${repo}/git/trees/${encodeURIComponent(rama)}?recursive=1`]);
      return { sha: r.sha, blobs: new Map(r.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha])) };
    })());
  }
  return arboles.get(clave);
}

const archivosMemo = new Map();
export function archivosPr(owner, repo, numero) {
  const clave = `${owner}/${repo}#${numero}`;
  if (!archivosMemo.has(clave)) archivosMemo.set(clave, ghApiLista(`repos/${owner}/${repo}/pulls/${numero}/files?per_page=100`));
  return archivosMemo.get(clave);
}

export const commitsPr = async (owner, repo, numero) =>
  (await ghApiLista(`repos/${owner}/${repo}/pulls/${numero}/commits?per_page=100`)).map((c) => {
    const [titulo, ...cuerpo] = c.commit.message.split('\n');
    return { oid: c.sha, messageHeadline: titulo, messageBody: cuerpo.join('\n').trim(), autor: c.author?.login ?? c.commit.author?.name, fecha: c.commit.author?.date };
  });

// Un fetch a la vez por repo: git no tolera bien fetches concurrentes en el mismo .git.
const colas = new Map();
export const enCola = (dir, fn) => {
  const previa = colas.get(dir) ?? Promise.resolve();
  const actual = previa.then(fn, fn);
  colas.set(dir, actual.catch(() => {}));
  return actual;
};

// Las ramas base se traen a un espacio propio: refs/remotes/origin/* puede reescribirlo
// en paralelo otro fetch del usuario (IDE, otra sesión) y dejar la referencia inválida.
async function probarParche(dir, numero, prod, pruebas, baseSha) {
  const ns = `refs/seki-review/${numero}`;
  const ref = `${ns}/head`;
  const tmp = mkdtempSync(join(tmpdir(), 'seki-review-'));
  try {
    await git(dir, ['fetch', '-q', '--no-write-fetch-head', 'origin', `+pull/${numero}/head:${ref}`, `+refs/heads/${prod}:${ns}/prod`, `+refs/heads/${pruebas}:${ns}/pruebas`]);
    // Una PR ya mergeada es ancestro de su base: el punto de partida es el sha de base que guardó GitHub.
    const base = (await git(dir, ['merge-base', baseSha ?? `${ns}/prod`, ref])).trim();
    const parche = join(tmp, 'pr.diff');
    writeFileSync(parche, await git(dir, ['diff', '--binary', base, ref]));
    const env = { GIT_INDEX_FILE: join(tmp, 'index') };
    await git(dir, ['read-tree', `${ns}/pruebas`], { env });
    const aplica = (extra) => git(dir, ['apply', '--cached', '--check', ...extra, parche], { env }).then(() => true, () => false);
    if (await aplica(['-R'])) return 'en_pruebas';
    if (await aplica([])) return 'no_en_pruebas';
    return 'conflicto';
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    for (const r of [ref, `${ns}/prod`, `${ns}/pruebas`]) await git(dir, ['update-ref', '-d', r]).catch(() => {});
  }
}

export async function estadoFrentePruebas({ owner, repo, cfgRepo, numero, prod, pruebas, baseSha }) {
  const [arbol, archivos] = await Promise.all([arbolRama(owner, repo, pruebas), archivosPr(owner, repo, numero)]);
  const total = archivos.length;
  const iguales = archivos.filter((a) =>
    a.status === 'removed' ? !arbol.blobs.has(a.filename) : arbol.blobs.get(a.filename) === a.sha,
  ).length;
  const resultado = { iguales, total, pruebasSha: arbol.sha, metodo: 'archivos' };

  if (total > 0 && iguales === total) return { ...resultado, estado: 'en_pruebas' };

  const dir = expandir(cfgRepo.checkout);
  if (dir && existsSync(dir)) {
    const parche = await enCola(dir, () => probarParche(dir, numero, prod, pruebas, baseSha))
      .catch(() => enCola(dir, () => probarParche(dir, numero, prod, pruebas, baseSha)))
      .catch((e) => { console.error('seki-review: parche de la PR', numero, e.message.slice(0, 300)); return null; });
    if (parche === 'en_pruebas' || parche === 'no_en_pruebas') return { ...resultado, estado: parche, metodo: 'parche' };
    if (parche === 'conflicto') resultado.conflicto = true;
    if (parche === null) resultado.provisional = true;
  }
  return { ...resultado, estado: iguales === 0 ? 'no_en_pruebas' : 'parcial' };
}
