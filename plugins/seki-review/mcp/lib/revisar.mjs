// PRs the owner has to review: parsing of a pasted link and the local list that remembers them.
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { conBloqueoSync, escribirAtomico } from './bloqueo.mjs';
import { rutaRevisar } from './cache.mjs';
import { ghJson } from './proceso.mjs';

export const MAX_ENLACE = 500;
export const MAX_REVISAR = 200;
const MAX_NUMERO = 10_000_000;
const NOMBRE = '[\\w.-]+';
const FORMAS = [
  new RegExp(`^https://github\\.com/(${NOMBRE})/(${NOMBRE})/pull/(\\d+)(?:[/?#].*)?$`, 'i'),
  new RegExp(`^(${NOMBRE})/(${NOMBRE})#(\\d+)$`),
];
const SOLO_REPO = [new RegExp(`^(${NOMBRE})#(\\d+)$`), new RegExp(`^(${NOMBRE})\\s+(\\d+)$`)];

// `http` is the status the dashboard answers with.
const fallo = (codigo, mensaje, http = 400) => Object.assign(new Error(`[seki-review/revisar] ${mensaje}`), { codigo, http });

// Accepts a GitHub PR link, owner/repo#n, repo#n or "repo n"; validates against the project and returns the canonical key.
export function parsearEnlacePr(texto, p) {
  if (typeof texto !== 'string') throw fallo('ENLACE_INVALIDO', 'A PR link or repo#number is required');
  const t = texto.trim();
  if (!t) throw fallo('ENLACE_INVALIDO', 'A PR link or repo#number is required');
  if (t.length > MAX_ENLACE) throw fallo('ENLACE_INVALIDO', `The text is longer than ${MAX_ENLACE} characters`);
  let owner = null;
  let repo;
  let n;
  for (const re of FORMAS) {
    const m = re.exec(t);
    if (m) [, owner, repo, n] = m;
  }
  if (!repo) {
    for (const re of SOLO_REPO) {
      const m = re.exec(t);
      if (m) [, repo, n] = m;
    }
  }
  if (!repo) throw fallo('ENLACE_INVALIDO', 'Expected a PR link, owner/repo#number, repo#number or "repo number"');
  if (owner && owner.toLowerCase() !== String(p.owner).toLowerCase()) {
    throw fallo('REPO_NO_CONFIGURADO', `The repository ${owner}/${repo} is not configured in project ${p.clave}`);
  }
  const clave = Object.keys(p.repos).find((k) => k === repo) ?? Object.keys(p.repos).find((k) => k.toLowerCase() === repo.toLowerCase());
  if (!clave) throw fallo('REPO_NO_CONFIGURADO', `The repository ${owner ?? p.owner}/${repo} is not configured in project ${p.clave}`);
  const numero = Number(n);
  if (!Number.isSafeInteger(numero) || numero < 1 || numero > MAX_NUMERO) throw fallo('ENLACE_INVALIDO', 'The PR number is out of range');
  return { repo: clave, numero };
}

const idDe = (e) => `${e.repo}#${e.numero}`;
const valida = (e) => e && typeof e.repo === 'string' && Number.isInteger(e.numero) && (e.origen === 'solicitada' || e.origen === 'enlace');

// Entries the owner dismissed stay (hidden) while GitHub still lists the PR as requested, so the next refresh
// does not bring it back; the collector drops them once the search stops returning the PR.
const registrar = (mensaje) => console.error(`[seki-review/revisar] ${mensaje}`);

function leerCrudo(ruta) {
  const datos = JSON.parse(readFileSync(ruta, 'utf8'));
  if (!Array.isArray(datos?.prs)) throw new Error('unexpected shape');
  return datos.prs.filter(valida);
}

export function leerRevisar(p, { todas = false } = {}) {
  const ruta = rutaRevisar(p.salida);
  let prs = [];
  if (existsSync(ruta)) {
    try { prs = leerCrudo(ruta); } catch (e) { registrar(`${basename(ruta)} could not be read (${e?.code ?? e?.name ?? 'error'}); treated as empty`); }
  }
  return todas ? prs : prs.filter((e) => !e.descartada);
}

