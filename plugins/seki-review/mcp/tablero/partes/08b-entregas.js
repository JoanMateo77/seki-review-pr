
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
const ALERTA_TABLERO = { gemela_faltante: 'Missing twin', orden: 'Merge order', sin_pruebas: 'No testing step', qa_fallo: 'QA failed', qa_bloqueada: 'QA blocked', estancada: 'Stalled' };
const ESTADO_PR_TABLERO = { OPEN: ['Open', 'ambar'], MERGED: ['Merged', 'violeta'], CLOSED: ['Closed', ''] };
const EVENTO_TABLERO = { pr_mergeada: 'Merged', pr_cerrada: 'Closed without merging', entrega_cerrada: 'Delivery closed', entrega_ajustada: 'Delivery adjusted' };
const tablero = { pestana: 'entregas', descartadas: false, accion: null, ocupado: false };
// QA controls: cards selected for a guide, the guide job in flight, the last result panel and the tracker state.
// `generando` covers the guide job only; `ocupado` covers an import or a tracker write, so one never blocks the other.
const qa = { sel: new Set(), generando: false, guia: null, mensajeGuia: null, espera: null, importacion: null, mensajeOperacion: null, rastreador: null, ocupado: false };
const MAX_QA_BYTES = 5 * 1024 * 1024;
// Guide polling: a few failed polls in a row are tolerated; a notice appears after a while and polling stops at the cap.
const QA_FALLOS_SEGUIDOS = 5;
const QA_AVISO_MS = 60 * 1000;
const QA_LIMITE_MS = 5 * 60 * 1000;
const QA_SONDEO_MS = 1500;

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
  api('/api/entregas').then((d) => { ENTREGAS = d; for (const k of [...qa.sel]) if (!d.entregas.some((e) => e.clave === k && entregaElegibleQa(e))) qa.sel.delete(k); pintarEntregas(); }, (err) => avisar(`Deliveries not updated: ${err.message}`));
  refrescarRastreador();
}

function refrescarRastreador() {
  if (!API) return;
  api('/api/qa/rastreador').then((r) => { qa.rastreador = r; pintarEntregas(); }, () => {});
}

const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms));

