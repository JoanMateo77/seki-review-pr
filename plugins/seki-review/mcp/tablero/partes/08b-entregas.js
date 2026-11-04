
// Deliveries board, the default tab. The DOM is built with createElement and textContent only: delivery titles
// and PR titles come from GitHub and from the user, so no data goes through innerHTML.
let ENTREGAS = /*ENTREGAS*/null;
const ETAPAS_TABLERO = [
  ['por_mergear_pruebas', 'To merge in testing', 'ambar'],
  ['qa_fallo', 'QA failed', 'rojo'],
  ['esperando_qa', 'Waiting for QA', 'ambar'],
  ['listo_produccion', 'Ready for production', 'verde'],
  ['en_produccion', 'In production', 'violeta'],
  ['cerrada', 'Closed', ''],
  ['descartada', 'Discarded', ''],
];
const ETAPA = Object.fromEntries(ETAPAS_TABLERO.map(([k, nombre, color]) => [k, { nombre, color }]));
const ALERTA_TABLERO = { gemela_faltante: 'Missing twin', orden: 'Merge order', sin_pruebas: 'No testing step', qa_fallo: 'QA failed', estancada: 'Stalled' };
const ESTADO_PR_TABLERO = { OPEN: ['Open', 'ambar'], MERGED: ['Merged', 'violeta'], CLOSED: ['Closed', ''] };
const EVENTO_TABLERO = { pr_mergeada: 'Merged', pr_cerrada: 'Closed without merging', entrega_cerrada: 'Delivery closed', entrega_ajustada: 'Delivery adjusted' };
const tablero = { pestana: 'entregas', descartadas: false, accion: null, ocupado: false };

