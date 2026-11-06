// Builds a project's PR snapshot: environment, twins, status against testing and production,
// fixed checks and suggested action.
import { clasificarBase, proyecto as cargarProyecto } from './config.mjs';
import { escribirJson, leerJson, rutaAjustes, rutaCacheEstados, rutaEntregas, rutaCacheVerificaciones, rutaExplicacion, rutaInstantanea } from './cache.mjs';
import { archivosPr, arbolRama, commitsPr, estadoFrentePruebas } from './estado.mjs';
import { buscarGemela } from './gemelas.mjs';
import { enParalelo, ghJson } from './proceso.mjs';
import { verificar } from './verificar.mjs';
import { reglasDeConfig } from './reglas.mjs';
import { compararFotos, hayCambios } from './cambios.mjs';
import { asegurarDiff } from './diffs.mjs';
import { agrupar } from './entregas.mjs';
import { construirEntregas } from './etapas.mjs';
import { eventosDe, registrarEventos } from './eventos.mjs';
import { leerGuias, qaDeEventos } from './qa-guia.mjs';
import { agregarRevisar, leerRevisar, podarRevisar } from './revisar.mjs';

export const CAMPOS = 'number,title,url,baseRefName,headRefName,createdAt,updatedAt,additions,deletions,changedFiles,isDraft,headRefOid,author,reviewDecision,body';

export const ACCIONES = {
  pruebas_sin_prod: 'In testing with no PR to production',
  solo_prod: 'Already in testing: production pending',
  revisar_diferencias: 'Testing has a different version: review differences',
  pruebas_abierta: 'Not in testing: its testing PR is open',
  sin_pruebas: 'Not in testing and has no testing PR',
  hacia_pruebas: 'PR to testing',
  pruebas_automaticas: 'Automated tests only',
  inactiva: 'Branch no longer in use',
  otra: 'Branch outside the configured lines',
};

