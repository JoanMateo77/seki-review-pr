
// AI mode selector, daily budget line, Ultra review (confirmation, results) and jobs blocked by the budget.
// Evaluated before 08-script-5.js, which ends with the first paint: the constants below must exist by then.
const MODOS_IA = [['ahorro', 'Saving'], ['normal', 'Normal'], ['ultra', 'Ultra']];
const NOMBRE_MODO = Object.fromEntries(MODOS_IA);
const LENTES_ULTRA = { correccion: 'Correctness', seguridad: 'Security', lineamientos: 'Guidelines' };
const SEVERIDAD_ULTRA = [['alta', 'High', 'rojo'], ['media', 'Medium', 'ambar'], ['baja', 'Low', '']];
const VEREDICTO_ULTRA = { CONFIRMED: ['Confirmed', 'verde'], PLAUSIBLE: ['Plausible', 'ambar'] };
const RUTAS_IA = ['/api/analizar', '/api/enviar-revision', '/api/investigar', '/api/filtrar', '/api/propuesta/ajustar', '/api/propuesta/regenerar'];
const TIPO_TRABAJO = { explicar: 'Analysis', responder: 'Answers', cambiar: 'Change proposal', investigar: 'Investigation', revisar_ultra: 'Ultra review', revisar_plantillas: 'Template review' };

function modoActual() {
  let guardado = null;
  try { guardado = sessionStorage.getItem('seki-review:modo'); } catch { /* storage unavailable */ }
  return NOMBRE_MODO[guardado] ? guardado : (NOMBRE_MODO[estado.modoProyecto] ? estado.modoProyecto : 'normal');
}

// The mode travels with every AI request; the server validates it.
function conModo(ruta, cuerpo) {
  const ia = RUTAS_IA.includes(ruta);
  return ia && cuerpo && typeof cuerpo === 'object' && !Array.isArray(cuerpo) && cuerpo.modo === undefined ? { ...cuerpo, modo: modoActual() } : cuerpo;
}

function selectorModo() {
  if (!API) return '';
  return `<label class="selector-modo"><span class="tenue">AI mode</span><select id="selModo" aria-label="AI mode">${MODOS_IA.map(([k, n]) => `<option value="${k}" ${k === modoActual() ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`;
}

function textoGasto() {
  const p = estado.presupuesto;
  if (p?.limite) return `AI spend today: ${usd(p.gastado)} of ${usd(p.limite)}`;
  return estado.costoHoy?.trabajos ? `AI spend today: ${usd(estado.costoHoy.total)} · ${plural(estado.costoHoy.trabajos, 'job', 'jobs')}` : '';
}

function textoModos(r) {
  const filas = Object.entries(r?.modos ?? {}).filter(([, m]) => m.trabajos);
  if (!filas.length) return [];
  return ['By mode', ...filas.map(([k, m]) => `${NOMBRE_MODO[k] ?? k}: ${plural(m.trabajos, 'job', 'jobs')}${m.fallidos ? ` (${m.fallidos} failed)` : ''} · ${usd(m.costo)}${m.utiles || m.noUtiles ? ` · helpful ${m.utiles} of ${m.utiles + m.noUtiles}` : ''}`)];
}

const trabajoUltra = (pr) => estado.trabajos.get(`${pr.id}:ultra`);
const ultraActivo = (pr) => ['en_cola', 'en_curso', 'bloqueado_presupuesto'].includes(trabajoUltra(pr)?.estado);

function botonUltra(pr) {
  if (!API || pr.estadoPr !== 'OPEN' || modoActual() === 'ahorro') return '';
  return `<button class="btn" data-ultra-abrir="${esc(pr.id)}" ${ultraActivo(pr) ? 'disabled' : ''} title="Three read-only lenses, a verification pass and the project checks">${ultraActivo(pr) ? `${icono('actualizar', 'girando')} Ultra review in progress` : `${icono('escudo')} Ultra review`}</button>`;
}

// Jobs that wait for the budget or run outside the per-PR rows: the Ultra and template reviews and anything blocked.
const TIPOS_REVISION = ['revisar_ultra', 'revisar_plantillas'];
function trabajosIaHtml() {
  const lista = [...estado.trabajos.values()].filter((t) => t.estado === 'bloqueado_presupuesto' || (TIPOS_REVISION.includes(t.tipo) && ['en_cola', 'en_curso'].includes(t.estado)));
  if (!lista.length) return '';
  return `<div class="trabajos-ia" role="list" aria-label="Jobs waiting or running">${lista.map((t) => `<div class="trabajo-ia" role="listitem">
    <span class="mono">${esc(t.prId ?? t.id)}</span> <span>${esc(TIPO_TRABAJO[t.tipo] ?? t.tipo)}</span>
    ${t.estado === 'bloqueado_presupuesto' ? `<p class="muy-tenue">${esc(t.mensaje ?? 'Blocked by the daily budget')}</p><button type="button" class="btn chico" data-forzar="${esc(t.id)}">Run anyway</button>` : `<p class="muy-tenue">${t.estado === 'en_curso' ? 'In progress' : 'Queued'}</p>`}
  </div>`).join('')}</div>`;
}

async function forzarTrabajo(id) {
  try { await api('/api/trabajos/forzar', { id }); } catch (err) { avisar(err.message); }
  sondear();
}

async function cargarUltra(pr) {
  estado.ultra ??= new Map();
  const previo = estado.ultra.get(pr.id);
  if (previo?.cargando) return previo;
  const fin = trabajoUltra(pr)?.fin ?? null;
  estado.ultra.set(pr.id, { cargando: true, fin: previo?.fin ?? null });
  try {
    const d = await api(`/api/ultra?repo=${encodeURIComponent(pr.repo)}&numero=${pr.numero}`);
    estado.ultra.set(pr.id, { ...d, fin });
  } catch (err) {
    estado.ultra.set(pr.id, { error: err.message, fin });
  }
  if (estado.seleccion === pr.id && estado.tab === 'ultra') repintarDetalle();
  return estado.ultra.get(pr.id);
}

const textoBase = (e) => (e.base === 'historial' ? `from ${plural(e.muestras, 'earlier review', 'earlier reviews')}` : 'from the cost caps');

function cerrarModal() {
  // A pending estimate no longer applies once the dialog is closed.
  estado.pedidoUltra = (estado.pedidoUltra ?? 0) + 1;
  $('modalIa')?.remove();
  estado.modalReturnFocus?.focus?.();
}

function abrirModal(html) {
  // The element to return focus to is the one that opened the first dialog, not a button inside it.
  if (!$('modalIa')) estado.modalReturnFocus = document.activeElement;
  $('modalIa')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-fondo" id="modalIa"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalIaTitulo">${html}</div></div>`);
  $('modalIa').querySelector('button[data-ultra-confirmar], button')?.focus();
}

