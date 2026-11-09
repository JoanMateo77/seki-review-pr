// Template review: the Templates tab (selection, confirmation, job status, checklist and comments preview), the link
// that opens its confirmation and the stored result that Copy review appends. Evaluated before 08-script-5.js.
const ESTADO_ITEM = { cumple: ['Passes', 'verde'], falla: ['Fails', 'rojo'], no_verificable: ['Not verifiable', 'ambar'], no_aplica: ['Not applicable', ''] };

const trabajoPlantillas = (pr) => estado.trabajos.get(`${pr.id}:plantillas`);
const plantillasActivo = (pr) => ['en_cola', 'en_curso', 'bloqueado_presupuesto'].includes(trabajoPlantillas(pr)?.estado);
const fallasPlantillas = (r) => (r?.plantillas ?? []).reduce((n, t) => n + (t.items ?? []).filter((i) => i.estado === 'falla').length, 0);
const fechaPlantillas = (f) => (f ? ` · ${esc(new Date(f).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))}` : '');

// The data is reloaded when a job for the PR finishes or a refresh brings another head commit.
const plantillasAlDia = (pr, d) => !!d && (d.fin ?? null) === (trabajoPlantillas(pr)?.fin ?? null) && d.sha === pr.headSha;

async function cargarPlantillas(pr) {
  estado.plantillas ??= new Map();
  const previo = estado.plantillas.get(pr.id);
  if (previo?.cargando) return previo.promesa;
  const fin = trabajoPlantillas(pr)?.fin ?? null;
  const sha = pr.headSha;
  const promesa = (async () => {
    try {
      const d = await api(`/api/plantillas?repo=${encodeURIComponent(pr.repo)}&numero=${pr.numero}`);
      estado.plantillas.set(pr.id, { ...d, fin, sha });
    } catch (err) {
      estado.plantillas.set(pr.id, { error: err.message, fin, sha });
    }
    if (estado.seleccion === pr.id && estado.tab === 'plantillas') repintarDetalle();
    return estado.plantillas.get(pr.id);
  })();
  estado.plantillas.set(pr.id, { cargando: true, promesa, fin: previo?.fin ?? null, sha: previo?.sha ?? null });
  return promesa;
}

// Copy review: the stored result, loaded once when it is missing or stale. Never throws: without the API or the data
// the owner's review is copied alone.
async function plantillasParaCopiar(pr) {
  if (!API) return null;
  const d = estado.plantillas?.get(pr.id);
  const listo = plantillasAlDia(pr, d) && !d.cargando && !d.error ? d : await cargarPlantillas(pr);
  return listo?.resultado ?? null;
}

const motivoPlantilla = (m) => (m === 'siempre' ? 'Always applies' : m?.glob ? `<span class="mono">${esc(m.glob)}</span> matches <span class="mono">${esc(m.archivo)}</span>` : '');

function seleccionHtml(d) {
  const s = d.seleccion ?? {};
  const activas = s.activas ?? [];
  return `<ul class="lista-modal">${activas.map((a) => `<li><strong>${esc(a.titulo)}</strong> <span class="tenue">${motivoPlantilla(a.motivo)}</span></li>`).join('') || '<li class="tenue">No template applies to this PR.</li>'}</ul>
    ${s.omitidas?.length ? `<p class="tenue">Not applicable: ${s.omitidas.map((o) => esc(o.titulo)).join(', ')}.</p>` : ''}
    ${s.sinPlantilla?.length ? `<p class="tenue">Covered only by the base template: <span class="mono">${s.sinPlantilla.map(esc).join(', ')}</span></p>` : ''}
    ${d.invalidas?.length ? `<div class="seccion"><span class="estado ambar">${icono('alerta')} ${plural(d.invalidas.length, 'template file was', 'template files were')} skipped</span><ul class="lista-modal">${d.invalidas.map((x) => `<li><span class="mono">${esc(x.archivo)}</span>: ${esc(x.motivo)}</li>`).join('')}</ul></div>` : ''}`;
}

const estimacionPlantillas = (d) => (d.topeUsd ? `${usd(d.estimacion?.usd)} (${textoBase(d.estimacion ?? {})})` : 'no AI cost: only fixed rules apply');

function botonPlantillas(pr, d) {
  if (!API || pr.estadoPr !== 'OPEN') return '';
  const activo = plantillasActivo(pr);
  const costo = d?.estimacion && d.topeUsd ? ` · ~${usd(d.estimacion.usd)}` : '';
  return `<button type="button" class="btn" data-plantillas-abrir="${esc(pr.id)}" ${activo ? 'disabled' : ''} title="One read-only call per template with AI items, a verification pass over the failures and the fixed rules">${activo ? `${icono('actualizar', 'girando')} Template review in progress` : `${icono('escudo')} Review with templates${costo}`}</button>`;
}

