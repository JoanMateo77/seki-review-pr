import { compilarPatron, coincidencias } from './patrones.mjs';
import { parecido, tokensTitulo } from './gemelas.mjs';

const UMBRAL_TITULO = 0.6;
const ORDEN_SENALES = ['rama', 'id', 'relacionada', 'titulo', 'manual'];

// Normalised branch key: lowercase, type prefix dropped, environment suffixes stripped.
// Empty when too short or when it (or the raw branch) is a configured base branch.
export function claveRama(rama, sufijos, { bases = [] } = {}) {
  const crudo = String(rama ?? '').toLowerCase();
  const basesMin = new Set(bases.map((b) => String(b).toLowerCase()));
  if (!crudo || basesMin.has(crudo)) return '';
  let clave = crudo.replace(/^[a-z]+\//, '');
  const lista = (sufijos ?? []).map((s) => String(s).toLowerCase()).filter(Boolean);
  for (let cambio = true; cambio;) {
    cambio = false;
    for (const s of lista) {
      if (clave.endsWith(s) && clave.length > s.length) {
        clave = clave.slice(0, -s.length);
        cambio = true;
      }
    }
  }
  return clave.length < 3 || basesMin.has(clave) ? '' : clave;
}

const textoDe = (pr) => pr.descripcion ?? pr.body ?? '';

export function idsDe(pr, re) {
  if (!re) return [];
  const todos = new Set();
  for (const campo of [pr.titulo, pr.rama, textoDe(pr)]) {
    if (typeof campo !== 'string') continue;
    for (const m of coincidencias(re, campo)) todos.add(m.toUpperCase());
  }
  return [...todos].sort();
}

// `owner/name#n` references on "Related:" lines, keyed `name#n` (snapshot repo keys are GitHub names).
// With `owner` given, references to another owner's repository are ignored.
export function relacionadasDe(descripcion, owner = null) {
  const salida = new Set();
  const re = /^(?:Relacionada|Related):\s*([\w.-]+)\/([\w.-]+)#(\d+)/gim;
  for (const m of String(descripcion ?? '').slice(0, 4096).matchAll(re)) {
    if (owner && m[1].toLowerCase() !== String(owner).toLowerCase()) continue;
    salida.add(`${m[2]}#${m[3]}`);
  }
  return [...salida];
}

const numeroDe = (id) => Number(String(id).split('#')[1]) || 0;
const cmpIds = (a, b) => {
  const ra = String(a).split('#')[0];
  const rb = String(b).split('#')[0];
  return ra < rb ? -1 : ra > rb ? 1 : numeroDe(a) - numeroDe(b) || (a < b ? -1 : a > b ? 1 : 0);
};

function patronDe(patronId) {
  if (patronId == null || patronId === '') return null;
  try {
    return compilarPatron(patronId, 'i'); // always case-insensitive
  } catch (e) {
    console.error(`[seki-review/entregas] entregas.patronId ignored: ${e.message}`);
    return null;
  }
}

export function agrupar(prs, cfg = {}, ajustes = {}) {
  const unirAj = ajustes?.unir ?? [];
  const separar = new Set(ajustes?.separar ?? []);
  const titulos = ajustes?.titulo ?? {};
  const re = patronDe(cfg.patronId);
  const todos = [...prs].sort((a, b) => cmpIds(a.id, b.id));
  const porTodos = new Map(todos.map((p) => [p.id, p]));
  // Separated PRs are taken out before any signal is indexed and come back as singletons at the end.
  const lista = todos.filter((p) => !separar.has(p.id));
  const separados = todos.filter((p) => separar.has(p.id));
  const porId = new Map(lista.map((p) => [p.id, p]));
  const maxPorSenal = Number.isInteger(cfg.maxPorSenal) && cfg.maxPorSenal > 0 ? cfg.maxPorSenal : 12;
  const omitidas = [];

  const padre = new Map(lista.map((p) => [p.id, p.id]));
  const raiz = (x) => {
    while (padre.get(x) !== x) {
      padre.set(x, padre.get(padre.get(x)));
      x = padre.get(x);
    }
    return x;
  };
  const eventos = [];
  const unir = (a, b, senal) => {
    eventos.push([a, b, senal]);
    const ra = raiz(a);
    const rb = raiz(b);
    if (ra !== rb) padre.set(rb, ra);
  };
  const indice = (senal, valoresDe) => {
    const cuenta = new Map();
    for (const p of lista) for (const v of new Set(valoresDe(p))) if (v) cuenta.set(v, (cuenta.get(v) ?? 0) + 1);
    // A value held by too many PRs is noise, not a delivery.
    for (const [v, n] of cuenta) if (n > maxPorSenal) omitidas.push(`${senal}:${v.slice(0, 40)}`);
    const primero = new Map();
    for (const p of lista) {
      for (const v of valoresDe(p)) {
        if (!v || cuenta.get(v) > maxPorSenal) continue;
        if (primero.has(v)) unir(primero.get(v), p.id, senal);
        else primero.set(v, p.id);
      }
    }
  };

  const clavesRama = new Map(todos.map((p) => [p.id, claveRama(p.rama, cfg.sufijosRama, { bases: cfg.bases })]));
  const idsPr = new Map(todos.map((p) => [p.id, idsDe(p, re)]));
  indice('rama', (p) => [clavesRama.get(p.id)]);
  indice('id', (p) => idsPr.get(p.id));
  if (omitidas.length) console.error(`[seki-review/entregas] values shared by more than ${maxPorSenal} PRs not used as join signals: ${omitidas.slice(0, 5).join(', ')}${omitidas.length > 5 ? ', ...' : ''}`);
  for (const p of lista) {
    for (const ref of relacionadasDe(textoDe(p), cfg.owner)) {
      if (ref !== p.id && porId.has(ref)) unir(p.id, ref, 'relacionada');
    }
  }

  // Title similarity: only PRs still alone, same repo and portal, opposite environment.
  // PRs whose ambiente is neither 'prod' nor 'pruebas' never enter this step.
  const enGrupo = new Set();
  for (const [a, b] of eventos) {
    enGrupo.add(a);
    enGrupo.add(b);
  }
  const cubos = new Map();
  for (const p of lista) {
    if (enGrupo.has(p.id) || (p.ambiente !== 'prod' && p.ambiente !== 'pruebas') || typeof p.titulo !== 'string') continue;
    const k = `${p.repo}\u0000${p.portal ?? ''}`;
    if (!cubos.has(k)) cubos.set(k, []);
    cubos.get(k).push(p);
  }
  const pares = [];
  for (const miembros of cubos.values()) {
    const porToken = new Map();
    for (const p of miembros.filter((x) => x.ambiente === 'prod')) {
      for (const t of tokensTitulo(p.titulo)) {
        if (!porToken.has(t)) porToken.set(t, []);
        porToken.get(t).push(p);
      }
    }
    for (const q of miembros.filter((x) => x.ambiente === 'pruebas')) {
      const vistos = new Set();
      for (const t of tokensTitulo(q.titulo)) {
        for (const p of porToken.get(t) ?? []) {
          if (vistos.has(p.id)) continue;
          vistos.add(p.id);
          const s = parecido(p.titulo, q.titulo);
          if (s >= UMBRAL_TITULO) pares.push([s, p.id, q.id]);
        }
      }
    }
  }
  pares.sort((x, y) => y[0] - x[0] || cmpIds(x[1], y[1]) || cmpIds(x[2], y[2]));
  const usadas = new Set();
  for (const [, a, b] of pares) {
    if (usadas.has(a) || usadas.has(b)) continue;
    usadas.add(a);
    usadas.add(b);
    unir(a, b, 'titulo');
  }

  for (const grupo of unirAj) {
    const conocidos = (grupo ?? []).filter((id) => porId.has(id));
    for (let i = 1; i < conocidos.length; i++) unir(conocidos[0], conocidos[i], 'manual');
  }

  // Final groups.
  const etiqueta = raiz;
  const grupos = new Map();
  for (const p of lista) {
    const e = etiqueta(p.id);
    if (!grupos.has(e)) grupos.set(e, []);
    grupos.get(e).push(p.id);
  }
  for (const p of separados) grupos.set(`\u0001${p.id}`, [p.id]);
  const senales = new Map();
  for (const [a, b, s] of eventos) {
    if (etiqueta(a) !== etiqueta(b)) continue;
    const e = etiqueta(a);
    if (!senales.has(e)) senales.set(e, new Set());
    senales.get(e).add(s);
  }

  const primero = (arr) => [...arr].sort()[0];
  const entregas = [...grupos.entries()].map(([e, miembros]) => {
    const ramas = miembros.map((id) => clavesRama.get(id)).filter(Boolean);
    const ids = [...new Set(miembros.flatMap((id) => idsPr.get(id)))].sort();
    const clave = ramas.length ? primero(ramas) : ids.length ? ids[0] : miembros[0];
    return { e, clave, miembros, ids };
  });
  // A separated PR can share its key with the group it left: keep the larger group's key, suffix the others.
  const porClave = new Map();
  for (const x of entregas) {
    if (!porClave.has(x.clave)) porClave.set(x.clave, []);
    porClave.get(x.clave).push(x);
  }
  for (const [, xs] of porClave) {
    if (xs.length < 2) continue;
    // Keys can repeat (a separated PR, or a capped signal); the largest non-separated group keeps the bare key.
    const separado = (x) => (x.e.startsWith('\u0001') ? 1 : 0);
    xs.sort((a, b) => separado(a) - separado(b) || b.miembros.length - a.miembros.length || cmpIds(a.miembros[0], b.miembros[0]));
    for (const x of xs.slice(1)) x.clave = `${x.clave}~${x.miembros[0]}`;
  }

  return entregas
    .map((x) => ({
      clave: x.clave,
      titulo: titulos[x.clave] ?? porTodos.get([...x.miembros].sort((a, b) => numeroDe(a) - numeroDe(b) || cmpIds(a, b))[0]).titulo,
      ids: x.ids,
      prs: x.miembros,
      señales: ORDEN_SENALES.filter((s) => senales.get(x.e)?.has(s)),
    }))
    .sort((a, b) => (a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0));
}