async function abrirUltra(prId) {
  const pr = FOTO.prs.find((x) => x.id === prId);
  if (!pr || !API) return;
  const pedido = (estado.pedidoUltra = (estado.pedidoUltra ?? 0) + 1);
  abrirModal(`<h3 id="modalIaTitulo">Ultra review</h3><p class="trabajando">${icono('actualizar', 'girando')}<span>Estimating the cost</span></p><div class="modal-pie"><button type="button" class="btn" data-modal-cerrar>Cancel</button></div>`);
  let d;
  try { d = await api(`/api/ultra?repo=${encodeURIComponent(pr.repo)}&numero=${pr.numero}`); } catch (err) {
    if (pedido !== estado.pedidoUltra) return;
    const carga = $('modalIa')?.querySelector('.trabajando');
    if (carga) carga.outerHTML = `<p class="error-texto">${esc(err.message)}</p>`;
    return;
  }
  if (pedido !== estado.pedidoUltra || !$('modalIa')) return;
  const b = estado.presupuesto;
  const actual = d.resultado && !d.resultado.desactualizada;
  const cabe = !b?.limite || b.gastado + b.reservado + d.topeUsd <= b.limite;
  abrirModal(`<h3 id="modalIaTitulo">Ultra review of ${esc(pr.repo)} #${pr.numero}</h3>
    <p>Three read-only lenses (correctness, security and guidelines), a verification pass over their findings and the project checks on a copy of the branch.</p>
    <p><strong>Estimated cost: ${usd(d.estimacion.usd)}</strong> <span class="tenue">(${textoBase(d.estimacion)})</span></p>
    ${b?.limite ? `<p class="tenue">Spent today: ${usd(b.gastado)} of ${usd(b.limite)}.${cabe ? '' : ' Does not fit in the remaining budget: it stays blocked until run anyway or the budget allows it.'}</p>` : ''}
    ${d.sugerida ? `<div class="seccion"><span class="estado violeta">${icono('chispa')} Ultra suggested</span><ul class="lista-modal">${d.motivos.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>` : ''}
    ${actual ? `<p class="tenue">A result for this commit already exists. Running again repeats the analysis and spends the estimate.</p>` : ''}
    <div class="modal-pie">
      <button type="button" class="btn" data-modal-cerrar>Cancel</button>
      ${actual ? `<button type="button" class="btn" data-ultra-ver="${esc(pr.id)}">View result</button>` : ''}
      <button type="button" class="btn primario" data-ultra-confirmar="${esc(pr.id)}" data-repetir="${actual}">${actual ? 'Run again' : 'Start review'}</button>
    </div>
    <p class="error-texto" id="modalIaError" role="alert" hidden></p>`);
}

async function confirmarUltra(prId, repetir) {
  const pr = FOTO.prs.find((x) => x.id === prId);
  if (!pr) return;
  try {
    const r = await api('/api/ultra', { repo: pr.repo, numero: pr.numero, repetir, modo: modoActual(), confirmar: true });
    if (r.desdeCache) estado.ultra?.delete(pr.id);
  } catch (err) {
    const caja = $('modalIaError');
    if (caja) { caja.textContent = err.message; caja.hidden = false; }
    return;
  }
  cerrarModal();
  estado.tab = 'ultra';
  history.replaceState(null, '', `#${encodeURIComponent(pr.id)}/ultra`);
  if (estado.seleccion !== pr.id) seleccionar(pr.id); else pintarDetalle();
  sondear();
}

function resultadoUltra(pr, r) {
  const sev = SEVERIDAD_ULTRA.map(([k, nombre, color]) => {
    const hs = (r.hallazgos ?? []).filter((h) => h.severidad === k);
    if (!hs.length) return '';
    return `<h4>${nombre} <span class="n">${hs.length}</span></h4>${hs.map((h) => {
      const [txt, cls] = VEREDICTO_ULTRA[h.veredicto] ?? [h.veredicto ?? 'Unverified', ''];
      return `<div class="hallazgo-ultra"><p><span class="estado ${cls}">${esc(txt)}</span> <strong>${esc(h.titulo)}</strong></p>
        <p class="mono muy-tenue">${h.repo ? `${esc(h.repo)} · ` : ''}<a href="${esc(pr.url)}/files" target="_blank" rel="noopener">${esc(h.archivo)}:${h.linea}</a></p>
        <p>${esc(h.detalle)}</p>${h.razon ? `<p class="tenue">Verification: ${esc(h.razon)}</p>` : ''}</div>`;
    }).join('')}`;
  }).join('');
  const lentes = (r.lentes ?? []).filter((l) => !l.ok);
  const c = r.comprobacion;
  const medida = (nombre, x) => (x ? `<li>${nombre}: ${x.omitido ? 'not measured (time limit)' : x.ok ? 'no new failures' : plural(x.nuevosFallos.length, 'new failure', 'new failures')}${x.sinBaseline ? ' · not compared with the base branch' : ''}</li>` : '');
  const checks = !c ? '' : c.error ? `<p class="tenue">${esc(c.error)}</p>`
    : `<ul class="lista-modal"><li>Fixed rules: ${plural(c.reglas?.hallazgos?.length ?? 0, 'finding', 'findings')}${c.reglas?.bloqueantes ? ` (${c.reglas.bloqueantes} blocking)` : ''}</li>${medida('Types', c.tipos)}${medida('Tests', c.tests)}</ul>
      ${c.sinBaseline ? '<p class="tenue">Not compared with the base branch.</p>' : ''}`;
  return `${r.desactualizada ? `<div class="seccion"><span class="estado ambar">${icono('alerta')} The PR received commits after this review</span></div>` : ''}
    <p class="origen">${icono('chispa')} <span><strong>Ultra review.</strong> Commit <span class="mono">${esc((r.headSha ?? '').slice(0, 7))}</span>${r.fecha ? ` · ${esc(new Date(r.fecha).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))}` : ''}. Findings verified against the code; they do not replace reviewing the diff.</span></p>
    ${lentes.length ? `<div class="seccion"><span class="estado ambar">${icono('alerta')} ${lentes.map((l) => `${esc(LENTES_ULTRA[l.nombre] ?? l.nombre)} lens ${l.omitida ? 'skipped' : 'failed'}${l.motivo ? `: ${esc(l.motivo)}` : ''}`).join(' · ')}</span></div>` : ''}
    ${r.otrosRepos === 'no_disponibles' ? '<p class="tenue">Other repositories were not available.</p>' : ''}
    ${sev || '<p class="tenue">No verified findings.</p>'}
    ${r.descartadas?.length ? `<p class="tenue">${plural(r.descartadas.length, 'finding was', 'findings were')} discarded: cited code that does not exist or rejected by the verification.</p>` : ''}
    <h4>Project checks</h4>${checks}`;
}

