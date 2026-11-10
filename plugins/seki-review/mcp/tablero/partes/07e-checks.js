// Checks tab: the fixed-rule findings of a PR with the AI verdict of each one, the dismissals kept by Seki and the
// confirmation dialogs for validating with AI and for dismissing. Evaluated before 08-script-5.js, which routes the clicks.
const VEREDICTO_CHECK = { real: ['Real', 'rojo'], falso_positivo: ['False positive', 'verde'], dudoso: ['Unclear', 'ambar'] };
const COLOR_SEVERIDAD = { bloqueante: 'rojo', alto: 'ambar', medio: '', aviso: '' };
// Same set the server triages: lower severities and commit-level rules are never sent to the AI.
const SEVERIDADES_TRIABLES = ['bloqueante', 'alto', 'medio'];
const REGLAS_NO_TRIABLES = ['atribucion-ia'];
const triableCheck = (h) => SEVERIDADES_TRIABLES.includes(h.severidad) && !REGLAS_NO_TRIABLES.includes(h.regla);
const LOTE_MINIMO = 2;

const trabajoChecks = (pr) => estado.trabajos.get(`${pr.id}:checks`);
// Any job of the PR counts: the queue runs one analysis per PR at a time, so a second one would only wait behind it.
const checksActivo = (pr) => [...estado.trabajos].some(([id, t]) => (id === pr.id || id.startsWith(`${pr.id}:`)) && ['en_cola', 'en_curso', 'bloqueado_presupuesto'].includes(t.estado));
const veredictosCheck = (pr) => new Map((pr.triaje?.veredictos ?? []).map((v) => [v.huella, v]));
const hallazgoCheck = (pr, huella) => pr.verificaciones?.hallazgos.find((h) => h.huella === huella);
const lugarCheck = (h) => `${h.archivo}${h.linea ? `:${h.linea}` : ''}`;
const fechaCheck = (f) => (f ? new Date(f).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '');

// Only medium findings the AI called false positives on the current commit can be dismissed together (the server
// enforces the same rule).
function candidatosLote(pr) {
  if (pr.triaje?.desactualizado) return [];
  const v = veredictosCheck(pr);
  return (pr.verificaciones?.hallazgos ?? []).filter((h) => h.severidad === 'medio' && v.get(h.huella)?.veredicto === 'falso_positivo');
}

function celdaVeredicto(v, vieja) {
  if (!v) return '<span class="muy-tenue">—</span>';
  const [texto, clase] = VEREDICTO_CHECK[v.veredicto] ?? [v.veredicto, ''];
  return `<span class="estado ${clase}">${esc(texto)}</span>${vieja ? ' <span class="muy-tenue">from an earlier commit</span>' : ''}${v.razon ? `<br><span class="tenue">${esc(v.razon)}</span>` : ''}`;
}

// The latest fix request of a finding: a retry after an error creates a newer comment.
const peticionCheck = (pr, huella) => comentarios(pr).filter((c) => c.origenCheck?.huella === huella)
  .sort((a, b) => (a.creado ?? '').localeCompare(b.creado ?? '')).at(-1);

// Same rule as the server: a request can be made again after it failed, its proposal was discarded, or its fix was
// approved on an earlier commit.
const REINTENTABLES_CHECK = ['error', 'descartado'];
const aprobadoAntes = (pr, c) => c.estado === 'aprobado' && c.headSha !== pr.headSha;
function celdaArreglo(pr, h) {
  const c = peticionCheck(pr, h.huella);
  if (c && !REINTENTABLES_CHECK.includes(c.estado) && !aprobadoAntes(pr, c)) {
    if (c.estado === 'propuesta') return '<a href="#" data-tab-ir="archivos" title="The proposal is in the diff, on the line of the finding">Proposal ready</a>';
    const texto = c.estado === 'aprobado' ? 'Fix approved' : 'Fix requested';
    return `<span class="muy-tenue">${texto}</span>`;
  }
  const falla = !c ? '' : c.estado === 'descartado' ? '<span class="muy-tenue">Fix discarded</span> '
    : c.estado === 'aprobado' ? '<span class="muy-tenue">Fix approved on an earlier commit</span> '
    : `<span class="estado rojo">Fix failed: ${esc(c.motivo ?? 'unknown error')}</span> `;
  const arreglar = pr.estadoPr === 'OPEN' && h.linea ? `<button type="button" class="btn chico" data-check-accion="arreglar" data-check-pr="${esc(pr.id)}" data-check-huella="${esc(h.huella)}" title="Sends the finding to a change proposal; nothing is pushed until it is approved">Fix</button> ` : '';
  return falla + arreglar;
}