async function abrirPlantillas(prId) {
  const pr = FOTO.prs.find((x) => x.id === prId);
  if (!pr || !API) return;
  // Shares the dialog counter with Ultra: closing any dialog drops a pending estimate.
  const pedido = (estado.pedidoUltra = (estado.pedidoUltra ?? 0) + 1);
  abrirModal(`<h3 id="modalIaTitulo">Template review of ${esc(pr.repo)} #${pr.numero}</h3><p class="trabajando">${icono('actualizar', 'girando')}<span>Selecting the templates</span></p><div class="modal-pie"><button type="button" class="btn" data-modal-cerrar>Cancel</button></div>`);
  let d;
  try { d = await api(`/api/plantillas?repo=${encodeURIComponent(pr.repo)}&numero=${pr.numero}`); } catch (err) {
    if (pedido !== estado.pedidoUltra) return;
    const carga = $('modalIa')?.querySelector('.trabajando');
    if (carga) carga.outerHTML = `<p class="error-texto">${esc(err.message)}</p>`;
    return;
  }
  if (pedido !== estado.pedidoUltra || !$('modalIa')) return;
  const b = estado.presupuesto;
  const actual = d.resultado && !d.resultado.desactualizada;
  const cabe = !b?.limite || b.gastado + b.reservado + d.topeUsd <= b.limite;
  abrirModal(`<h3 id="modalIaTitulo">Template review of ${esc(pr.repo)} #${pr.numero}</h3>
    <p>Each active template is checked item by item on a read-only copy of the branch: the AI must quote the code for every answer, the failures go through a verification pass and the fixed rules run on the whole diff.</p>
    ${seleccionHtml(d)}
    <p><strong>Estimated cost: ${estimacionPlantillas(d)}</strong></p>
    ${b?.limite && d.topeUsd ? `<p class="tenue">Spent today: ${usd(b.gastado)} of ${usd(b.limite)}.${cabe ? '' : ' Does not fit in the remaining budget: it stays blocked until run anyway or the budget allows it.'}</p>` : ''}
    ${actual ? '<p class="tenue">A result for this commit already exists. Running again repeats the review and spends the estimate.</p>' : ''}
    <div class="modal-pie">
      <button type="button" class="btn" data-modal-cerrar>Cancel</button>
      ${actual ? `<button type="button" class="btn" data-plantillas-ver="${esc(pr.id)}">View result</button>` : ''}
      <button type="button" class="btn primario" data-plantillas-confirmar="${esc(pr.id)}" data-repetir="${!!actual}">${actual ? 'Run again' : 'Start review'}</button>
    </div>
    <p class="error-texto" id="modalIaError" role="alert" hidden></p>`);
}

function verPlantillas(prId) {
  cerrarModal();
  estado.tab = 'plantillas';
  if (estado.seleccion !== prId) seleccionar(prId); else pintarDetalle();
}

async function confirmarPlantillas(prId, repetir) {
  const pr = FOTO.prs.find((x) => x.id === prId);
  if (!pr) return;
  try {
    const r = await api('/api/plantillas', { repo: pr.repo, numero: pr.numero, repetir, modo: modoActual(), confirmar: true });
    if (r.desdeCache) estado.plantillas?.delete(pr.id);
  } catch (err) {
    const caja = $('modalIaError');
    if (caja) { caja.textContent = err.message; caja.hidden = false; }
    return;
  }
  verPlantillas(pr.id);
  history.replaceState(null, '', `#${encodeURIComponent(pr.id)}/plantillas`);
  sondear();
}

// Evidence in this PR links to its files on GitHub; evidence in another repository is plain text.
function lugarItem(pr, i) {
  if (!i.archivo) return '';
  const lugar = `${esc(i.archivo)}${i.linea ? `:${Number(i.linea)}` : ''}`;
  return `<p class="mono muy-tenue">${i.repo ? `${esc(i.repo)} · ${lugar}` : `<a href="${esc(pr.url)}/files" target="_blank" rel="noopener">${lugar}</a>`}</p>`;
}

function itemPlantilla(pr, i) {
  const [txt, cls] = ESTADO_ITEM[i.estado] ?? [i.estado, ''];
  const origen = i.origen === 'determinista' ? 'Fixed rules' : i.estado === 'falla' ? (VEREDICTO_ULTRA[i.veredicto]?.[0] ?? 'Unverified') : '';
  return `<div class="hallazgo-ultra item-plantilla"><p><span class="estado ${cls}">${esc(txt)}</span> <span class="mono muy-tenue">${esc(i.id)}</span> ${esc(i.pregunta)}${origen ? ` <span class="tenue">· ${esc(origen)}</span>` : ''}</p>
    ${i.estado === 'falla' && i.titulo ? `<p><strong>${esc(i.titulo)}</strong></p>` : ''}
    ${lugarItem(pr, i)}
    ${i.cita ? `<p class="mono cita-plantilla">${esc(i.cita)}</p>` : ''}
    ${i.detalle ? `<p>${esc(i.detalle)}</p>` : ''}
    ${i.estado === 'no_verificable' && (i.pedido || i.motivo) ? `<p class="tenue">${esc(i.pedido ?? i.motivo)}</p>` : ''}
  </div>`;
}