function tabUltra(pr) {
  if (!API) return '<p class="sin-dato">Ultra review is available when the dashboard is opened from Claude Code.</p>';
  const t = trabajoUltra(pr);
  let d = estado.ultra?.get(pr.id);
  if (!d || (d.fin ?? null) !== (t?.fin ?? null)) { cargarUltra(pr); d = estado.ultra?.get(pr.id); }
  const aviso = !t ? '' : t.estado === 'en_curso' ? `<div class="seccion" aria-live="polite"><p class="trabajando">${icono('actualizar', 'girando')}<span>Ultra review in progress · ${transcurrido(t.inicio)}</span></p><div class="progreso" aria-hidden="true"></div></div>`
    : t.estado === 'en_cola' ? `<div class="seccion"><p class="trabajando">${icono('reloj')} Queued: starts when the current analysis finishes.</p></div>`
    : t.estado === 'bloqueado_presupuesto' ? `<div class="seccion"><p>${icono('alerta')} ${esc(t.mensaje ?? 'Blocked by the daily budget')}</p><button type="button" class="btn chico" data-forzar="${esc(t.id)}">Run anyway</button></div>`
    : t.estado === 'error' ? `<div class="seccion"><span class="estado rojo">${icono('bloqueo')} The Ultra review did not complete</span><p class="tenue">${esc(t.mensaje ?? '')}</p></div>` : '';
  const r = d?.resultado;
  const cuerpo = !d || d.cargando ? `<p class="tenue">Loading</p>` : d.error ? `<p class="error-texto">${esc(d.error)}</p>` : r ? resultadoUltra(pr, r)
    : `<p class="tenue">This PR has no Ultra review yet.</p>${botonUltra(pr) ? `<p style="margin-top:12px">${botonUltra(pr)}</p>` : ''}`;
  return aviso + cuerpo;
}