// Row actions live in one cell so later actions are added next to Dismiss.
function accionesFila(pr, h) {
  if (!API) return '';
  return `${celdaArreglo(pr, h)}<button type="button" class="btn chico" data-check-accion="descartar" data-check-pr="${esc(pr.id)}" data-check-huella="${esc(h.huella)}">Dismiss</button>`;
}

function filaCheck(pr, h, v, vieja) {
  return `<tr>
    <td><span class="estado ${COLOR_SEVERIDAD[h.severidad]}">${esc(nivel(h.severidad))}</span></td>
    <td><strong>${esc(h.titulo)}</strong><br><span class="tenue">${esc(h.mensaje)}</span><br><span class="muy-tenue">${esc(h.origen)}</span></td>
    <td><a class="mono" href="${esc(pr.url)}/files" target="_blank" rel="noopener">${esc(lugarCheck(h))}</a>${h.texto ? `<code class="codigo">${esc(h.texto)}</code>` : ''}</td>
    <td>${celdaVeredicto(v, vieja)}</td>
    ${API ? `<td class="acciones-check">${accionesFila(pr, h)}</td>` : ''}
  </tr>`;
}

function filaDescartada(pr, h) {
  const d = h.descarte ?? {};
  return `<tr>
    <td><strong>${esc(h.titulo)}</strong><br><a class="mono" href="${esc(pr.url)}/files" target="_blank" rel="noopener">${esc(lugarCheck(h))}</a></td>
    <td>${esc(d.motivo)}</td>
    <td>${d.propuestoPor === 'ia' ? 'AI' : 'Person'}</td>
    <td class="tenue">${esc(fechaCheck(d.fecha))}</td>
    ${API ? `<td class="acciones-check"><button type="button" class="btn chico" data-check-accion="reabrir" data-check-pr="${esc(pr.id)}" data-check-huella="${esc(h.huella)}">Reopen</button></td>` : ''}
  </tr>`;
}

function avisoTriaje(t) {
  if (!t) return '';
  if (t.estado === 'en_curso') return `<div class="seccion" aria-live="polite"><p class="trabajando">${icono('actualizar', 'girando')}<span>Validation in progress · ${transcurrido(t.inicio)}</span></p><div class="progreso" aria-hidden="true"></div></div>`;
  if (t.estado === 'en_cola') return `<div class="seccion"><p class="trabajando">${icono('reloj')} Queued: starts when the current analysis finishes.</p></div>`;
  if (t.estado === 'bloqueado_presupuesto') return `<div class="seccion"><p>${icono('alerta')} ${esc(t.mensaje ?? 'Blocked by the daily budget')}</p><button type="button" class="btn chico" data-forzar="${esc(t.id)}">Run anyway</button></div>`;
  if (t.estado === 'error') return `<div class="seccion"><span class="estado rojo">${icono('bloqueo')} The validation did not complete</span><p class="tenue">${esc(t.mensaje ?? '')}</p></div>`;
  return '';
}

function cabeceraCheck(pr, abiertos) {
  if (!API) return '';
  const activo = checksActivo(pr);
  const actual = pr.triaje && !pr.triaje.desactualizado;
  const triables = abiertos.some(triableCheck);
  const lote = candidatosLote(pr);
  const validar = pr.estadoPr === 'OPEN' && triables
    ? `<button type="button" class="btn" data-check-accion="validar" data-check-pr="${esc(pr.id)}" ${activo ? 'disabled' : ''} title="One read-only call that gives each blocking, high or medium finding a verdict and a reason">${activo ? `${icono('actualizar', 'girando')} Validation in progress` : `${icono('chispa')} ${actual ? 'Run again' : 'Validate with AI'}`}</button>` : '';
  const masivo = lote.length >= LOTE_MINIMO ? `<button type="button" class="btn" data-check-accion="descartar-lote" data-check-pr="${esc(pr.id)}">Dismiss all false positives (${lote.length})</button>` : '';
  return validar || masivo ? `<div class="acciones acciones-check-cab">${validar}${masivo}</div>` : '';
}

