// Each PR's diff saved to disk per commit, to show it on the dashboard without going back to GitHub.
import { escribirJson, leerJson, rutaDiff } from './cache.mjs';
import { archivosPr } from './estado.mjs';

const MAX_LINEAS_PR = 4000;

export async function asegurarDiff(p, repo, numero, headSha) {
  const ruta = rutaDiff(p.salida, repo, numero);
  const previo = leerJson(ruta);
  if (previo?.headSha === headSha) return previo.archivos;
  const archivos = (await archivosPr(p.owner, repo, numero)).map((a) => ({
    filename: a.filename,
    previous_filename: a.previous_filename,
    status: a.status,
    additions: a.additions,
    deletions: a.deletions,
    sha: a.sha,
    patch: a.patch,
  }));
  escribirJson(ruta, { headSha, archivos });
  return archivos;
}

// Truncates for embedding in the HTML: a line cap per PR; anything beyond it is marked as truncated.
export function diffParaTablero(archivos) {
  let restantes = MAX_LINEAS_PR;
  return archivos.map(({ sha, ...a }) => {
    if (a.patch === undefined) return { ...a, sinPatch: true };
    const lineas = a.patch.split('\n');
    if (restantes <= 0) return { ...a, patch: undefined, recortado: true };
    if (lineas.length <= restantes) { restantes -= lineas.length; return a; }
    const parcial = lineas.slice(0, restantes).join('\n');
    restantes = 0;
    return { ...a, patch: parcial, recortado: true };
  });
}

export function diffsDeFoto(p, foto) {
  const salida = {};
  for (const pr of foto.prs) {
    if (pr.ambiente === 'inactiva') continue;
    const d = leerJson(rutaDiff(p.salida, pr.repo, pr.numero));
    if (d?.headSha === pr.headSha) salida[pr.id] = diffParaTablero(d.archivos);
  }
  return salida;
}
