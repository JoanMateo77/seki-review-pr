// Checks tab: the fixed-rule findings of a PR with the AI verdict of each one, the dismissals kept by Seki and the
// confirmation dialogs for validating with AI and for dismissing. Evaluated before 08-script-5.js, which routes the clicks.
const VEREDICTO_CHECK = { real: ['Real', 'rojo'], falso_positivo: ['False positive', 'verde'], dudoso: ['Unclear', 'ambar'] };
const COLOR_SEVERIDAD = { bloqueante: 'rojo', alto: 'ambar', medio: '', aviso: '' };
// Same set the server triages: lower severities are never sent to the AI.
const SEVERIDADES_TRIABLES = ['bloqueante', 'alto', 'medio'];
const LOTE_MINIMO = 2;

const trabajoChecks = (pr) => estado.trabajos.get(`${pr.id}:checks`);
// Any job of the PR counts: the queue runs one analysis per PR at a time, so a second one would only wait behind it.
const checksActivo = (pr) => [...estado.trabajos].some(([id, t]) => (id === pr.id || id.startsWith(`${pr.id}:`)) && ['en_cola', 'en_curso', 'bloqueado_presupuesto'].includes(t.estado));
const veredictosCheck = (pr) => new Map((pr.triaje?.veredictos ?? []).map((v) => [v.huella, v]));
const hallazgoCheck = (pr, huella) => pr.verificaciones?.hallazgos.find((h) => h.huella === huella);
const lugarCheck = (h) => `${h.archivo}${h.linea ? `:${h.linea}` : ''}`;
const fechaCheck = (f) => (f ? new Date(f).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '');

// Only medium findings the AI called false positives can be dismissed together (the server enforces the same rule).
function candidatosLote(pr) {
  const v = veredictosCheck(pr);
  return (pr.verificaciones?.hallazgos ?? []).filter((h) => h.severidad === 'medio' && v.get(h.huella)?.veredicto === 'falso_positivo');
}

function celdaVeredicto(v, vieja) {
  if (!v) return '<span class="muy-tenue">—</span>';
  const [texto, clase] = VEREDICTO_CHECK[v.veredicto] ?? [v.veredicto, ''];
  return `<span class="estado ${clase}">${esc(texto)}</span>${vieja ? ' <span class="muy-tenue">from an earlier commit</span>' : ''}${v.razon ? `<br><span class="tenue">${esc(v.razon)}</span>` : ''}`;
}

// Row actions live in one cell so later actions are added next to Dismiss.
function accionesFila(pr, h) {
  if (!API) return '';
  return `<button type="button" class="btn chico" data-check-accion="descartar" data-check-pr="${esc(pr.id)}" data-check-huella="${esc(h.huella)}">Dismiss</button>`;
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
  const triables = abiertos.some((h) => SEVERIDADES_TRIABLES.includes(h.severidad));
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
    ? `<div class="tabla"><table><thead><tr><th>Severity</th><th>Finding</th><th>Where</th><th>Verdict</th>${API ? '<th></th>' : ''}</tr></thead><tbody>
      ${v.hallazgos.map((h) => filaCheck(pr, h, veredictos.get(h.huella), vieja)).join('')}
    </tbody></table></div>`
    : `<p class="tenue">${descartados.length ? 'No open findings: the rest were dismissed.' : 'The added lines pass all rules.'}</p>`;
  const cerrados = descartados.length
    ? `<details class="descartados-check"><summary>Dismissed (${descartados.length})</summary><div class="tabla"><table><thead><tr><th>Finding</th><th>Reason</th><th>Proposed by</th><th>Date</th>${API ? '<th></th>' : ''}</tr></thead><tbody>
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

function abrirDescarte(pr, huella) {
  const h = hallazgoCheck(pr, huella);
  if (!h) return;
  const razon = veredictosCheck(pr).get(huella)?.razon ?? '';
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
  const razon = veredictosCheck(pr).get(huella)?.razon?.trim();
  return enviarCheck('/api/checks/descartar', { repo: pr.repo, numero: pr.numero, huellas: [huella], ...(motivo === razon ? {} : { motivo }) });
}

function abrirLote(pr) {
  const lote = candidatosLote(pr);
  if (lote.length < LOTE_MINIMO) return;
  abrirModal(`<h3 id="modalIaTitulo">Dismiss ${lote.length} false positives</h3>
    <p>The AI judged these medium findings not to be a problem. Each one is dismissed with the AI reason.</p>
    <ul class="lista-modal">${lote.map((h) => `<li><strong>${esc(h.titulo)}</strong> <span class="mono muy-tenue">${esc(lugarCheck(h))}</span><br><span class="tenue">${esc(veredictosCheck(pr).get(h.huella)?.razon)}</span></li>`).join('')}</ul>
    <div class="modal-pie">
      <button type="button" class="btn" data-modal-cerrar>Cancel</button>
      <button type="button" class="btn primario" data-check-accion="descartar-lote-confirmar" data-check-pr="${esc(pr.id)}">Dismiss ${lote.length}</button>
    </div>
    <p class="error-texto" id="modalIaError" role="alert" hidden></p>`);
}

const confirmarLote = (pr) => enviarCheck('/api/checks/descartar', { repo: pr.repo, numero: pr.numero, huellas: candidatosLote(pr).map((h) => h.huella) });

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

// Entry point of the click delegation in 08-script-5.js: `datos` is the dataset of the button.
function accionCheck(accion, pr, datos = {}) {
  if (!API) return;
  if (accion === 'validar') return abrirValidacion(pr);
  if (accion === 'validar-confirmar') return confirmarValidacion(pr, datos.repetir === 'true');
  if (accion === 'descartar') return abrirDescarte(pr, datos.checkHuella);
  if (accion === 'descartar-confirmar') return confirmarDescarte(pr, datos.checkHuella);
  if (accion === 'descartar-lote') return abrirLote(pr);
  if (accion === 'descartar-lote-confirmar') return confirmarLote(pr);
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
  const id = `${decodeURIComponent(m[1])}#${m[2]}`;
  if (!FOTO.prs.some((x) => x.id === id)) return avisar('The PR is not in this dashboard.');
  estado.tab = 'verificaciones';
  seleccionar(id);
}
window.addEventListener('hashchange', abrirChecksDesdeEnlace);
// After the first paint, which selects nothing for this kind of link.
setTimeout(abrirChecksDesdeEnlace, 0);