function tabVerificaciones(pr) {
  const v = pr.verificaciones;
  if (!v) return '<p class="sin-dato">No checks for this PR.</p>';
  const descartados = v.descartados ?? [];
  const veredictos = veredictosCheck(pr);
  const vieja = !!pr.triaje?.desactualizado;
  const abiertos = v.hallazgos.length
    ? `<div class="tabla"><table><thead><tr><th>Severity</th><th>Finding</th><th>Where</th><th>Verdict</th>${API ? '<th><span class="sr">Actions</span></th>' : ''}</tr></thead><tbody>
      ${v.hallazgos.map((h) => filaCheck(pr, h, veredictos.get(h.huella), vieja)).join('')}
    </tbody></table></div>`
    : `<p class="tenue">${descartados.length ? 'No open findings: the rest were dismissed.' : 'The added lines pass all rules.'}</p>`;
  const cerrados = descartados.length
    ? `<details class="descartados-check"><summary>Dismissed (${descartados.length})</summary><div class="tabla"><table><thead><tr><th>Finding</th><th>Reason</th><th>Proposed by</th><th>Date</th>${API ? '<th><span class="sr">Actions</span></th>' : ''}</tr></thead><tbody>
      ${descartados.map((h) => filaDescartada(pr, h)).join('')}
    </tbody></table></div></details>` : '';
  return `${avisoTriaje(API ? trabajoChecks(pr) : null)}${cabeceraCheck(pr, v.hallazgos)}${abiertos}${cerrados}
  <p class="nota-pie">Fixed rules over the added lines, no AI: they flag patterns, they don’t confirm there is a problem. Validate them with AI or dismiss a false positive with a reason; the dismissal is stored by Seki, not in the PR.</p>`;
}

const errorDeCheck = (mensaje) => {
  const caja = $('modalIaError');
  if (!caja) return avisar(mensaje);
  caja.textContent = mensaje;
  caja.hidden = false;
};

// Dismissals and reopenings change the counts of the queue and the sidebar too: the snapshot is reloaded as after a job.
async function enviarCheck(ruta, cuerpo) {
  try { await api(ruta, cuerpo); } catch (err) { return errorDeCheck(err.message); }
  cerrarModal();
  try { FOTO = await api('/api/foto'); } catch (err) { return avisar(err.message); }
  pintarTodo();
}

// The AI reason is offered as the motivo only when it argues for the dismissal: a false positive of the current commit.
// The server applies the same rule when no motivo is sent.
function razonPropuesta(pr, huella) {
  const v = veredictosCheck(pr).get(huella);
  return v?.veredicto === 'falso_positivo' && !pr.triaje?.desactualizado ? v.razon ?? '' : '';
}

function abrirDescarte(pr, huella) {
  const h = hallazgoCheck(pr, huella);
  if (!h) return;
  const razon = razonPropuesta(pr, huella);
  abrirModal(`<h3 id="modalIaTitulo">Dismiss a finding</h3>
    <p><strong>${esc(h.titulo)}</strong> <span class="mono muy-tenue">${esc(lugarCheck(h))}</span></p>
    ${h.severidad === 'bloqueante' ? '<p><span class="estado rojo">Blocking</span> This finding blocks the PR. Dismiss it only if the code shows it is not a problem.</p>' : ''}
    <label for="motivoCheck">Reason</label>
    <textarea id="motivoCheck" maxlength="500" ${razon ? '' : 'placeholder="Why this is not a problem"'}>${esc(razon)}</textarea>
    <p class="tenue">The dismissal is stored by Seki, not in the PR. It can be reopened from the Dismissed section.</p>
    <div class="modal-pie">
      <button type="button" class="btn" data-modal-cerrar>Cancel</button>
      <button type="button" class="btn primario" data-check-accion="descartar-confirmar" data-check-pr="${esc(pr.id)}" data-check-huella="${esc(huella)}" ${razon.trim() ? '' : 'disabled'}>Dismiss</button>
    </div>
    <p class="error-texto" id="modalIaError" role="alert" hidden></p>`);
}

function confirmarDescarte(pr, huella) {
  const motivo = $('motivoCheck')?.value.trim();
  if (!motivo) return;
  // The AI reason kept as is is sent as no reason, so the server records the AI as its proposer.
  const razon = razonPropuesta(pr, huella).trim();
  return enviarCheck('/api/checks/descartar', { repo: pr.repo, numero: pr.numero, huellas: [huella], ...(razon && motivo === razon ? {} : { motivo }) });
}

