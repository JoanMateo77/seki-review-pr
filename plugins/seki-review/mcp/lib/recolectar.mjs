// Builds a project's PR snapshot: environment, twins, status against testing and production,
// fixed checks and suggested action.
import { clasificarBase, proyecto as cargarProyecto } from './config.mjs';
import { escribirJson, leerJson, rutaCacheEstados, rutaCacheVerificaciones, rutaExplicacion, rutaInstantanea } from './cache.mjs';
import { archivosPr, arbolRama, commitsPr, estadoFrentePruebas } from './estado.mjs';
import { buscarGemela } from './gemelas.mjs';
import { enParalelo, ghJson } from './proceso.mjs';
import { verificar } from './verificar.mjs';
import { reglasDeConfig } from './reglas.mjs';
import { compararFotos, hayCambios } from './cambios.mjs';
import { asegurarDiff } from './diffs.mjs';

const CAMPOS = 'number,title,url,baseRefName,headRefName,createdAt,updatedAt,additions,deletions,changedFiles,isDraft,headRefOid,author,reviewDecision,body';

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
const DIAS_HUERFANAS = 30;
const SOLO_PRUEBAS = /solo pruebas|pruebas only|ambiente de pruebas|staging only|testing only|^test(\(|:)|sincroniz|traer lo que ya est/i;
const diasDesde = (fecha) => Math.floor((Date.now() - new Date(fecha)) / 86400000);
const esSoloPruebasAutomaticas = (titulo) => /^test(\(|:)/i.test(titulo);
const esSeguridad = (titulo) => /seguridad|security|sqli|xss|csrf|inyecci|injection/i.test(titulo);

export function esfuerzoPorTamano(lineas, archivos) {
  const base = lineas <= 30 ? 1 : lineas <= 150 ? 2 : lineas <= 500 ? 3 : lineas <= 1500 ? 4 : 5;
  return Math.min(5, base + (archivos > 20 ? 1 : 0));
}

async function prsDeBase(owner, repo, base, cache) {
  const clave = `${repo}@${base}`;
  if (!cache.has(clave)) {
    cache.set(clave, (async () => {
      // REST rather than GraphQL: `gh pr list --state all` returns 504 on repos with many PRs.
      const todas = [];
      for (let pagina = 1; pagina <= PAGINAS_GEMELAS; pagina++) {
        const lote = await ghJson(['api', `repos/${owner}/${repo}/pulls?base=${encodeURIComponent(base)}&state=all&sort=created&direction=desc&per_page=100&page=${pagina}`]);
        todas.push(...lote.map((x) => ({
          number: x.number,
          title: x.title,
          state: x.merged_at ? 'MERGED' : x.state.toUpperCase(),
          autor: x.user?.login,
          url: x.html_url,
          creada: x.created_at,
          mergeada: x.merged_at,
          baseSha: x.base.sha,
          headSha: x.head.sha,
          rama: x.head.ref,
          body: x.body,
        })));
        if (lote.length < 100) break;
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

export async function recolectar({ proyecto: clave, repos, incluirInactivas = true } = {}) {
  const p = cargarProyecto(clave);
  const cacheEstados = leerJson(rutaCacheEstados(p.salida), {});
  const cacheVerif = leerJson(rutaCacheVerificaciones(p.salida), {});
  const listas = new Map();
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

  const prs = await enParalelo(abiertas, 6, async ({ repo, pr }) => {
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

    if (linea.ambiente === 'prod' || linea.ambiente === 'pruebas') {
      const otra = linea.ambiente === 'prod' ? linea.pruebas : linea.prod;
      const candidatas = (await prsDeBase(p.owner, repo, otra, listas)).filter((c) => c.number !== pr.number);
      item.gemela = buscarGemela(pr.title, candidatas);
      if (cfgRepo.lineas.length > 1) item.hermanas = await hermanas(repo, linea, pr.title);
    }

    if (linea.ambiente === 'prod') {
      item.estadoPruebas = await estadoEn({ repo, numero: pr.number, headSha: pr.headRefOid, origen: linea.prod, destino: linea.pruebas });
    }

    if (linea.ambiente === 'pruebas' && !SOLO_PRUEBAS.test(pr.title) && (!item.gemela || item.gemela.estado === 'CLOSED')) {
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
  });

  // PRs already merged into testing whose code never reached production and that have no PR to production.
  const huerfanas = [];
  for (const repo of nombres) {
    for (const linea of p.repos[repo].lineas) {
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

  const todas = [...prs, ...huerfanas];
  const visibles = incluirInactivas ? todas : todas.filter((x) => x.ambiente !== 'inactiva');
  visibles.sort((a, b) => a.repo.localeCompare(b.repo) || b.numero - a.numero);
  const instantanea = { proyecto: p.nombre ?? clave, clave, generado: new Date().toISOString(), owner: p.owner, acciones: ACCIONES, prs: visibles };
  // If this snapshot has no changes, the last detected ones are kept so two refreshes in a row do not wipe them.
  const anterior = repos?.length ? null : leerJson(rutaInstantanea(p.salida));
  const cambios = await compararFotos(anterior, instantanea, p.owner).catch(() => null);
  instantanea.cambios = hayCambios(cambios) ? cambios : anterior?.cambios ?? null;
  escribirJson(rutaCacheEstados(p.salida), cacheEstados);
  escribirJson(rutaCacheVerificaciones(p.salida), cacheVerif);
  escribirJson(rutaInstantanea(p.salida), instantanea);
  return instantanea;
}