function nodo(etiqueta, atributos = {}, ...hijos) {
  const n = document.createElement(etiqueta);
  for (const [k, v] of Object.entries(atributos)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'al') for (const [evento, fn] of Object.entries(v)) n.addEventListener(evento, fn);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const h of hijos.flat()) if (h !== null && h !== undefined && h !== false) n.append(h);
  return n;
}
const enlaceSeguro = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
const fechaCorta = (ts) => (ts ? new Date(ts).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const insignia = (texto, color = '', titulo = null) => nodo('span', { class: `estado ${color}`.trim(), title: titulo, text: texto });

function textoEvento(e) {
  const pr = e.pr ? ENTREGAS?.prs?.[e.pr] : null;
  const destino = e.tipo === 'pr_mergeada' ? (e.ambiente === 'prod' ? ' into production' : e.ambiente === 'pruebas' ? ' into testing' : '') : '';
  const sujeto = e.pr ? `${e.pr}${pr?.titulo ? ` ${pr.titulo}` : ''}${destino}` : e.entrega ?? (e.prs ?? []).join(', ');
  return `${EVENTO_TABLERO[e.tipo] ?? e.tipo}: ${sujeto}`;
}

async function accionEntrega(ruta, cuerpo) {
  if (tablero.ocupado) return;
  tablero.ocupado = true;
  pintarEntregas();
  try {
    ENTREGAS = await api(ruta, cuerpo);
    tablero.accion = null;
  } catch (err) {
    avisar(err.message);
  } finally {
    tablero.ocupado = false;
    pintarEntregas();
  }
}

function recargarEntregas() {
  if (!API) return;
  api('/api/entregas').then((d) => { ENTREGAS = d; pintarEntregas(); }, () => {});
}

function descartarAviso() {
  api('/api/visita', {}).then((r) => {
    ENTREGAS.visita = r.ts;
    ENTREGAS.desdeVisita = [];
    pintarEntregas();
  }, (err) => avisar(err.message));
}

function avisoVisita() {
  const eventos = ENTREGAS.desdeVisita ?? [];
  if (!API || !ENTREGAS.visita || !eventos.length) return null;
  const MAX = 8;
  const tocadas = ENTREGAS.entregas.filter((e) => eventos.some((ev) => (ev.pr && e.prs.includes(ev.pr)) || (ev.prs ?? []).some((id) => e.prs.includes(id))));
  return nodo('section', { class: 'aviso-visita', 'aria-label': 'Since the last visit' },
    nodo('header', {},
      nodo('h2', { text: `Since the last visit (${fechaCorta(ENTREGAS.visita)}): ${plural(eventos.length, 'event', 'events')}` }),
      nodo('button', { type: 'button', class: 'btn chico', text: 'Dismiss', al: { click: descartarAviso } })),
    nodo('ul', {}, eventos.slice(-MAX).reverse().map((e) => nodo('li', {}, nodo('span', { class: 'mono', text: fechaCorta(e.ts) }), ` ${textoEvento(e)}`)),
      eventos.length > MAX ? nodo('li', { text: `${eventos.length - MAX} earlier events not shown` }) : null),
    tocadas.length ? [nodo('h3', { text: 'Next action' }), nodo('ul', {}, tocadas.map((e) => nodo('li', { text: `${e.titulo}: ${e.siguiente}` })))] : null);
}

function matrizPrs(entrega) {
  const prs = entrega.prs.map((id) => [id, ENTREGAS.prs[id]]).filter(([, pr]) => pr && (pr.ambiente === 'prod' || pr.ambiente === 'pruebas'));
  const repos = [...new Set(prs.map(([, pr]) => pr.repoEtiqueta ?? pr.repo))].sort();
  const celda = (repo, ambiente) => nodo('td', {}, prs.filter(([, pr]) => (pr.repoEtiqueta ?? pr.repo) === repo && pr.ambiente === ambiente).map(([id, pr]) => {
    const [estadoTexto, color] = ESTADO_PR_TABLERO[pr.estadoPr] ?? [pr.estadoPr ?? '', ''];
    const titulo = `${id} · ${pr.portal ?? ''} · ${estadoTexto}${pr.titulo ? ` · ${pr.titulo}` : ''}`;
    const url = enlaceSeguro(pr.url);
    return nodo(url ? 'a' : 'span', { href: url, target: url ? '_blank' : null, rel: url ? 'noopener noreferrer' : null, title: titulo },
      nodo('span', { class: `punto-estado ${color}`.trim(), 'aria-hidden': 'true' }), nodo('span', { class: 'mono', text: `#${pr.numero}` }), nodo('span', { class: 'sr', text: ` ${estadoTexto}` }));
  }));
  return nodo('table', { class: 'matriz' },
    nodo('thead', {}, nodo('tr', {}, nodo('th', { text: 'Repo' }), nodo('th', { text: 'Testing' }), nodo('th', { text: 'Production' }))),
    nodo('tbody', {}, repos.map((r) => nodo('tr', {}, nodo('td', { text: r }), celda(r, 'pruebas'), celda(r, 'prod')))));
}

function accionesDe(entrega) {
  if (!API) return null;
  const a = tablero.accion?.clave === entrega.clave ? tablero.accion : null;
  const abrir = (tipo) => () => { tablero.accion = { clave: entrega.clave, tipo }; pintarEntregas(); };
  const cancelar = nodo('button', { type: 'button', class: 'btn-texto', text: 'Cancel', al: { click: () => { tablero.accion = null; pintarEntregas(); } } });
  const ocupado = tablero.ocupado || null;
  if (a?.tipo === 'unir') {
    const otras = ENTREGAS.entregas.filter((e) => e.clave !== entrega.clave && e.etapa !== 'descartada');
    const lista = nodo('select', { 'aria-label': 'Delivery to join' }, nodo('option', { value: '', text: 'Choose a delivery' }), otras.map((e) => nodo('option', { value: e.clave, text: `${e.titulo} (${ETAPA[e.etapa]?.nombre ?? e.etapa})` })));
    const unir = () => {
      const otra = otras.find((e) => e.clave === lista.value);
      if (!otra) return avisar('Choose the delivery to join');
      accionEntrega('/api/entregas/ajuste', { tipo: 'unir', prs: [...entrega.prs, ...otra.prs] });
    };
    return nodo('div', { class: 'acciones-entrega' }, lista, nodo('button', { type: 'button', class: 'btn chico primario', disabled: ocupado, text: 'Join', al: { click: unir } }), cancelar);
  }
  if (a?.tipo === 'separar') {
    return nodo('div', { class: 'acciones-entrega' },
      nodo('div', { class: 'separar-lista' }, entrega.prs.map((id) => nodo('div', {},
        nodo('button', { type: 'button', class: 'btn chico', disabled: ocupado, text: 'Separate', al: { click: () => accionEntrega('/api/entregas/ajuste', { tipo: 'separar', pr: id }) } }),
        nodo('span', { class: 'mono', text: id }), nodo('span', { class: 'recorte', text: ENTREGAS.prs[id]?.titulo ?? '' })))),
      cancelar);
  }
  if (a?.tipo === 'titulo') {
    const campo = nodo('input', { type: 'text', maxlength: '200', value: entrega.titulo, 'aria-label': 'Delivery title' });
    const guardar = () => accionEntrega('/api/entregas/ajuste', { tipo: 'titulo', clave: entrega.clave, titulo: campo.value });
    campo.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); guardar(); } });
    setTimeout(() => campo.focus(), 0);
    return nodo('div', { class: 'acciones-entrega' }, campo, nodo('button', { type: 'button', class: 'btn chico primario', disabled: ocupado, text: 'Save', al: { click: guardar } }), cancelar);
  }
  if (a?.tipo === 'cerrar') {
    return nodo('div', { class: 'acciones-entrega' },
      nodo('span', { class: 'pregunta', text: 'Closing moves the delivery to Closed. A new production PR in this delivery reopens it.' }),
      nodo('button', { type: 'button', class: 'btn chico primario', disabled: ocupado, text: 'Confirm close', al: { click: () => accionEntrega('/api/entregas/cerrar', { clave: entrega.clave }) } }), cancelar);
  }
  const otrasHay = ENTREGAS.entregas.some((e) => e.clave !== entrega.clave && e.etapa !== 'descartada');
  return nodo('div', { class: 'acciones-entrega' },
    otrasHay ? nodo('button', { type: 'button', class: 'btn-texto', text: 'Join', title: 'Join with another delivery', al: { click: abrir('unir') } }) : null,
    entrega.prs.length > 1 ? nodo('button', { type: 'button', class: 'btn-texto', text: 'Split', title: 'Take a PR out of this delivery', al: { click: abrir('separar') } }) : null,
    nodo('button', { type: 'button', class: 'btn-texto', text: 'Rename', al: { click: abrir('titulo') } }),
    entrega.etapa === 'en_produccion' ? nodo('button', { type: 'button', class: 'btn-texto', text: 'Close', title: 'Mark the delivery as finished', al: { click: abrir('cerrar') } }) : null);
}