// The link #/pr/<repo>/<n>?ultra=1 selects the PR and opens the confirmation; it never launches the review.
function abrirDesdeEnlace() {
  const m = /^#\/pr\/([^/?]+)\/(\d+)\?ultra=1$/.exec(location.hash);
  if (!m || !API) return;
  const id = `${decodeURIComponent(m[1])}#${m[2]}`;
  if (!FOTO.prs.some((x) => x.id === id)) return avisar('The PR is not in this dashboard.');
  seleccionar(id);
  abrirUltra(id);
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-ultra-abrir], [data-ultra-confirmar], [data-ultra-ver], [data-modal-cerrar], [data-forzar], #modalIa');
  if (!el) return;
  const d = el.dataset;
  if (d.ultraAbrir) return abrirUltra(d.ultraAbrir);
  if (d.ultraConfirmar) return confirmarUltra(d.ultraConfirmar, d.repetir === 'true');
  if (d.ultraVer) { cerrarModal(); estado.tab = 'ultra'; return seleccionar(d.ultraVer); }
  if (d.modalCerrar !== undefined || el.id === 'modalIa') { if (el.id === 'modalIa' && ev.target !== el) return; return cerrarModal(); }
  if (d.forzar) return forzarTrabajo(d.forzar);
});

document.addEventListener('change', (ev) => {
  if (ev.target.id !== 'selModo') return;
  try { sessionStorage.setItem('seki-review:modo', ev.target.value); } catch { /* storage unavailable */ }
  ev.target.blur();
  pintarBarra();
  pintarDetalle();
  pintarCola();
});

document.addEventListener('keydown', (ev) => {
  if (!$('modalIa')) return;
  if (ev.key === 'Escape') { ev.stopPropagation(); return cerrarModal(); }
  if (ev.key !== 'Tab') return;
  const f = [...$('modalIa').querySelectorAll('button:not([disabled])')];
  if (!f.length) return;
  const primero = f[0];
  const ultimo = f[f.length - 1];
  if (ev.shiftKey && document.activeElement === primero) { ev.preventDefault(); ultimo.focus(); }
  else if (!ev.shiftKey && document.activeElement === ultimo) { ev.preventDefault(); primero.focus(); }
}, true);

window.addEventListener('hashchange', abrirDesdeEnlace);
// After the first paint, which selects nothing for this kind of link.
setTimeout(abrirDesdeEnlace, 0);
