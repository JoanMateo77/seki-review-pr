// Arma la foto de PRs abiertas de un proyecto: ambiente, gemela, estado frente a pruebas y acción sugerida.
import { clasificarBase, proyecto as cargarProyecto } from './config.mjs';
import { escribirJson, leerJson, rutaCacheEstados, rutaExplicacion, rutaInstantanea } from './cache.mjs';
import { arbolRama, estadoFrentePruebas } from './estado.mjs';
import { buscarGemela } from './gemelas.mjs';
import { enParalelo, ghJson } from './proceso.mjs';

const CAMPOS = 'number,title,url,baseRefName,headRefName,createdAt,updatedAt,additions,deletions,changedFiles,isDraft,headRefOid,author';

export const ACCIONES = {
  solo_prod: 'Ya está en pruebas: falta producción',
  revisar_diferencias: 'En pruebas hay otra versión: revisar diferencias',
  pruebas_abierta: 'No está en pruebas: su PR de pruebas está abierta',
  sin_pruebas: 'No está en pruebas y no tiene PR de pruebas',
  hacia_pruebas: 'PR hacia pruebas',
  pruebas_automaticas: 'Solo pruebas automáticas',
  inactiva: 'Rama que ya no se usa',
  otra: 'Rama fuera de las líneas configuradas',
};

const PAGINAS_GEMELAS = 3;
const diasDesde = (fecha) => Math.floor((Date.now() - new Date(fecha)) / 86400000);
const esSoloPruebasAutomaticas = (titulo) => /^test(\(|:)/i.test(titulo);
const esSeguridad = (titulo) => /seguridad|sqli|xss|csrf|inyecci/i.test(titulo);

async function prsDeBase(owner, repo, base, cache) {
  const clave = `${repo}@${base}`;
  if (!cache.has(clave)) {
    cache.set(clave, (async () => {
      // REST y no GraphQL: `gh pr list --state all` da 504 en repos con muchas PRs.
      const todas = [];
      for (let pagina = 1; pagina <= PAGINAS_GEMELAS; pagina++) {
        const lote = await ghJson(['api', `repos/${owner}/${repo}/pulls?base=${encodeURIComponent(base)}&state=all&sort=created&direction=desc&per_page=100&page=${pagina}`]);
        todas.push(...lote.map((x) => ({ number: x.number, title: x.title, state: x.merged_at ? 'MERGED' : x.state.toUpperCase() })));
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
  if (pr.ambiente === 'pruebas') return 'hacia_pruebas';
  const e = pr.estadoPruebas?.estado;
  if (e === 'en_pruebas') return 'solo_prod';
  if (e === 'parcial') return 'revisar_diferencias';
  return pr.gemela?.estado === 'OPEN' ? 'pruebas_abierta' : 'sin_pruebas';
}

export async function recolectar({ proyecto: clave = 'demo', repos, incluirInactivas = true } = {}) {
  const p = cargarProyecto(clave);
  const cacheEstados = leerJson(rutaCacheEstados(p.salida), {});
  const listas = new Map();
  const nombres = repos?.length ? repos : Object.keys(p.repos);

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
      autor: pr.author?.login,
      borrador: pr.isDraft,
      creada: pr.createdAt,
      actualizada: pr.updatedAt,
      dias: diasDesde(pr.createdAt),
      adiciones: pr.additions,
      eliminaciones: pr.deletions,
      archivos: pr.changedFiles,
      headSha: pr.headRefOid,
      seguridad: esSeguridad(pr.title),
    };

    if (linea.ambiente === 'prod' || linea.ambiente === 'pruebas') {
      const otra = linea.ambiente === 'prod' ? linea.pruebas : linea.prod;
      const candidatas = (await prsDeBase(p.owner, repo, otra, listas)).filter((c) => c.number !== pr.number);
      item.gemela = buscarGemela(pr.title, candidatas);
    }

    if (linea.ambiente === 'prod') {
      const clave = `${repo}#${pr.number}`;
      const previo = cacheEstados[clave];
      const pruebasSha = (await arbolRama(p.owner, repo, linea.pruebas)).sha;
      item.estadoPruebas = previo && previo.headSha === pr.headRefOid && previo.pruebasSha === pruebasSha
        ? previo
        : { ...(await estadoFrentePruebas({ owner: p.owner, repo, cfgRepo, numero: pr.number, prod: linea.prod, pruebas: linea.pruebas })), headSha: pr.headRefOid };
      if (!item.estadoPruebas.provisional) cacheEstados[clave] = item.estadoPruebas;
    }

    const explicacion = leerJson(rutaExplicacion(p.salida, repo, pr.number));
    if (explicacion) item.explicacion = { ...explicacion, desactualizada: explicacion.headSha !== pr.headRefOid };

    item.accion = accionSugerida(item);
    return item;
  });

  const visibles = incluirInactivas ? prs : prs.filter((x) => x.ambiente !== 'inactiva');
  visibles.sort((a, b) => a.repo.localeCompare(b.repo) || b.numero - a.numero);
  const instantanea = { proyecto: p.nombre ?? clave, clave, generado: new Date().toISOString(), owner: p.owner, acciones: ACCIONES, prs: visibles };
  escribirJson(rutaCacheEstados(p.salida), cacheEstados);
  escribirJson(rutaInstantanea(p.salida), instantanea);
  return instantanea;
}
