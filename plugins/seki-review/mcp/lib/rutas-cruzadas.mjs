// Routes a PR adds or removes, searched in the other repositories' branches: a route added here that
// another repo already calls must be deployed first; a removed one that is still called breaks it.
import { git } from './proceso.mjs';
import { PRUEBAS } from './reglas.mjs';
import { lineasAgregadas, lineasQuitadas } from './verificar.mjs';

// Only Express declaration receivers count (Ruling R): `app`, `router`, `*Router`/`*router`, `routes`/`route` and
// `rutas*`. Client calls (`axios.post`, `fetch`, `api.get`) are not declarations, and `.use(` mounts a prefix, not a route.
// `<receiver>.route('/x')` declares the route whatever verb is chained after it.
const RECEPTOR = String.raw`(?:(?<![\w$])(?:app|routes?|[\w$]*[Rr]outer|rutas[\w$]*)\s*\.(?:get|post|put|patch|delete|all)|\.\s*route)\s*\(`;
const RUTA = new RegExp(String.raw`${RECEPTOR}\s*(["'\`])(\/[^"'\`\s]{5,200})\1`, 'g');
const ABRE = new RegExp(String.raw`${RECEPTOR}\s*$`);
const MAX_RUTAS = 20;
const MAX_COINCIDENCIAS = 3;
const TITULO = 'Route used by another repository';
const ORIGEN = 'Incident: a backend PR added a route that the frontend production branch already called, so deploying the frontend first returned 404.';

// Hits in tests, mocks, e2e and docs say a route exists, not that a deployed caller needs it.
const SOLO_PRUEBAS = /(^|\/)(__tests__|__mocks__|tests?|mocks?|e2e|docs?)\/|\.(spec|test)\.[cm]?[jt]sx?$|\.(md|mdx|txt)$/;

const estatica = (ruta) => !/^[:*]/.test(ruta.split('/').pop());
const vacia = (texto) => /^\s*(?:$|\/\/|\/\*|\*)/.test(texto);

// Static routes a line declares (also used on the other repo's grep hits).
const declaradas = (texto) => [...texto.matchAll(RUTA)].map((m) => m[2]).filter(estatica);

// The route ends at a segment boundary: not followed by a name character, nor by `/` and the start of another
// segment (a name, `$`, `:` or `{`), so `/v2/orders` is not `/v2/ordersBulk` or `/v2/orders/${id}`.
const esUso = (texto, ruta) => new RegExp(`${ruta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-]|\\/[\\w$:{])`).test(texto);

// A call may open on one line and carry the literal on the next consecutive line, after any consecutive blank or
// comment lines.
function leer(lineas, archivo) {
  const salida = [];
  lineas.forEach(({ linea, texto }, i) => {
    for (const ruta of declaradas(texto)) salida.push({ ruta, archivo, linea });
    const abre = ABRE.exec(texto);
    if (!abre) return;
    let j = i + 1;
    while (lineas[j]?.linea === lineas[j - 1].linea + 1 && vacia(lineas[j].texto)) j++;
    const sig = lineas[j];
    if (sig?.linea !== lineas[j - 1].linea + 1) return;
    for (const ruta of declaradas(`${texto.slice(abre.index).trimEnd()}${sig.texto.trimStart()}`)) salida.push({ ruta, archivo, linea: sig.linea });
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

// `git grep` exits 1 when nothing matches. -z gives `file\0line\0text`, safe for odd file names; the text is kept
// so a hit that declares the route (another backend) is not taken for a call.
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
    const [archivo, linea, ...resto] = l.split('\0');
    if (archivo && /^\d+$/.test(linea ?? '')) hits.push({ archivo, linea: +linea, texto: resto.join('\0') });
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
      const usos = (await grep(o.dir, r.ruta))
        .filter((h) => typeof h.texto !== 'string' || (esUso(h.texto, r.ruta) && !declaradas(h.texto).includes(r.ruta)))
        .map((h) => ({ ...h, soloPruebas: SOLO_PRUEBAS.test(h.archivo) }));
      // Real uses are taken before test and doc ones when the cap cuts.
      const hits = [...usos.filter((h) => !h.soloPruebas), ...usos.filter((h) => h.soloPruebas)].slice(0, MAX_COINCIDENCIAS);
      for (const h of hits) {
        const donde = `${o.repo} (${o.rama})`;
        const aqui = `${h.archivo}:${h.linea}`;
        hallazgos.push({
          regla: 'rutas-en-otros-repos',
          titulo: TITULO,
          severidad: r.quitada ? 'bloqueante' : 'alto',
          archivo: r.archivo,
          linea: r.linea,
          texto: r.ruta,
          mensaje: h.soloPruebas
            ? `${donde} ${r.quitada ? 'still calls' : 'references'} ${r.ruta} at ${aqui}, a test or documentation file.`
            : r.quitada
              ? `${donde} still calls ${r.ruta} at ${aqui}.`
              : `${donde} already calls ${r.ruta} at ${aqui}; this PR must be deployed first.`,
          origen: ORIGEN,
          repoOtro: o.repo,
          rama: o.rama,
          archivoOtro: h.archivo,
          lineaOtro: h.linea,
          ...(h.soloPruebas ? { soloPruebas: true } : {}),
        });
      }
    }
  }
  return hallazgos;
}