// Read-modify-write under the file lock: the dashboard and the MCP tool are separate processes.
// An unreadable file is copied aside before a fresh list starts, so a write never destroys it.
function modificar(p, fn) {
  const ruta = rutaRevisar(p.salida);
  return conBloqueoSync(ruta, () => {
    let actual = [];
    if (existsSync(ruta)) {
      try { actual = leerCrudo(ruta); } catch (e) {
        const copia = `${ruta}.corrupt-${Date.now()}`;
        copyFileSync(ruta, copia);
        registrar(`${basename(ruta)} could not be read (${e?.code ?? e?.name ?? 'error'}); it was copied to ${basename(copia)} and a new list starts`);
      }
    }
    const { prs, resultado } = fn(actual);
    if (prs) escribirAtomico(ruta, JSON.stringify({ version: 1, prs }, null, 2) + '\n');
    return resultado;
  });
}

// An `enlace` entry is never downgraded to `solicitada`; adding by link brings back a dismissed entry and upgrades a
// requested one. Returns 'agregada' when the visible list changed, otherwise 'ya_estaba' (and nothing is written).
export function agregarRevisar(p, entradas) {
  const lista = Array.isArray(entradas) ? entradas : [entradas];
  return modificar(p, (actual) => {
    const porId = new Map(actual.map((e) => [idDe(e), e]));
    let cambios = 0;
    for (const { repo, numero, origen } of lista) {
      const id = `${repo}#${numero}`;
      const previa = porId.get(id);
      if (!previa) {
        porId.set(id, { repo, numero, origen, agregada: new Date().toISOString() });
        cambios++;
      } else if (origen === 'enlace' && (previa.origen !== 'enlace' || previa.descartada)) {
        const { descartada, ...resto } = previa;
        porId.set(id, { ...resto, origen: 'enlace' });
        cambios++;
      }
    }
    let prs = [...porId.values()];
    // The cap counts visible entries only: a dismissed one is what keeps a still-requested PR from coming back.
    const visibles = prs.filter((e) => !e.descartada);
    if (visibles.length > MAX_REVISAR) {
      const antes = (a, b) => String(a.agregada).localeCompare(String(b.agregada));
      const orden = (a, b) => (a.origen === b.origen ? 0 : a.origen === 'solicitada' ? -1 : 1) || antes(a, b);
      const fuera = new Set(visibles.sort(orden).slice(0, visibles.length - MAX_REVISAR));
      prs = prs.filter((e) => !fuera.has(e));
      cambios++;
    }
    return cambios ? { prs, resultado: 'agregada' } : { prs: null, resultado: 'ya_estaba' };
  });
}

// A link entry is removed; a requested one is kept hidden while GitHub still asks for the review.
export const quitarRevisar = (p, id) => modificar(p, (actual) => {
  const e = actual.find((x) => idDe(x) === id && !x.descartada);
  if (!e) return { prs: null, resultado: false };
  const prs = e.origen === 'enlace' ? actual.filter((x) => x !== e) : actual.map((x) => (x === e ? { ...x, descartada: true } : x));
  return { prs, resultado: true };
});

// Drops entries by id (GitHub reports them closed or merged, or no longer requested); the caller checked each PR.
export const podarRevisar = (p, ids) => modificar(p, (actual) => {
  const prs = actual.filter((e) => !ids.has(idDe(e)));
  return prs.length === actual.length ? { prs: null, resultado: 0 } : { prs, resultado: actual.length - prs.length };
});

// Link -> validated PR -> one `gh pr view` to check it is open -> list. No AI and no write to GitHub.
export async function incorporarEnlace(p, enlace) {
  const { repo, numero } = parsearEnlacePr(enlace, p);
  const id = `${repo}#${numero}`;
  let pr;
  try {
    pr = await ghJson(['pr', 'view', String(numero), '-R', `${p.owner}/${repo}`, '--json', 'state']);
  } catch {
    throw fallo('PR_NO_ENCONTRADA', `PR ${id} could not be read from GitHub`, 404);
  }
  if (pr?.state !== 'OPEN') throw fallo('PR_CERRADA', `PR ${id} is closed or merged`, 409);
  return { id, repo, numero, estado: agregarRevisar(p, { repo, numero, origen: 'enlace' }) };
}