// The token travels in a header, never in a URL: the file is fetched and offered through a temporary Blob URL.
async function descargarQa(nombre) {
  try {
    const r = await fetch(`/api/qa/archivo?nombre=${encodeURIComponent(nombre)}`, { headers: { 'X-Seki-Token': API.token } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    const url = URL.createObjectURL(await r.blob());
    const a = nodo('a', { href: url, download: nombre });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (err) {
    avisar(`Download failed: ${err.message}`);
  }
}

async function generarGuiaQa(cuerpo) {
  if (qa.generando) return;
  qa.generando = true;
  qa.guia = null;
  qa.mensajeGuia = null;
  qa.espera = null;
  pintarEntregas();
  const inicio = Date.now();
  let fallos = 0;
  try {
    const { trabajo } = await api('/api/qa/guia', { ...cuerpo, explicarFaltantes: $('qa-explicar')?.checked === true });
    sondear();
    for (;;) {
      await pausa(QA_SONDEO_MS);
      let r;
      try {
        r = await api(`/api/qa/guia?trabajo=${encodeURIComponent(trabajo)}`);
        fallos = 0;
      } catch (err) {
        if (/unknown job/i.test(err.message)) { qa.mensajeGuia = 'The guide job is no longer known to the server. Generate the guide again.'; break; }
        if (++fallos >= QA_FALLOS_SEGUIDOS) { qa.mensajeGuia = `The guide status could not be read: ${err.message}`; break; }
        continue;
      }
      if (r.estado === 'terminado') {
        if (r.resultado) qa.guia = r.resultado;
        else qa.mensajeGuia = 'The result is no longer available. Generate the guide again.';
        break;
      }
      if (r.estado === 'error') { qa.mensajeGuia = r.mensaje ?? 'The guide could not be generated'; break; }
      if (Date.now() - inicio > QA_LIMITE_MS) { qa.mensajeGuia = 'The guide is taking too long and is no longer being followed. Check the job list in the status bar and generate the guide again if it ends.'; break; }
      const espera = Date.now() - inicio > QA_AVISO_MS ? 'Still waiting: another guide or the PDF export is taking longer than usual.' : null;
      if (espera !== qa.espera) { qa.espera = espera; pintarEntregas(); }
    }
  } catch (err) {
    qa.mensajeGuia = err.message;
  } finally {
    qa.generando = false;
    qa.espera = null;
    pintarEntregas();
    sondear();
  }
}

function base64De(buffer) {
  const bytes = new Uint8Array(buffer);
  let texto = '';
  for (let i = 0; i < bytes.length; i += 0x8000) texto += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(texto);
}

async function importarQa(archivo) {
  if (!archivo || qa.ocupado) return;
  if (!/\.xlsx$/i.test(archivo.name)) return avisar('Choose an .xlsx file');
  if (archivo.size > MAX_QA_BYTES) return avisar('The file exceeds 5 MB');
  qa.ocupado = true;
  qa.importacion = null;
  qa.mensajeOperacion = null;
  pintarEntregas();
  try {
    qa.importacion = await api('/api/qa/importar', { nombre: archivo.name, contenido: base64De(await archivo.arrayBuffer()) });
  } catch (err) {
    qa.mensajeOperacion = `Import failed: ${err.message}`;
  } finally {
    qa.ocupado = false;
    pintarEntregas();
    recargarEntregas();
  }
}

async function actualizarRastreador() {
  if (qa.ocupado) return;
  qa.ocupado = true;
  qa.mensajeOperacion = null;
  pintarEntregas();
  try {
    const r = await api('/api/qa/rastreador', {});
    qa.mensajeOperacion = r.escrito ? `Spreadsheet updated: ${plural(r.celdas, 'cell', 'cells')}` : `Spreadsheet not updated: ${r.motivo}`;
  } catch (err) {
    qa.mensajeOperacion = `Spreadsheet not updated: ${err.message}`;
  } finally {
    qa.ocupado = false;
    pintarEntregas();
    recargarEntregas();
  }
}

const entradaArchivoQa = nodo('input', { type: 'file', accept: '.xlsx', class: 'sr', 'aria-label': 'QA result file', tabindex: '-1', al: { change: (ev) => { const f = ev.target.files[0]; ev.target.value = ''; importarQa(f); } } });

// Builds DOM from the description: strings become text nodes and `text` never reaches innerHTML.
function construirQa(d) {
  if (d === null || d === undefined) return null;
  if (typeof d === 'string') return document.createTextNode(d);
  const { accion, nombre, ...atributos } = d.a;
  const al = accion === 'descargar' ? { click: () => descargarQa(nombre) }
    : accion === 'descartar' ? { click: () => { qa.guia = null; qa.importacion = null; qa.mensajeGuia = null; qa.mensajeOperacion = null; if (qa.rastreador) delete qa.rastreador.aviso; pintarEntregas(); } } : null;
  return nodo(d.e, { ...atributos, al }, d.h.map(construirQa));
}

const panelQa = () => construirQa(descripcionPanelQa(qa));

// Selecting a card repaints only the toolbar, so the checkbox keeps keyboard focus.
function pintarBarraQa() {
  const actual = document.querySelector('.barra-qa');
  const nueva = barraQa();
  if (actual && nueva) actual.replaceWith(nueva);
}

function barraQa() {
  if (!API) return null;
  const r = qa.rastreador;
  const ocupado = qa.ocupado || tablero.ocupado || null;
  const generando = qa.generando || null;
  const seleccion = qa.sel.size;
  return nodo('div', { class: 'barra-qa' },
    nodo('button', { type: 'button', class: 'btn chico', disabled: generando, text: 'QA guide since last cut', al: { click: () => generarGuiaQa({ desde: 'ultimo-corte' }) } }),
    nodo('button', { type: 'button', class: 'btn chico', disabled: generando || !seleccion || null, text: `QA guide for selected (${seleccion})`, al: { click: () => generarGuiaQa({ claves: [...qa.sel] }) } }),
    nodo('button', { type: 'button', class: 'btn chico', disabled: ocupado, text: 'Import QA result', al: { click: () => entradaArchivoQa.click() } }),
    r?.configurado ? nodo('button', { type: 'button', class: 'btn chico', disabled: ocupado || !r.pendientes || null, text: `Update spreadsheet (${r.pendientes})`, al: { click: actualizarRastreador } }) : null,
    nodo('label', {}, nodo('input', { type: 'checkbox', id: 'qa-explicar', checked: $('qa-explicar')?.checked || null }), 'Explain PRs without steps'),
    entradaArchivoQa);
}

function descartarAviso() {
  api('/api/visita', {}).then((r) => {
    ENTREGAS.visita = r.ts;
    ENTREGAS.desdeVisita = [];
    ENTREGAS.totalDesdeVisita = 0;
    pintarEntregas();
  }, (err) => avisar(err.message));
}

function avisoVisita() {
  const eventos = ENTREGAS.desdeVisita ?? [];
  if (!API || !ENTREGAS.visita || !eventos.length) return null;
  const MAX = 8;
  const total = ENTREGAS.totalDesdeVisita ?? eventos.length;
  const tocadas = ENTREGAS.entregas.filter((e) => eventos.some((ev) => (ev.pr && e.prs.includes(ev.pr)) || (ev.prs ?? []).some((id) => e.prs.includes(id))));
  return nodo('section', { class: 'aviso-visita', 'aria-label': 'Since the last visit' },
    nodo('header', {},
      nodo('h2', { text: `Since the last visit (${fechaCorta(ENTREGAS.visita)}): ${plural(total, 'event', 'events')}` }),
      nodo('button', { type: 'button', class: 'btn chico', text: 'Dismiss', al: { click: descartarAviso } })),
    nodo('ul', {}, eventos.slice(-MAX).reverse().map((e) => nodo('li', {}, nodo('span', { class: 'mono', text: fechaCorta(e.ts) }), ` ${textoEvento(e)}`)),
      total > MAX ? nodo('li', { text: `${total - MAX} earlier events not shown` }) : null),
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
  const elegible = API && entregaElegibleQa(entrega);
  return nodo('article', { class: 'tarjeta', 'data-clave': entrega.clave },
    nodo('h3', {}, elegible ? nodo('input', { type: 'checkbox', class: 'elegir-qa', 'aria-label': `Select ${entrega.titulo} for a QA guide`, checked: qa.sel.has(entrega.clave) || null, al: { change: (ev) => { if (ev.target.checked) qa.sel.add(entrega.clave); else qa.sel.delete(entrega.clave); pintarBarraQa(); } } }) : null, elegible ? ' ' : null, entrega.titulo),
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
    barraQa() ?? '',
    panelQa() ?? '',
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
  document.querySelectorAll('.pestanas [data-pestana]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pestana === pestana)));
  if (pestana === 'entregas') pintarEntregas();
}

document.querySelectorAll('.pestanas [data-pestana]').forEach((b) => b.addEventListener('click', () => aplicarPestana(b.dataset.pestana)));
// The PR view's shortcuts act on rows that are hidden while the board is shown.
document.addEventListener('keydown', (ev) => {
  if (tablero.pestana !== 'entregas' || ev.target.matches('input, textarea, select') || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (['j', 'k', 'o', '/', '[', ']', 'ArrowDown', 'ArrowUp'].includes(ev.key)) ev.stopImmediatePropagation();
}, true);

aplicarPestana(FOTO.prs.some((p) => p.id === inicial) ? 'prs' : 'entregas');
// The first served visit only sets the mark, so the next one has something to compare with.
refrescarRastreador();
if (API && ENTREGAS && !ENTREGAS.visita) api('/api/visita', {}).then((r) => { ENTREGAS.visita = r.ts; }, () => {});
