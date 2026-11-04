// Stages, alerts and tracks of a delivery. Pure: no file or clock access except through arguments.

const DIA = 86400000;
export const RANGO_ETAPA = { por_mergear_pruebas: 0, qa_fallo: 1, esperando_qa: 2, listo_produccion: 3, en_produccion: 4, cerrada: 5 };

function exigirAhora(ahora) {
  if (!(ahora instanceof Date) || Number.isNaN(ahora.getTime())) throw new TypeError('`ahora` must be a valid Date');
}
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const lineasDe = (cfgRepos, repo) => cfgRepos?.[repo]?.lineas ?? [];
const esAmbiente = (pr) => pr.ambiente === 'prod' || pr.ambiente === 'pruebas';
const descartadaPr = (pr) => pr.estadoPr === 'CLOSED' && !pr.mergeada;
const fusionada = (pr) => pr.estadoPr === 'MERGED';
const masReciente = (prs) => prs.map((p) => p.mergeada).filter(Boolean).sort().at(-1) ?? null;

// Repos with more than one configured line define the portals; single-line repos are shared by every track.
export function pistasDe(entrega, prsPorId, cfgRepos) {
  const prs = (entrega.prs ?? []).map((id) => prsPorId.get(id)).filter(Boolean);
  const multi = (pr) => lineasDe(cfgRepos, pr.repo).length > 1;
  const portales = [...new Set(prs.filter((pr) => multi(pr) && esAmbiente(pr)).map((pr) => pr.portal))].sort(cmp);
  if (!portales.length) return [{ portal: 'main', prs: [...entrega.prs] }];
  return portales.map((portal) => ({
    portal,
    prs: entrega.prs.filter((id) => {
      const pr = prsPorId.get(id);
      return pr && (!multi(pr) || pr.portal === portal);
    }),
  }));
}

const vivas = (pista, prsPorId) => pista.prs.map((id) => prsPorId.get(id)).filter((pr) => pr && esAmbiente(pr) && !descartadaPr(pr));
const relevantes = (pista, prsPorId) => pista.prs.map((id) => prsPorId.get(id)).filter((pr) => pr && esAmbiente(pr));
const resultadoQa = (qa) => (qa?.resultado === 'ok' ? 'ok' : qa?.resultado === 'fallo' || qa?.resultado === 'fail' ? 'fallo' : null);

// Spec 6.2 order. A QA result older than the newest testing merge of the track is ignored.
export function etapaDePista(pista, prsPorId, { qa = null, cerrada = false, ahora, cfg = {} } = {}) {
  exigirAhora(ahora);
  const todas = relevantes(pista, prsPorId);
  const vivasPista = vivas(pista, prsPorId);
  if (todas.length && !vivasPista.length) return 'descartada';
  const prod = vivasPista.filter((pr) => pr.ambiente === 'prod');
  const pruebas = vivasPista.filter((pr) => pr.ambiente === 'pruebas');
  // Production needs every live line of the track to have a production PR, all merged.
  const lineasVivas = new Set(vivasPista.map((x) => `${x.repo}|${x.portal}`));
  const lineasProd = new Set(prod.map((x) => `${x.repo}|${x.portal}`));
  if (prod.length && prod.every(fusionada) && [...lineasVivas].every((l) => lineasProd.has(l))) {
    const fecha = masReciente(prod);
    const dias = cfg.cerrarTrasDias ?? 7;
    return cerrada || (fecha && new Date(ahora) - new Date(fecha) > dias * DIA) ? 'cerrada' : 'en_produccion';
  }
  if (!pruebas.length) return 'listo_produccion';
  const ultimaFusion = masReciente(pruebas);
  const resultado = resultadoQa(qa);
  const vigente = resultado && !(ultimaFusion && qa.ts && new Date(qa.ts) < new Date(ultimaFusion));
  if (vigente && resultado === 'fallo') return 'qa_fallo';
  if (vigente && resultado === 'ok') return 'listo_produccion';
  return pruebas.every(fusionada) ? 'esperando_qa' : 'por_mergear_pruebas';
}

const ordenDe = (cfgRepos, repo) => cfgRepos?.[repo]?.orden ?? (lineasDe(cfgRepos, repo).length > 1 ? 2 : 1);