function abrirLote(pr) {
  const lote = candidatosLote(pr);
  if (lote.length < LOTE_MINIMO) return;
  abrirModal(`<h3 id="modalIaTitulo">Dismiss ${lote.length} false positives</h3>
    <p>The AI judged these medium findings not to be a problem. Each one is dismissed with the AI reason.</p>
    <ul class="lista-modal">${lote.map((h) => `<li><strong>${esc(h.titulo)}</strong> <span class="mono muy-tenue">${esc(lugarCheck(h))}</span><br><span class="tenue">${esc(veredictosCheck(pr).get(h.huella)?.razon)}</span></li>`).join('')}</ul>
    <div class="modal-pie">
      <button type="button" class="btn" data-modal-cerrar>Cancel</button>
      <button type="button" class="btn primario" data-check-accion="descartar-lote-confirmar" data-check-pr="${esc(pr.id)}" data-check-huellas="${esc(lote.map((h) => h.huella).join(','))}">Dismiss ${lote.length}</button>
    </div>
    <p class="error-texto" id="modalIaError" role="alert" hidden></p>`);
}

// The list the person saw when the dialog opened: a snapshot reload in between must not change what is dismissed.
const confirmarLote = (pr, huellas) => huellas ? enviarCheck('/api/checks/descartar', { repo: pr.repo, numero: pr.numero, huellas: huellas.split(',') }) : undefined;

async function abrirValidacion(pr) {
  // Shares the dialog counter with Ultra: closing any dialog drops a pending estimate.
  const pedido = (estado.pedidoUltra = (estado.pedidoUltra ?? 0) + 1);
  const titulo = `<h3 id="modalIaTitulo">Validate the checks of ${esc(pr.repo)} #${pr.numero}</h3>`;
  abrirModal(`${titulo}<p class="trabajando">${icono('actualizar', 'girando')}<span>Estimating the cost</span></p><div class="modal-pie"><button type="button" class="btn" data-modal-cerrar>Cancel</button></div>`);
  let d;
  try { d = await api(`/api/checks?repo=${encodeURIComponent(pr.repo)}&numero=${pr.numero}`); } catch (err) {
    if (pedido !== estado.pedidoUltra) return;
    const carga = $('modalIa')?.querySelector('.trabajando');
    if (carga) carga.outerHTML = `<p class="error-texto">${esc(err.message)}</p>`;
    return;
  }
  if (pedido !== estado.pedidoUltra || !$('modalIa')) return;
  const b = estado.presupuesto;
  const actual = d.triaje && !d.triaje.desactualizado;
  const cabe = !b?.limite || b.gastado + b.reservado + d.topeUsd <= b.limite;
  abrirModal(`${titulo}
    <p>${plural(d.triables, 'blocking, high or medium finding is', 'blocking, high or medium findings are')} checked against the code on a read-only copy of the branch (at most 40, the most severe first). The AI gives each one a verdict and a reason; it does not dismiss anything.</p>
    <p><strong>Estimated cost: ${usd(d.estimacion.usd)}</strong> <span class="tenue">(${textoBase(d.estimacion)})</span></p>
    ${b?.limite ? `<p class="tenue">Spent today: ${usd(b.gastado)} of ${usd(b.limite)}.${cabe ? '' : ' Does not fit in the remaining budget: it stays blocked until run anyway or the budget allows it.'}</p>` : ''}
    ${actual ? '<p class="tenue">A validation of this commit already exists. Running again repeats it and spends the estimate.</p>' : ''}
    <div class="modal-pie">
      <button type="button" class="btn" data-modal-cerrar>Cancel</button>
      <button type="button" class="btn primario" data-check-accion="validar-confirmar" data-check-pr="${esc(pr.id)}" data-repetir="${!!actual}">${actual ? 'Run again' : 'Validate'}</button>
    </div>
    <p class="error-texto" id="modalIaError" role="alert" hidden></p>`);
}

async function confirmarValidacion(pr, repetir) {
  try {
    const r = await api('/api/checks/triar', { repo: pr.repo, numero: pr.numero, confirmar: true, repetir, modo: modoActual() });
    // A stored result answers at once: there is no job to wait for.
    if (r.desdeCache) FOTO = await api('/api/foto');
  } catch (err) { return errorDeCheck(err.message); }
  cerrarModal();
  estado.tab = 'verificaciones';
  history.replaceState(null, '', `#${encodeURIComponent(pr.id)}/verificaciones`);
  pintarTodo();
  sondear();
}