function tarjetaEntrega(entrega) {
  const alertas = new Map();
  for (const pista of entrega.pistas ?? []) for (const x of pista.alertas ?? []) alertas.set(`${x.tipo}|${x.detalle}`, x);
  const multiples = (entrega.pistas ?? []).length > 1 || (entrega.pistas ?? []).some((x) => x.portal !== 'main');
  const ultimo = entrega.ultimoEvento;
  const abiertaEnPrs = entrega.prs.find((id) => FOTO.prs.some((p) => p.id === id));
  return nodo('article', { class: 'tarjeta', 'data-clave': entrega.clave },
    nodo('h3', { text: entrega.titulo }),
    entrega.ids?.length ? nodo('div', { class: 'ids mono', text: entrega.ids.join(' · ') }) : null,
    multiples ? nodo('div', { class: 'pistas' }, entrega.pistas.map((x) => insignia(`${x.portal} · ${ETAPA[x.etapa]?.nombre ?? x.etapa}`, ETAPA[x.etapa]?.color ?? ''))) : null,
    matrizPrs(entrega),
    alertas.size ? nodo('div', { class: 'alertas' }, [...alertas.values()].map((x) => insignia(ALERTA_TABLERO[x.tipo] ?? x.tipo, x.tipo === 'qa_fallo' || x.tipo === 'orden' ? 'rojo' : 'ambar', x.detalle))) : null,
    nodo('div', { class: 'siguiente', text: `Next: ${entrega.siguiente}` }),
    ultimo ? nodo('div', { class: 'ultimo', text: `Last event: ${textoEvento(ultimo)} · ${fechaCorta(ultimo.ts)}` }) : null,
    abiertaEnPrs ? nodo('div', {}, nodo('button', { type: 'button', class: 'btn-texto', text: `Open ${abiertaEnPrs} in the PR view`, al: { click: () => { aplicarPestana('prs'); seleccionar(abiertaEnPrs); } } })) : null,
    accionesDe(entrega));
}