const PAGINAS_GEMELAS = 3;
const PAGINAS_MAXIMAS = 10;
const POR_PAGINA = 100;
const MAX_DESCRIPCION = 4096;
const DIAS_HUERFANAS = 30;
const SOLO_PRUEBAS = /solo pruebas|pruebas only|ambiente de pruebas|staging only|testing only|^test(\(|:)|sincroniz|traer lo que ya est/i;
const diasDesde = (fecha) => Math.floor((Date.now() - new Date(fecha)) / 86400000);
const esSoloPruebasAutomaticas = (titulo) => /^test(\(|:)/i.test(titulo);
const esSeguridad = (titulo) => /seguridad|security|sqli|xss|csrf|inyecci|injection/i.test(titulo);

export function esfuerzoPorTamano(lineas, archivos) {
  const base = lineas <= 30 ? 1 : lineas <= 150 ? 2 : lineas <= 500 ? 3 : lineas <= 1500 ? 4 : 5;
  return Math.min(5, base + (archivos > 20 ? 1 : 0));
}

const aEntrada = (x) => ({
  number: x.number,
  title: x.title,
  state: x.merged_at ? 'MERGED' : x.state.toUpperCase(),
  autor: x.user?.login,
  url: x.html_url,
  creada: x.created_at,
  mergeada: x.merged_at,
  cerrada: x.closed_at ?? null,
  baseSha: x.base.sha,
  headSha: x.head.sha,
  rama: x.head.ref,
  body: x.body,
});

async function prsDeBase(owner, repo, base, cache) {
  const clave = `${repo}@${base}`;
  if (!cache.has(clave)) {
    cache.set(clave, (async () => {
      // REST rather than GraphQL: `gh pr list --state all` returns 504 on repos with many PRs.
      const todas = [];
      for (let pagina = 1; pagina <= PAGINAS_GEMELAS; pagina++) {
        const lote = await ghJson(['api', `repos/${owner}/${repo}/pulls?base=${encodeURIComponent(base)}&state=all&sort=created&direction=desc&per_page=${POR_PAGINA}&page=${pagina}`]);
        todas.push(...lote.map(aEntrada));
        if (lote.length < POR_PAGINA) break;
      }
      return todas;
    })());
  }
  return cache.get(clave);
}

// Closed PRs by update date, so a PR created long ago and merged recently is not missed.
async function recientesDeBase(owner, repo, base, cache, ventanaDias) {
  const clave = `${repo}@${base}#rec`;
  if (!cache.has(clave)) {
    cache.set(clave, (async () => {
      const todas = [];
      for (let pagina = 1; pagina <= PAGINAS_MAXIMAS; pagina++) {
        const lote = await ghJson(['api', `repos/${owner}/${repo}/pulls?base=${encodeURIComponent(base)}&state=closed&sort=updated&direction=desc&per_page=${POR_PAGINA}&page=${pagina}`]);
        todas.push(...lote.map(aEntrada));
        if (lote.length < POR_PAGINA) break;
        const ultima = lote.at(-1)?.updated_at;
        if (!ultima || diasDesde(ultima) > ventanaDias) break;
      }
      return todas;
    })());
  }
  return cache.get(clave);
}

function accionSugerida(pr) {
  if (pr.ambiente === 'inactiva') return 'inactiva';
  if (pr.ambiente === 'otra') return 'otra';
  if (esSoloPruebasAutomaticas(pr.titulo)) return 'pruebas_automaticas';
  if (pr.ambiente === 'pruebas') return pr.sinProd ? 'pruebas_sin_prod' : 'hacia_pruebas';
  const e = pr.estadoPruebas?.estado;
  if (e === 'en_pruebas') return 'solo_prod';
  if (e === 'parcial') return 'revisar_diferencias';
  return pr.gemela?.estado === 'OPEN' ? 'pruebas_abierta' : 'sin_pruebas';
}

// Every regrouping in this process (refresh, join, split, rename, close) runs one at a time: otherwise a refresh
// that read the previous ajustes.json could write its entregas.json after an adjustment and undo it.
let colaEntregas = Promise.resolve();
export function enSerieEntregas(fn) {
  const r = colaEntregas.then(fn);
  colaEntregas = r.catch(() => {});
  return r;
}

// Groups the snapshot into deliveries, records merge/close events and writes entregas.json. Does not call GitHub.
// Call it only from inside enSerieEntregas; everyone else uses derivarEntregas.
export async function derivarEnSerie(p, foto) {
  const ajustes = { unir: [], separar: [], titulo: {}, ...(leerJson(rutaAjustes(p.salida), null) ?? {}) };
  const bases = Object.values(p.repos).flatMap((r) => r.lineas.flatMap((l) => [l.prod, l.pruebas])).filter((b) => typeof b === 'string');
  const cfg = { sufijosRama: p.entregas.sufijosRama, patronId: p.entregas.patronId, maxPorSenal: p.entregas.maxPorSenal, bases, owner: p.owner };
  const prsPorId = new Map();
  // PRs that are in the snapshot only to be reviewed belong to someone else's deliveries.
  const propia = { ...foto, prs: foto.prs.filter((pr) => !pr.soloRevision) };
  for (const pr of [...propia.prs, ...(foto.recientes ?? [])]) if (!prsPorId.has(pr.id)) prsPorId.set(pr.id, pr);
  const entregas = agrupar([...prsPorId.values()], cfg, ajustes);
  const { todos } = await registrarEventos(p, eventosDe(propia, entregas));
  const construidas = construirEntregas({ entregas, prsPorId, cfgRepos: p.repos, cfg: p.entregas, eventos: todos, ahora: new Date(), qaDe: qaDeEventos(todos, leerGuias(p).guias) });
  const salida = { generado: new Date().toISOString(), entregas: construidas };
  escribirJson(rutaEntregas(p.salida), salida);
  return salida;
}

export const derivarEntregas = (p, foto) => enSerieEntregas(() => derivarEnSerie(p, foto));

export async function recolectar({ proyecto: clave, repos, incluirInactivas = true } = {}) {
  const p = cargarProyecto(clave);
  const cacheEstados = leerJson(rutaCacheEstados(p.salida), {});
  const cacheVerif = leerJson(rutaCacheVerificaciones(p.salida), {});
  const listas = new Map();
  const ventana = p.entregas.ventanaDias;
  const nombres = repos?.length ? repos : Object.keys(p.repos);
  const login = p.autor === '@me' ? (await ghJson(['api', 'user'])).login : p.autor;

  // Is the PR's code already in `destino`? Cached by PR commit and target commit.
  async function estadoEn({ repo, numero, headSha, origen, destino, baseSha }) {
    const claveCache = `${repo}#${numero}->${destino}`;
    const destinoSha = (await arbolRama(p.owner, repo, destino)).sha;
    const previo = cacheEstados[claveCache];
    if (previo && previo.headSha === headSha && previo.pruebasSha === destinoSha) return previo;
    const r = { ...(await estadoFrentePruebas({ owner: p.owner, repo, cfgRepo: p.repos[repo], numero, prod: origen, pruebas: destino, baseSha })), headSha };
    if (!r.provisional) cacheEstados[claveCache] = r;
    return r;
  }

  async function verificaciones(repo, numero, headSha) {
    const claveCache = `${repo}#${numero}`;
    const archivos = await asegurarDiff(p, repo, numero, headSha);
    if (cacheVerif[claveCache]?.headSha === headSha) return cacheVerif[claveCache];
    const commits = await commitsPr(p.owner, repo, numero);
    const r = { headSha, ...verificar({ repo, archivos, commits, omitidas: p.repos[repo]?.reglas_omitidas, extra: reglasDeConfig(p.reglas) }) };
    cacheVerif[claveCache] = r;
    return r;
  }

  // Cached by PR commit in the same file as the checks, under their own prefix.
  async function commitsDe(repo, numero, headSha) {
    const claveCache = `commits:${repo}#${numero}`;
    if (cacheVerif[claveCache]?.headSha !== headSha) {
      const lista = (await commitsPr(p.owner, repo, numero)).map((c) => ({ sha: c.oid, titulo: c.messageHeadline, cuerpo: c.messageBody, autor: c.autor, fecha: c.fecha }));
      cacheVerif[claveCache] = { headSha, lista };
    }
    return cacheVerif[claveCache].lista;
  }

  // Same task on the repo's other lines (for example, the same fix on another portal's branch).
  async function hermanas(repo, linea, titulo) {
    const otras = p.repos[repo].lineas.filter((l) => l.prod !== linea.prod);
    return Promise.all(otras.map(async (l) => {
      const g = buscarGemela(titulo, await prsDeBase(p.owner, repo, l.prod, listas));
      return g ? { portal: l.portal, numero: g.numero, estado: g.estado } : { portal: l.portal, numero: null };
    }));
  }

  // Missing from production only with strong evidence: no file matches. With partial matches the
  // change usually arrived through another PR and production kept changing those lines afterwards.
  const ausenteEnProd = (e) => e.estado === 'no_en_pruebas' && e.iguales === 0;

  // An open PR to production that carries at least half of the testing PR's files, identical,
  // covers it even under a different title (for example, #463 carries the content of #459 and #460).
  async function cubiertaPor(repo, linea, numero) {
    const propios = await archivosPr(p.owner, repo, numero);
    if (!propios.length) return null;
    const candidatas = abiertas.filter((x) => x.repo === repo && x.pr.baseRefName === linea.prod);
    for (const { pr } of candidatas) {
      const blobs = new Map((await archivosPr(p.owner, repo, pr.number)).map((a) => [a.filename, a.sha]));
      const iguales = propios.filter((a) => blobs.get(a.filename) === a.sha).length;
      if (iguales * 2 >= propios.length) return pr.number;
    }
    return null;
  }

  const abiertas = (await Promise.all(nombres.map(async (repo) => {
    const args = ['pr', 'list', '-R', `${p.owner}/${repo}`, '--state', 'open', '--limit', '300', '--json', CAMPOS];
    if (p.autor) args.push('--author', p.autor);
    return (await ghJson(args)).map((pr) => ({ repo, pr }));
  }))).flat();

  async function procesarPr({ repo, pr, origen, solo }) {
    const cfgRepo = p.repos[repo];
    const linea = clasificarBase(cfgRepo, pr.baseRefName);
    const item = {
      id: `${repo}#${pr.number}`,
      repo,
      repoEtiqueta: cfgRepo.etiqueta ?? repo,
      numero: pr.number,
      titulo: pr.title,
      url: pr.url,
      base: pr.baseRefName,
      rama: pr.headRefName,
      portal: linea.portal,
      ambiente: linea.ambiente,
      motivoInactiva: linea.motivo,
      estadoPr: 'OPEN',
      autor: pr.author?.login,
      borrador: pr.isDraft,
      creada: pr.createdAt,
      actualizada: pr.updatedAt,
      dias: diasDesde(pr.createdAt),
      adiciones: pr.additions,
      eliminaciones: pr.deletions,
      archivos: pr.changedFiles,
      headSha: pr.headRefOid,
      descripcion: pr.body ?? '',
      revisionGithub: pr.reviewDecision || null,
      seguridad: esSeguridad(pr.title),
      esfuerzoTamano: esfuerzoPorTamano(pr.additions + pr.deletions, pr.changedFiles),
    };
    if (origen) item.paraRevisar = origen;
    if (solo) item.soloRevision = true;

    if (linea.ambiente === 'prod' || linea.ambiente === 'pruebas') {
      const otra = linea.ambiente === 'prod' ? linea.pruebas : linea.prod;
      const candidatas = (otra ? await prsDeBase(p.owner, repo, otra, listas) : []).filter((c) => c.number !== pr.number);
      item.gemela = buscarGemela(pr.title, candidatas);
      if (cfgRepo.lineas.length > 1) item.hermanas = await hermanas(repo, linea, pr.title);
    }

    if (linea.ambiente === 'prod' && linea.pruebas) {
      item.estadoPruebas = await estadoEn({ repo, numero: pr.number, headSha: pr.headRefOid, origen: linea.prod, destino: linea.pruebas });
    }

    if (linea.ambiente === 'pruebas' && linea.prod && !SOLO_PRUEBAS.test(pr.title) && (!item.gemela || item.gemela.estado === 'CLOSED')) {
      item.estadoProd = await estadoEn({ repo, numero: pr.number, headSha: pr.headRefOid, origen: linea.pruebas, destino: linea.prod });
      item.cubiertaPor = ausenteEnProd(item.estadoProd) ? await cubiertaPor(repo, linea, pr.number) : null;
      item.sinProd = ausenteEnProd(item.estadoProd) && !item.cubiertaPor;
    }

    if (linea.ambiente !== 'inactiva') {
      item.verificaciones = await verificaciones(repo, pr.number, pr.headRefOid);
      item.commits = await commitsDe(repo, pr.number, pr.headRefOid);
    }

    const explicacion = leerJson(rutaExplicacion(p.salida, repo, pr.number));
    if (explicacion) item.explicacion = { ...explicacion, desactualizada: explicacion.headSha !== pr.headRefOid };

    item.accion = accionSugerida(item);
    return item;
  }

  // Open PRs the owner has to review: requested on GitHub (remembered in the list) or added by link. They skip
  // the author filter; the ones that are also the owner's own keep their grouping and only get the mark.
  const marcas = new Map();
  const ajenas = [];
  if (p.autor) {
    const propios = new Set(abiertas.map(({ repo, pr }) => `${repo}#${pr.number}`));
    const sinBusqueda = new Set();
    const pedidas = (await Promise.all(nombres.map(async (repo) => {
      try {
        const args = ['pr', 'list', '-R', `${p.owner}/${repo}`, '--state', 'open', '--limit', '100', '--search', 'review-requested:@me', '--json', CAMPOS];
        return (await ghJson(args)).map((pr) => ({ repo, pr }));
      } catch (e) {
        console.error(`[seki-review/revisar] Requested PRs of ${repo} were not read: ${e?.code ?? 'error'}`);
        sinBusqueda.add(repo);
        return [];
      }
    }))).flat();
    if (pedidas.length) agregarRevisar(p, pedidas.map(({ repo, pr }) => ({ repo, numero: pr.number, origen: 'solicitada' })));
    const abiertasPedidas = new Map(pedidas.map(({ repo, pr }) => [`${repo}#${pr.number}`, pr]));
    const salen = new Set();
    const todas = leerRevisar(p, { todas: true }).filter((e) => nombres.includes(e.repo) && p.repos[e.repo]);
    // A dismissed entry only matters while GitHub still lists the PR as requested (judged only where the search worked).
    for (const e of todas) if (e.descartada && !sinBusqueda.has(e.repo) && !abiertasPedidas.has(`${e.repo}#${e.numero}`)) salen.add(`${e.repo}#${e.numero}`);
    const lista = todas.filter((e) => !e.descartada);
    await enParalelo(lista, 6, async (e) => {
      const id = `${e.repo}#${e.numero}`;
      if (propios.has(id)) { marcas.set(id, e.origen); return; }
      let pr = abiertasPedidas.get(id);
      if (!pr) {
        try {
          pr = await ghJson(['pr', 'view', String(e.numero), '-R', `${p.owner}/${e.repo}`, '--json', `${CAMPOS},state`]);
        } catch (err) {
          console.error(`[seki-review/revisar] ${id} was not read: ${err?.code ?? 'error'}`);
          return;
        }
        if (pr.state !== 'OPEN') { salen.add(id); return; }
      }
      ajenas.push({ repo: e.repo, pr, origen: e.origen, solo: true });
    });
    if (salen.size) podarRevisar(p, salen);
  }

  const prs = await enParalelo(
    [...abiertas.map((x) => ({ ...x, origen: marcas.get(`${x.repo}#${x.pr.number}`) })), ...ajenas.sort((x, y) => x.repo.localeCompare(y.repo) || x.pr.number - y.pr.number)],
    6,
    procesarPr,
  );

  // PRs already merged into testing whose code never reached production and that have no PR to production.
  const huerfanas = [];
  for (const repo of nombres) {
    for (const linea of p.repos[repo].lineas) {
      if (!linea.pruebas || !linea.prod) continue;
      const mergeadas = (await prsDeBase(p.owner, repo, linea.pruebas, listas)).filter((x) =>
        x.state === 'MERGED' && diasDesde(x.mergeada) <= (p.dias_huerfanas ?? DIAS_HUERFANAS) &&
        (!login || x.autor === login) && !SOLO_PRUEBAS.test(x.title));
      const prod = await prsDeBase(p.owner, repo, linea.prod, listas);
      const candidatas = mergeadas.filter((x) => {
        const g = buscarGemela(x.title, prod);
        return !g || g.estado === 'CLOSED';
      });
      huerfanas.push(...(await enParalelo(candidatas, 4, async (x) => {
        const estadoProd = await estadoEn({ repo, numero: x.number, headSha: x.headSha, origen: linea.pruebas, destino: linea.prod, baseSha: x.baseSha });
        if (!ausenteEnProd(estadoProd) || (await cubiertaPor(repo, linea, x.number))) return null;
        const explicacion = leerJson(rutaExplicacion(p.salida, repo, x.number));
        const archivos = await archivosPr(p.owner, repo, x.number);
        const adiciones = archivos.reduce((n, a) => n + a.additions, 0);
        const eliminaciones = archivos.reduce((n, a) => n + a.deletions, 0);
        return {
          id: `${repo}#${x.number}`,
          repo,
          repoEtiqueta: p.repos[repo].etiqueta ?? repo,
          numero: x.number,
          titulo: x.title,
          url: x.url,
          base: linea.pruebas,
          rama: x.rama,
          portal: linea.portal,
          ambiente: 'pruebas',
          estadoPr: 'MERGED',
          mergeada: x.mergeada ?? null,
          autor: x.autor,
          creada: x.creada,
          dias: diasDesde(x.creada),
          headSha: x.headSha,
          descripcion: x.body ?? '',
          seguridad: esSeguridad(x.title),
          adiciones,
          eliminaciones,
          archivos: archivos.length,
          esfuerzoTamano: esfuerzoPorTamano(adiciones + eliminaciones, archivos.length),
          verificaciones: await verificaciones(repo, x.number, x.headSha),
          commits: await commitsDe(repo, x.number, x.headSha),
          estadoProd,
          sinProd: true,
          explicacion: explicacion && { ...explicacion, desactualizada: explicacion.headSha !== x.headSha },
          accion: 'pruebas_sin_prod',
        };
      })).filter(Boolean));
    }
  }

  // Own PRs merged or closed within the window, on every configured base, that are not open or orphans.
  const enLista = new Set([...prs, ...huerfanas].map((x) => x.id));
  const recientes = [];
  for (const repo of nombres) {
    const cfgRepo = p.repos[repo];
    const bases = new Set(cfgRepo.lineas.flatMap((l) => [l.pruebas, l.prod]).filter((b) => typeof b === 'string'));
    for (const base of bases) {
      const linea = clasificarBase(cfgRepo, base);
      for (const x of await recientesDeBase(p.owner, repo, base, listas, ventana)) {
        const id = `${repo}#${x.number}`;
        const fecha = x.mergeada ?? x.cerrada;
        if (x.state === 'OPEN' || !fecha || diasDesde(fecha) > ventana || (login && x.autor !== login) || enLista.has(id)) continue;
        enLista.add(id);
        recientes.push({
          id, repo, repoEtiqueta: cfgRepo.etiqueta ?? repo, numero: x.number, titulo: x.title, url: x.url,
          base, rama: x.rama, portal: linea.portal, ambiente: linea.ambiente,
          estadoPr: x.mergeada ? 'MERGED' : 'CLOSED', mergeada: x.mergeada ?? null, cerrada: x.cerrada,
          descripcion: (x.body ?? '').slice(0, MAX_DESCRIPCION),
        });
      }
    }
  }

  const todas = [...prs, ...huerfanas];
  const visibles = incluirInactivas ? todas : todas.filter((x) => x.ambiente !== 'inactiva');
  const orden = (a, b) => a.repo.localeCompare(b.repo) || b.numero - a.numero;
  visibles.sort(orden);
  recientes.sort(orden);
  let anterior = null;
  try { anterior = leerJson(rutaInstantanea(p.salida)); } catch { /* unreadable: treated as missing */ }
  // A partial refresh replaces only the given repos' entries; without a readable previous snapshot it is a full one.
  const parcial = !!repos?.length && Array.isArray(anterior?.prs);
  const conservar = (lista) => (parcial ? (lista ?? []).filter((x) => !nombres.includes(x.repo)) : []);
  const instantanea = {
    proyecto: p.nombre ?? clave, clave, generado: new Date().toISOString(), owner: p.owner, acciones: ACCIONES,
    prs: [...conservar(anterior?.prs), ...visibles].sort(orden),
    recientes: [...conservar(anterior?.recientes), ...recientes].sort(orden),
  };
  // If this snapshot has no changes, the last detected ones are kept so two refreshes in a row do not wipe them.
  const cambios = await compararFotos(anterior, instantanea, p.owner).catch(() => null);
  instantanea.cambios = hayCambios(cambios) ? cambios : anterior?.cambios ?? null;
  escribirJson(rutaCacheEstados(p.salida), cacheEstados);
  escribirJson(rutaCacheVerificaciones(p.salida), cacheVerif);
  escribirJson(rutaInstantanea(p.salida), instantanea);
  try {
    await derivarEntregas(p, instantanea);
  } catch (e) {
    console.error(`[seki-review/entregas] ${e.message}`);
  }
  return instantanea;
}