function resultadoPlantillas(pr, r) {
  const vieja = r.desactualizada || (pr.headSha && r.headSha !== pr.headSha);
  const plantillas = (r.plantillas ?? []).map((t) => `<h4>${esc(t.titulo)} <span class="mono muy-tenue">${esc(t.id)} v${Number(t.version) || ''}</span></h4>
    ${t.ok === false ? `<div class="seccion"><span class="estado ambar">${icono('alerta')} The template review failed${t.motivo ? `: ${esc(t.motivo)}` : ''}</span></div>` : ''}
    ${(t.items ?? []).map((i) => itemPlantilla(pr, i)).join('')}`).join('');
  return `${vieja ? `<div class="seccion"><span class="estado ambar">${icono('alerta')} The PR received commits after this review</span></div>` : ''}
    <p class="origen">${icono('chispa')} <span><strong>Template review.</strong> Commit <span class="mono">${esc((r.headSha ?? '').slice(0, 7))}</span>${fechaPlantillas(r.fecha)}. Every answer quotes the code; it does not replace reviewing the diff.</span></p>
    ${r.otrosRepos === 'no_disponibles' ? '<p class="tenue">Other repositories were not available.</p>' : ''}
    ${r.verificacion === 'fallida' ? '<p class="tenue">The verification pass failed: the failures are not confirmed and none blocks.</p>' : ''}
    ${plantillas || '<p class="tenue">No template applied to this PR.</p>'}
    <h4>Comments</h4>
    ${r.markdown ? `<pre class="md-plantillas">${esc(r.markdown)}</pre>` : '<p class="tenue">No comments: nothing failed or needs the author.</p>'}
    ${r.recortados ? `<p class="tenue">${plural(r.recortados, 'comment was', 'comments were')} left out (at most 5 per template).</p>` : ''}
    ${vieja ? '' : '<p class="tenue">Copy review in the Review tab appends these comments.</p>'}`;
}

function tabPlantillas(pr) {
  if (!API) return '<p class="sin-dato">The template review is available when the dashboard is opened from Claude Code.</p>';
  const t = trabajoPlantillas(pr);
  let d = estado.plantillas?.get(pr.id);
  if (!d?.cargando && !plantillasAlDia(pr, d)) { cargarPlantillas(pr); d = estado.plantillas?.get(pr.id); }
  const aviso = !t ? '' : t.estado === 'en_curso' ? `<div class="seccion" aria-live="polite"><p class="trabajando">${icono('actualizar', 'girando')}<span>Template review in progress · ${transcurrido(t.inicio)}</span></p><div class="progreso" aria-hidden="true"></div></div>`
    : t.estado === 'en_cola' ? `<div class="seccion"><p class="trabajando">${icono('reloj')} Queued: starts when the current analysis finishes.</p></div>`
    : t.estado === 'bloqueado_presupuesto' ? `<div class="seccion"><p>${icono('alerta')} ${esc(t.mensaje ?? 'Blocked by the daily budget')}</p><button type="button" class="btn chico" data-forzar="${esc(t.id)}">Run anyway</button></div>`
    : t.estado === 'error' ? `<div class="seccion"><span class="estado rojo">${icono('bloqueo')} The template review did not complete</span><p class="tenue">${esc(t.mensaje ?? '')}</p></div>` : '';
  if (!d || d.cargando) return `${aviso}<p class="tenue">Loading</p>`;
  if (d.error) return `${aviso}<p class="error-texto">${esc(d.error)}</p>`;
  const boton = botonPlantillas(pr, d);
  return `${aviso}<h4>Templates for this PR</h4>${seleccionHtml(d)}
    ${boton ? `<p style="margin-top:12px">${boton}</p>` : ''}
    ${d.resultado ? resultadoPlantillas(pr, d.resultado) : '<p class="tenue">This PR has no template review yet.</p>'}`;
}

// The link #/pr/<repo>/<n>?plantillas=1 selects the PR and opens the confirmation; it never launches the review.
function abrirPlantillasDesdeEnlace() {
  const m = /^#\/pr\/([^/?]+)\/(\d+)\?plantillas=1$/.exec(location.hash);
  if (!m || !API) return;
  const id = `${decodeURIComponent(m[1])}#${m[2]}`;
  if (!FOTO.prs.some((x) => x.id === id)) return avisar('The PR is not in this dashboard.');
  seleccionar(id);
  abrirPlantillas(id);
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest?.('[data-plantillas-abrir], [data-plantillas-confirmar], [data-plantillas-ver]');
  if (!el) return;
  const d = el.dataset;
  if (d.plantillasAbrir) return abrirPlantillas(d.plantillasAbrir);
  if (d.plantillasConfirmar) return confirmarPlantillas(d.plantillasConfirmar, d.repetir === 'true');
  if (d.plantillasVer) return verPlantillas(d.plantillasVer);
});

window.addEventListener('hashchange', abrirPlantillasDesdeEnlace);
// After the first paint, which selects nothing for this kind of link.
setTimeout(abrirPlantillasDesdeEnlace, 0);