export function alertasDePista(pista, prsPorId, { etapa, qa = null, ahora, cfg = {}, cfgRepos = {} } = {}) {
  exigirAhora(ahora);
  const alertas = [];
  const lista = vivas(pista, prsPorId);

  // gemela_faltante: a line with PRs on one side only.
  const lineas = new Map();
  for (const pr of lista) {
    const linea = lineasDe(cfgRepos, pr.repo).find((l) => l.portal === pr.portal);
    if (!linea?.prod || !linea?.pruebas) continue;
    const k = `${pr.repo}|${pr.portal}`;
    if (!lineas.has(k)) lineas.set(k, { repo: pr.repo, portal: pr.portal, prod: [], pruebas: [] });
    lineas.get(k)[pr.ambiente].push(pr.id);
  }
  for (const l of [...lineas.values()].sort((a, b) => cmp(a.repo, b.repo))) {
    if (l.pruebas.length && !l.prod.length) alertas.push({ tipo: 'gemela_faltante', prs: l.pruebas, detalle: `${l.repo} (${l.portal}) has a testing PR without a production PR` });
    if (l.prod.length && !l.pruebas.length) alertas.push({ tipo: 'gemela_faltante', prs: l.prod, detalle: `${l.repo} (${l.portal}) has a production PR without a testing PR` });
  }

  // orden: a repo of higher order merged in an environment before a repo of lower order.
  for (const ambiente of ['pruebas', 'prod']) {
    const delAmbiente = lista.filter((pr) => pr.ambiente === ambiente);
    const implicadas = new Set();
    for (const alto of delAmbiente.filter(fusionada)) {
      for (const bajo of delAmbiente) {
        if (ordenDe(cfgRepos, bajo.repo) >= ordenDe(cfgRepos, alto.repo)) continue;
        if (!fusionada(bajo) || (bajo.mergeada && alto.mergeada && bajo.mergeada > alto.mergeada)) {
          implicadas.add(alto.id);
          implicadas.add(bajo.id);
        }
      }
    }
    if (implicadas.size) alertas.push({ tipo: 'orden', prs: [...implicadas].sort(cmp), detalle: `A repo of higher order was merged in ${ambiente} before one of lower order` });
  }

  const pruebas = lista.filter((pr) => pr.ambiente === 'pruebas');
  if (etapa === 'listo_produccion' && !pruebas.length) {
    alertas.push({ tipo: 'sin_pruebas', prs: lista.map((pr) => pr.id), detalle: 'No testing step' });
  }
  if (etapa === 'qa_fallo') alertas.push({ tipo: 'qa_fallo', prs: pruebas.map((pr) => pr.id), detalle: 'The last QA result failed' });
  if (etapa === 'esperando_qa' || etapa === 'listo_produccion') {
    const base = masReciente(pruebas) ?? lista.map((pr) => pr.creada).filter(Boolean).sort().at(-1);
    const desde = etapa === 'listo_produccion' && qa?.ts && (!base || qa.ts > base) ? qa.ts : base;
    const limite = cfg.alertaDias ?? 5;
    if (desde && new Date(ahora) - new Date(desde) > limite * DIA) {
      alertas.push({ tipo: 'estancada', prs: lista.map((pr) => pr.id), detalle: `More than ${limite} days in ${etapa}` });
    }
  }
  return alertas;
}

// Least advanced track wins; discarded tracks are ignored unless every track is discarded.
export function etapaDeEntrega(pistas) {
  const activas = pistas.filter((x) => x.etapa !== 'descartada');
  if (!activas.length) return 'descartada';
  return activas.reduce((a, b) => (RANGO_ETAPA[b.etapa] < RANGO_ETAPA[a.etapa] ? b : a)).etapa;
}

// entregas.json content from grouped deliveries and the events read so far.
export function construirEntregas({ entregas, prsPorId, cfgRepos, cfg = {}, eventos = [], ahora, qaDe = () => null }) {
  exigirAhora(ahora);
  // A closure is keyed by the PRs it covered, not by the delivery key (keys change when groups change):
  // the delivery stays closed while every current production PR was covered; a new one reopens it.
  const cierres = eventos.filter((e) => e.tipo === 'entrega_cerrada' && Array.isArray(e.prs)).map((e) => new Set(e.prs));
  const cerrada = (entrega) => {
    const prod = entrega.prs.filter((id) => prsPorId.get(id)?.ambiente === 'prod');
    return prod.length > 0 && cierres.some((c) => prod.every((id) => c.has(id)));
  };
  return entregas.flatMap((entrega) => {
    const cerradaEntrega = cerrada(entrega);
    const pistas = pistasDe(entrega, prsPorId, cfgRepos).filter((pista) => relevantes(pista, prsPorId).length).map((pista) => {
      const qa = qaDe(entrega, pista) ?? null;
      const etapa = etapaDePista(pista, prsPorId, { qa, cerrada: cerradaEntrega, ahora, cfg });
      return { ...pista, etapa, alertas: alertasDePista(pista, prsPorId, { etapa, qa, ahora, cfg, cfgRepos }) };
    });
    const mios = new Set(entrega.prs);
    const ultimoEvento = eventos.filter((e) => (e.pr && mios.has(e.pr)) || (Array.isArray(e.prs) && e.prs.some((id) => mios.has(id)))).sort((a, b) => cmp(b.ts, a.ts) || cmp(b.id, a.id))[0] ?? null;
    return pistas.length ? [{ ...entrega, pistas, etapa: etapaDeEntrega(pistas), ultimoEvento }] : [];
  });
}