// The fix starts an AI job: the dialog shows what it does and its cost cap before anything is sent.
async function abrirArreglo(pr, huella) {
  const h = hallazgoCheck(pr, huella);
  if (!h) return;
  const pedido = (estado.pedidoUltra = (estado.pedidoUltra ?? 0) + 1);
  const titulo = '<h3 id="modalIaTitulo">Fix this finding with AI</h3>';
  const cuerpo = `<p><strong>${esc(h.titulo)}</strong> <span class="mono muy-tenue">${esc(lugarCheck(h))}</span></p>`;
  let d;
  try { d = await api(`/api/checks?repo=${encodeURIComponent(pr.repo)}&numero=${pr.numero}&modo=${encodeURIComponent(modoActual())}`); } catch (err) { return avisar(err.message); }
  if (pedido !== estado.pedidoUltra) return;
  abrirModal(`${titulo}${cuerpo}
    <p>An AI edits a copy of the branch and leaves a proposal. Nothing is pushed until the proposal is approved.</p>
    <p><strong>Up to ${usd(d.topeArreglo)}</strong></p>
    <div class="modal-pie">
      <button type="button" class="btn" data-modal-cerrar>Cancel</button>
      <button type="button" class="btn primario" data-check-accion="arreglar-confirmar" data-check-pr="${esc(pr.id)}" data-check-huella="${esc(huella)}">Request fix</button>
    </div>
    <p class="error-texto" id="modalIaError" role="alert" hidden></p>`);
}

async function pedirArreglo(pr, huella) {
  const boton = $('modalIa')?.querySelector('[data-check-accion="arreglar-confirmar"]');
  if (boton) boton.disabled = true;
  let comentario;
  try { ({ comentario } = await api('/api/checks/arreglar', { repo: pr.repo, numero: pr.numero, huella, modo: modoActual(), confirmar: true })); } catch (err) {
    if (boton) boton.disabled = false;
    return errorDeCheck(err.message);
  }
  cerrarModal();
  // The server drops the failed or discarded request of the same finding (an approved one stays): the local copy does too.
  const resto = comentarios(pr).filter((c) => !(c.origenCheck?.huella === huella && REINTENTABLES_CHECK.includes(c.estado)));
  escribirComentarios(pr, fusionarComentarios(resto, [comentario]));
  pintarDetalle();
  sondear();
}

// Entry point of the click delegation in 08-script-5.js: `datos` is the dataset of the button.
function accionCheck(accion, pr, datos = {}) {
  if (!API) return;
  if (accion === 'validar') return abrirValidacion(pr);
  if (accion === 'validar-confirmar') return confirmarValidacion(pr, datos.repetir === 'true');
  if (accion === 'descartar') return abrirDescarte(pr, datos.checkHuella);
  if (accion === 'descartar-confirmar') return confirmarDescarte(pr, datos.checkHuella);
  if (accion === 'descartar-lote') return abrirLote(pr);
  if (accion === 'descartar-lote-confirmar') return confirmarLote(pr, datos.checkHuellas);
  if (accion === 'arreglar') return abrirArreglo(pr, datos.checkHuella);
  if (accion === 'arreglar-confirmar') return pedirArreglo(pr, datos.checkHuella);
  if (accion === 'reabrir') return enviarCheck('/api/checks/reabrir', { repo: pr.repo, numero: pr.numero, huella: datos.checkHuella });
}

// Dismiss stays disabled while the reason is empty or only spaces.
document.addEventListener('input', (ev) => {
  if (ev.target.id !== 'motivoCheck') return;
  const boton = ev.target.closest('.modal')?.querySelector('[data-check-accion="descartar-confirmar"]');
  if (boton) boton.disabled = !ev.target.value.trim();
});

// The link #/pr/<repo>/<n>?checks=1 selects the PR and opens its Checks tab; it never launches anything.
function abrirChecksDesdeEnlace() {
  const m = /^#\/pr\/([^/?]+)\/(\d+)\?checks=1$/.exec(location.hash);
  if (!m) return;
  let id;
  // A hand-edited link may hold a malformed escape: it is treated as a PR that is not here.
  try { id = `${decodeURIComponent(m[1])}#${m[2]}`; } catch { id = null; }
  if (!id || !FOTO.prs.some((x) => x.id === id)) return avisar('The PR is not in this dashboard.');
  estado.tab = 'verificaciones';
  seleccionar(id);
}
window.addEventListener('hashchange', abrirChecksDesdeEnlace);
// After the first paint, which selects nothing for this kind of link.
setTimeout(abrirChecksDesdeEnlace, 0);
