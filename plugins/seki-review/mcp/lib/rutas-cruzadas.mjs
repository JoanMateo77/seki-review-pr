// Routes a PR adds or removes, searched in the other repositories' branches: a route added here that
// another repo already calls must be deployed first; a removed one that is still called breaks it.
import { git } from './proceso.mjs';
import { PRUEBAS } from './reglas.mjs';
import { lineasAgregadas, lineasQuitadas } from './verificar.mjs';

const RUTA = /\.(?:get|post|put|patch|delete|all|use)\(\s*(["'`])(\/[^"'`\s]{5,200})\1/g;
const MAX_RUTAS = 20;
const MAX_COINCIDENCIAS = 3;
const TITULO = 'Route used by another repository';
const ORIGEN = 'Incident: a backend PR added a route that the frontend production branch already called, so deploying the frontend first returned 404.';

const estatica = (ruta) => !/^[:*]/.test(ruta.split('/').pop());

const ABRE = /\.(?:get|post|put|patch|delete|all|use)\(\s*$/;

// A call may open on one line and carry the literal on the next consecutive line of the same kind.
function leer(lineas, archivo) {
  const salida = [];
  lineas.forEach(({ linea, texto }, i) => {
    for (const m of texto.matchAll(RUTA)) if (estatica(m[2])) salida.push({ ruta: m[2], archivo, linea });
    const sig = lineas[i + 1];
    if (ABRE.test(texto) && sig?.linea === linea + 1) {
      const m = new RegExp(RUTA.source).exec(`${texto.trimEnd()}${sig.texto.trimStart()}`);
      if (m && estatica(m[2])) salida.push({ ruta: m[2], archivo, linea: sig.linea });
    }
  });
  return salida;
}

export function rutasDelDiff(archivos) {
  let agregadas = [];
  let quitadas = [];
  for (const a of archivos) {
    if (PRUEBAS.test(a.filename)) continue;
    if (a.status !== 'removed') agregadas.push(...leer(lineasAgregadas(a.patch), a.filename));
    if (a.status !== 'added') quitadas.push(...leer(lineasQuitadas(a.patch), a.filename));
  }
  const enAmbas = new Set(agregadas.map((r) => r.ruta).filter((r) => quitadas.some((q) => q.ruta === r)));
  agregadas = agregadas.filter((r) => !enAmbas.has(r.ruta));
  quitadas = quitadas.filter((r) => !enAmbas.has(r.ruta));
  return { agregadas, quitadas };
}

// `git grep` exits 1 when nothing matches. -z gives `file\0line\0text`, safe for odd file names.
export async function grepGit(dir, ruta) {
  let salida;
  try {
    salida = await git(dir, ['grep', '-z', '-n', '-F', '-e', ruta, '--', '.']);
  } catch (e) {
    if (e.code === 1) return [];
    throw e;
  }
  const hits = [];
  for (const l of salida.split('\n')) {
    const [archivo, linea] = l.split('\0');
    if (archivo && /^\d+$/.test(linea ?? '')) hits.push({ archivo, linea: +linea });
  }
  return hits;
}

export async function buscarRutas({ rutas, otros, grep = grepGit }) {
  const vistas = new Set();
  const pendientes = [
    ...rutas.quitadas.map((r) => ({ ...r, quitada: true })),
    ...rutas.agregadas.map((r) => ({ ...r, quitada: false })),
  ].filter((r) => !vistas.has(r.ruta) && vistas.add(r.ruta)).slice(0, MAX_RUTAS);
  const hallazgos = [];
  for (const r of pendientes) {
    for (const o of otros.filter((x) => !x.falla)) {
      const hits = (await grep(o.dir, r.ruta)).slice(0, MAX_COINCIDENCIAS);
      for (const h of hits) {
        const donde = `${o.repo} (${o.rama})`;
        hallazgos.push({
          regla: 'rutas-en-otros-repos',
          titulo: TITULO,
          severidad: r.quitada ? 'bloqueante' : 'alto',
          archivo: r.archivo,
          linea: r.linea,
          texto: r.ruta,
          mensaje: r.quitada
            ? `${donde} still calls ${r.ruta} at ${h.archivo}:${h.linea}.`
            : `${donde} already calls ${r.ruta} at ${h.archivo}:${h.linea}; this PR must be deployed first.`,
          origen: ORIGEN,
          repoOtro: o.repo,
          rama: o.rama,
          archivoOtro: h.archivo,
          lineaOtro: h.linea,
        });
      }
    }
  }
  return hallazgos;
}
