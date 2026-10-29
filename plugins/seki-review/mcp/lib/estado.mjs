// Is the change of a PR to prod already in the testing branch?
// 1) Compares the PR's files blob by blob against the testing tree (API, no checkout).
// 2) If not everything matches and there is a local checkout, tries to reverse-apply the patch on testing:
//    if it applies, the change is already there even if testing touched other lines of those files.
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

// One fetch at a time per repo: git does not handle concurrent fetches on the same .git well.
const colas = new Map();
export const enCola = (dir, fn) => {
  const previa = colas.get(dir) ?? Promise.resolve();
  const actual = previa.then(fn, fn);
  colas.set(dir, actual.catch(() => {}));
  return actual;
};

// Base branches are fetched into a dedicated namespace: refs/remotes/origin/* can be rewritten
// concurrently by another user fetch (IDE, another session), leaving the ref invalid.
async function probarParche(dir, numero, prod, pruebas, baseSha) {
  const ns = `refs/seki-review/${numero}`;
  const ref = `${ns}/head`;
  const tmp = mkdtempSync(join(tmpdir(), 'seki-review-'));
  try {
    await git(dir, ['fetch', '-q', '--no-write-fetch-head', 'origin', `+pull/${numero}/head:${ref}`, `+refs/heads/${prod}:${ns}/prod`, `+refs/heads/${pruebas}:${ns}/pruebas`]);
    // An already merged PR is an ancestor of its base: the starting point is the base sha GitHub recorded.
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
      .catch((e) => { console.error('seki-review: patch check for PR', numero, e.message.slice(0, 300)); return null; });
    if (parche === 'en_pruebas' || parche === 'no_en_pruebas') return { ...resultado, estado: parche, metodo: 'parche' };
    if (parche === 'conflicto') resultado.conflicto = true;
    if (parche === null) resultado.provisional = true;
  }
  return { ...resultado, estado: iguales === 0 ? 'no_en_pruebas' : 'parcial' };
}