function pintarEntregas() {
  const raiz = $('entregas');
  if (!raiz) return;
  if (!ENTREGAS) {
    raiz.replaceChildren(nodo('div', { class: 'vacio' }, nodo('p', { text: API ? 'No deliveries yet. Refresh the status to compute them.' : 'No deliveries in this file. Open the dashboard from Claude Code and refresh the status.' })));
    return;
  }
  const visibles = ETAPAS_TABLERO.filter(([k]) => k !== 'descartada' || tablero.descartadas);
  const descartadas = ENTREGAS.entregas.filter((e) => e.etapa === 'descartada').length;
  const casilla = nodo('input', { type: 'checkbox', checked: tablero.descartadas || null, al: { change: (ev) => { tablero.descartadas = ev.target.checked; pintarEntregas(); } } });
  raiz.replaceChildren(
    avisoVisita() ?? '',
    nodo('div', { class: 'entregas-cabecera' },
      nodo('span', { text: `${plural(ENTREGAS.entregas.length - descartadas, 'delivery', 'deliveries')} · computed ${fechaCorta(ENTREGAS.generado)}` }),
      descartadas ? nodo('label', {}, casilla, `Show discarded (${descartadas})`) : null),
    nodo('div', { class: 'columnas' }, visibles.map(([k, nombre, color]) => {
      const grupo = ENTREGAS.entregas.filter((e) => e.etapa === k);
      return nodo('section', { class: 'columna', 'aria-label': nombre },
        nodo('h2', {}, nodo('span', { class: `punto-estado ${color}`.trim(), 'aria-hidden': 'true' }), nombre, nodo('span', { class: 'cuenta', text: String(grupo.length) })),
        grupo.length ? grupo.map(tarjetaEntrega) : nodo('div', { class: 'sin-tarjetas', text: 'None' }));
    })));
}

function aplicarPestana(pestana) {
  tablero.pestana = pestana;
  document.body.dataset.pestana = pestana;
  $('entregas').hidden = pestana !== 'entregas';
  document.querySelectorAll('[data-pestana]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pestana === pestana)));
  if (pestana === 'entregas') pintarEntregas();
}

document.querySelectorAll('[data-pestana]').forEach((b) => b.addEventListener('click', () => aplicarPestana(b.dataset.pestana)));
// The PR view's shortcuts act on rows that are hidden while the board is shown.
document.addEventListener('keydown', (ev) => {
  if (tablero.pestana !== 'entregas' || ev.target.matches('input, textarea, select') || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (['j', 'k', 'o', '/', '[', ']', 'ArrowDown', 'ArrowUp'].includes(ev.key)) ev.stopImmediatePropagation();
}, true);

aplicarPestana(FOTO.prs.some((p) => p.id === inicial) ? 'prs' : 'entregas');
// The first served visit only sets the mark, so the next one has something to compare with.
if (API && ENTREGAS && !ENTREGAS.visita) api('/api/visita', {}).then((r) => { ENTREGAS.visita = r.ts; }, () => {});
