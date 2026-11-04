function barraPendiente(pr) {
  const bs = borradores(pr);
  if (!bs.length) return '';
  const preguntas = bs.filter((c) => c.tipo === 'pregunta').length;
  const cambios = bs.filter((c) => c.tipo === 'cambio').length;
  const partes = [preguntas && plural(preguntas, 'question', 'questions'), cambios && plural(cambios, 'change request', 'change requests')].filter(Boolean).join(' · ');
  return `<div class="barra-pendiente" role="region" aria-label="Pending review">
    <span><strong>Pending review (${bs.length})</strong> <span class="tenue">${partes}</span></span>
    <span class="der">
      <button type="button" class="btn chico primario" data-accion="enviarRevision" ${API ? '' : 'disabled title="Available when the dashboard is opened from Claude Code (tablero_servir)"'}>${icono('chispa')} Send review</button>
      <button type="button" class="btn chico" data-accion="descartarBorradores">${estado.confirmarDescarte ? `Confirm: discard ${plural(bs.length, 'draft', 'drafts')}` : 'Discard drafts'}</button>
    </span>
  </div>`;
}

function ordenarArchivos(pr, archivos) {
  const orden = (pr.explicacion?.orden_lectura ?? []).map((o) => o.archivo);
  const pos = (a) => { const i = orden.findIndex((o) => a.filename === o || a.filename.endsWith('/' + o) || o.endsWith(a.filename)); return i < 0 ? orden.length : i; };
  return archivos.map((a, i) => ({ ...a, i })).sort((a, b) => pos(a) - pos(b) || a.i - b.i);
}

let diffPendiente = null;
function tabArchivos(pr) {
  let archivos = DIFFS[pr.id];
  if (!archivos) {
    if (API) {
      if (diffPendiente !== pr.id) {
        diffPendiente = pr.id;
        api(`/api/diff?id=${encodeURIComponent(pr.id)}`).then((d) => { DIFFS[pr.id] = d; if (estado.seleccion === pr.id) pintarDetalle(); }, (e) => avisar(e.message)).finally(() => { diffPendiente = null; });
      }
      return '<p class="tenue">Loading changes from GitHub.</p>';
    }
    return `<p class="tenue">This dashboard doesn’t include the diff for this PR. View it on <a href="${esc(pr.url)}/files" target="_blank" rel="noopener">GitHub</a> or regenerate the dashboard.</p>`;
  }
  archivos = ordenarArchivos(pr, archivos);
  estado.lineasArchivo = archivos.map((a) => (a.patch !== undefined ? SekiAnclaje.lineasDePatch(a.patch) : []));
  estado.archivosTab = archivos.map((a) => a.filename);
  if (API && !estado.comentariosCargados.has(pr.id)) { estado.comentariosCargados.add(pr.id); sincronizarComentarios(pr); }
  const lista = deLineas(pr);
  const anclados = archivos.map((_, k) => new Map());
  const sueltos = archivos.map(() => []);
  const fuera = [];
  for (const c of lista) {
    const k = estado.archivosTab.indexOf(c.archivo);
    if (k < 0) { fuera.push(c); continue; }
    const a = SekiAnclaje.anclar(c, estado.lineasArchivo[k]);
    if (a.desactualizado) { sueltos[k].push(c); continue; }
    if (!anclados[k].has(a.claveFinal)) anclados[k].set(a.claveFinal, []);
    anclados[k].get(a.claveFinal).push(c);
  }
  const bloqueSuelto = (cs, titulo) => (cs.length ? `<div class="desact"><p class="muy-tenue">${titulo}</p><table>${enHilo(cs).map(([c, n]) => hiloHtml(c, n)).join('')}</table></div>` : '');
  const vistos = new Set(almacen.leer(claveVistos(pr), []));
  const hallazgos = pr.verificaciones?.hallazgos ?? [];
  const ajustar = almacen.leer('seki-review:ajustar', false);
  const totalA = archivos.reduce((n, a) => n + a.additions, 0);
  const totalD = archivos.reduce((n, a) => n + a.deletions, 0);
  const plegarDesde = totalA + totalD > 1200 ? 3 : 99;
  const ordenados = !!pr.explicacion?.orden_lectura?.length;
  return `<div class="${ajustar ? 'ajustar' : ''}">
    <div class="diff-barra">
      <span>${plural(archivos.length, 'file', 'files')} · <span class="mas">+${totalA}</span> <span class="menos">−${totalD}</span> · ${vistos.size} of ${archivos.length} viewed</span>
      ${ordenados ? '<span class="muy-tenue">In the explanation’s reading order</span>' : ''}
      <span class="der">
        <label><input type="checkbox" data-accion-diff="ajustar" ${ajustar ? 'checked' : ''}> Wrap long lines</label>
        <button class="btn chico" data-accion="plegarTodo">Collapse all</button>
        <button class="btn chico" data-accion="enfoque" title="Hides the queue and the sidebar; Esc to go back">${document.body.hasAttribute('data-enfoque') ? 'Show the queue' : 'Expand'}</button>
        <a class="btn chico" href="${esc(pr.url)}/files" target="_blank" rel="noopener">View on GitHub ${icono('externo')}</a>
      </span>
    </div>
    ${bloqueSuelto(fuera, 'Comments on files no longer in the PR')}
    <nav class="indice" aria-label="PR files">${archivos.map((a, k) => `<a href="#${idArchivo(k)}" data-saltar="${idArchivo(k)}"><span class="mono muy-tenue">${k + 1}</span><span class="ruta mono ${vistos.has(a.filename) ? 'visto' : ''}" title="${esc(a.filename)}"><bdi>${esc(a.filename)}</bdi></span><span class="mono"><span class="mas">+${a.additions}</span> <span class="menos">−${a.deletions}</span>${barrita(a.additions, a.deletions)}</span></a>`).join('')}</nav>
    ${archivos.map((a, k) => {
      const plegado = vistos.has(a.filename) || k >= plegarDesde;
      const propios = hallazgos.filter((h) => h.archivo === a.filename && h.linea);
      const cuerpo = a.patch !== undefined
        ? `<div class="codigo-diff"><table>${filasDiff(estado.lineasArchivo[k], propios, k, anclados[k])}</table></div>${a.recortado ? `<div class="aviso-diff">The rest of this file is not included in the dashboard. <a href="${esc(pr.url)}/files" target="_blank" rel="noopener">View it in full on GitHub</a>.</div>` : ''}`
        : `<div class="aviso-diff">${a.recortado ? 'The PR exceeds the line limit the dashboard includes.' : 'GitHub doesn’t show the diff for this file (binary or too large).'} <a href="${esc(pr.url)}/files" target="_blank" rel="noopener">View on GitHub</a>.</div>`;
      return `<section class="archivo" id="${idArchivo(k)}" data-k="${k}" ${plegado ? 'data-plegado' : ''}>
        <div class="archivo-cab">
          <button class="plegar" data-plegar="${idArchivo(k)}" aria-label="Collapse or expand">${icono('chevron')}</button>
          <span class="estado">${ESTADO_ARCHIVO[a.status] ?? esc(a.status)}</span>
          <span class="ruta mono" title="${esc(a.filename)}">${a.previous_filename ? `${esc(a.previous_filename)} → ` : ''}${esc(a.filename)}</span>
          ${propios.length ? `<span class="senal ambar" title="Findings in this file">${icono('alerta')}${propios.length}</span>` : ''}
          <span class="mono"><span class="mas">+${a.additions}</span> <span class="menos">−${a.deletions}</span></span>
          <label><input type="checkbox" data-visto="${esc(a.filename)}" ${vistos.has(a.filename) ? 'checked' : ''}> Viewed</label>
        </div>
        ${bloqueSuelto(sueltos[k], 'Comments on lines that changed')}
        ${cuerpo}
      </section>`;
    }).join('')}
    ${barraPendiente(pr)}
  </div>`;
}

const TABS = [
  ['resumen', 'Summary', () => null],
  ['descripcion', 'Description', (pr) => pr.commits?.length || null],
  ['archivos', 'Files', (pr) => pr.archivos ?? DIFFS[pr.id]?.length ?? null],
  ['verificaciones', 'Checks', (pr) => pr.verificaciones?.hallazgos.length || null],
  ['probar', 'How to test', (pr) => pr.explicacion?.como_probar?.length || null],
  ['revision', 'Review', () => null],
];
const CUERPOS = { resumen: tabResumen, descripcion: tabDescripcion, archivos: tabArchivos, verificaciones: tabVerificaciones, probar: tabProbar, revision: tabRevision };

function pintarDetalle() {
  leerCaja();
  const pr = FOTO.prs.find((p) => p.id === estado.seleccion);
  if (!pr) {
    $('detalle').innerHTML = `<div class="vacio"><p>Select a PR from the queue to see where it is, what changes and how to test it.</p></div>`;
    return;
  }
  const t = tono(pr);
  const [nombreGrupo] = definicionGrupos()[grupoDe(pr)] ?? GRUPOS[pr.accion] ?? [pr.accion];
  const etiqueta = pr.estadoPr === 'MERGED'
    ? `<span class="estado violeta">${icono('merge')} Merged in testing</span>`
    : `<span class="estado ${t}">${esc(nombreGrupo)}</span>`;
  $('detalle').innerHTML = `<article class="det ${estado.tab === 'archivos' ? 'ancho' : ''}">
    <button class="btn chico volver" data-accion="volver">${icono('flecha')} Queue</button>
    <div class="det-meta">${etiqueta}<span class="mono">${esc(pr.repo)} #${pr.numero}</span><span>${esc(pr.portal)}</span></div>
    <h2>${esc(pr.titulo)}</h2>
    <div class="det-meta">
      <span class="mono">${esc(pr.base)} ← ${esc(pr.rama)}</span>
      ${pr.adiciones !== undefined ? `<span class="mono"><span class="mas">+${pr.adiciones}</span> <span class="menos">−${pr.eliminaciones}</span> · ${plural(pr.archivos, 'file', 'files')}</span>` : ''}
      <span>${icono('reloj')} ${plural(pr.dias, 'day', 'days')} ago</span>
    </div>
    <div class="acciones">
      <a class="btn primario" href="${esc(pr.url)}" target="_blank" rel="noopener">Open in GitHub ${icono('externo')}</a>
      <button class="btn" data-copiar="/plannotator-review ${esc(pr.url)}">${icono('copiar')} Review line by line</button>
      ${API
        ? `<button class="btn" data-accion="analizar" ${trabajoActivo(pr) ? 'disabled' : ''}>${trabajoActivo(pr) ? `${icono('actualizar', 'girando')} Analyzing` : `${icono('chispa')} ${pr.explicacion ? 'Analyze again with AI' : 'Analyze with AI'}`}</button>`
        : `<button class="btn" data-copiar="/seki-review:review-prs explain ${esc(pr.repo)}#${pr.numero}">${icono('copiar')} ${pr.explicacion ? 'Regenerate explanation' : 'Explain'}</button>`}
    </div>
    ${pilaEstados(pr)}
    <div class="tabs" role="tablist">${TABS.map(([k, nombre, n]) => { const c = n(pr); return `<button class="tab" role="tab" data-tab="${k}" aria-selected="${estado.tab === k}">${nombre}${c ? `<span class="n">${c}</span>` : ''}</button>`; }).join('')}</div>
    <div role="tabpanel">${CUERPOS[estado.tab](pr)}</div>
  </article>`;
  if (estado.tab === 'archivos') marcarSeleccion();
  if (estado.tab === 'resumen' || estado.tab === 'archivos') resaltarCitas(pr);
  if (seleccionResumen && estado.tab !== seleccionResumen.tab) cerrarBarraSel();
  pintarDiagramas();
}

document.addEventListener('mouseup', (ev) => {
  if (ev.target.closest('#barraSel')) return;
  setTimeout(abrirBarraSel, 0);
});

// Mermaid loads from the CDN only when a diagram is in view; without network the diagram text remains.
let mermaidListo = null;
function pintarDiagramas() {
  const nodos = $('detalle').querySelectorAll('pre.mermaid');
  if (!nodos.length) return;
  mermaidListo ??= new Promise((ok, falla) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js';
    s.onload = () => {
      const oscuro = getComputedStyle(document.documentElement).colorScheme === 'dark';
      window.mermaid.initialize({ startOnLoad: false, theme: oscuro ? 'dark' : 'neutral', securityLevel: 'strict' });
      ok(window.mermaid);
    };
    s.onerror = falla;
    document.head.appendChild(s);
  });
  mermaidListo.then((m) => m.run({ nodes: nodos })).catch(() => {});
}

// Last 30 days per model, against answers marked as helpful: shows whether the model choice pays off.
function textoResumenCostos(r) {
  const filas = Object.entries(r?.modelos ?? {}).filter(([, m]) => m.trabajos);
  if (!filas.length) return '';
  return [`Last ${r.dias} days`, ...filas.map(([n, m]) => `${n}: ${plural(m.trabajos, 'job', 'jobs')}${m.fallidos ? ` (${m.fallidos} failed)` : ''} · ${usd(m.costo)}${m.utiles || m.noUtiles ? ` · helpful ${m.utiles} of ${m.utiles + m.noUtiles}` : ''}${m.costoPorUtil ? ` · ${usd(m.costoPorUtil)} per helpful answer` : ''}`),
    ...(r.reintentos ? [`Retries and repeated analyses: ${r.reintentos}`] : [])].join('\n');
}

function pintarBarra() {
  if (!API) return;
  $('filtrarIa').hidden = false;
  const r = estado.ultimoRefresco;
  const gasto = estado.costoHoy?.trabajos ? `AI spend today: ${usd(estado.costoHoy.total)} · ${plural(estado.costoHoy.trabajos, 'job', 'jobs')}` : '';
  const texto = estado.refrescando ? 'Querying GitHub and git' : r?.sinConexion ? 'Offline: retrying' : r && !r.ok ? 'The last refresh failed' : gasto;
  $('accionesBarra').innerHTML = `<span class="estado-texto" title="${esc(textoResumenCostos(estado.resumenCostos))}">${texto}</span>
    <button class="btn chico" data-accion="refrescar" ${estado.refrescando ? 'disabled' : ''} title="${esc(r && !r.ok ? r.mensaje : 'Queries GitHub and git again: what was merged, what is new and where each PR is')}">${icono('actualizar', estado.refrescando ? 'girando' : '')} ${estado.refrescando ? 'Refreshing' : 'Refresh status'}</button>`;
}

async function api(ruta, cuerpo) {
  const r = await fetch(ruta, {
    method: cuerpo === undefined ? 'GET' : 'POST',
    headers: { 'X-Seki-Token': API.token, 'Content-Type': 'application/json' },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  if (r.status === 404 && servidorDesfasado()) throw new Error('The dashboard server is from an older version and doesn’t have this feature: restart Claude Code.');
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  return r.json();
}

let sondeo = null;
async function sondear() {
  clearTimeout(sondeo);
  try {
    const previo = new Map([...estado.trabajos].map(([k, t]) => [k, t.estado]));
    const eraRefresco = estado.refrescando;
    const e = await api('/api/estado');
    estado.trabajos = new Map(e.trabajos.map((t) => [t.id, t]));
    estado.refrescando = e.refrescando;
    estado.ultimoRefresco = e.ultimoRefresco;
    if (e.costoHoy?.trabajos !== estado.costoHoy?.trabajos) api('/api/costos').then((r) => { estado.resumenCostos = r; pintarBarra(); }).catch(() => {});
    estado.costoHoy = e.costoHoy;
    const marcas = e.comentarios ?? {};
    for (const [id, marca] of Object.entries(marcas)) {
      const pr = FOTO.prs.find((x) => x.id === id);
      if (pr && estado.marcasComentarios[id] !== marca && estado.comentariosCargados.has(id)) sincronizarComentarios(pr);
    }
    estado.marcasComentarios = marcas;
    estado.avances = e.avances ?? {};
    estado.versionServidor = e.version ?? 'an older version';
    const termino = e.trabajos.some((t) => t.estado === 'terminado' && previo.get(t.id) !== 'terminado') || (eraRefresco && !e.refrescando);
    if (termino) FOTO = await api('/api/foto');
    // If the user is typing in the detail, do not repaint: they would lose focus and half-written text.
    pintarTodo({ detalle: !$('detalle').contains(document.activeElement) });
    const activo = e.refrescando || e.trabajos.some((t) => t.estado === 'en_cola' || t.estado === 'en_curso');
    if (activo) sondeo = setTimeout(sondear, 3000);
  } catch (err) {
    // If the session serving the dashboard closed, another open session takes it over on the same link: it retries on its own.
    estado.ultimoRefresco = { ok: false, sinConexion: true, mensaje: `No connection to the local server (${err.message}). Retrying every 5 seconds; if no other Claude Code session is open, open it with /seki-review:review-prs.` };
    pintarBarra();
    sondeo = setTimeout(sondear, 5000);
  }
}

async function accionApi(ruta, cuerpo) {
  try { await api(ruta, cuerpo); } catch (err) { avisar(err.message); }
  sondear();
}

function pintarTodo({ detalle = true } = {}) {
  pintarBarra();
  pintarLateral();
  pintarCola();
  if (detalle) pintarDetalle();
  sincronizarAnimaciones();
}

// Each poll repaints the detail and looping animations would restart: the bar and icon would jump every 3 s.
// Tied to the page clock origin, a new animation continues in the same phase as the one it replaces.
function sincronizarAnimaciones() {
  for (const a of document.getAnimations?.() ?? []) {
    if (a.effect?.getTiming().iterations === Infinity && a.startTime !== 0) a.startTime = 0;
  }
}

function seleccionar(id, { enfocar = false } = {}) {
  if (estado.seleccion !== id) estado.seleccionLineas = null;
  estado.seleccion = id;
  history.replaceState(null, '', `#${encodeURIComponent(id)}/${estado.tab}`);
  document.body.dataset.vista = 'detalle';
  document.querySelectorAll('.fila').forEach((f) => f.setAttribute('aria-current', String(f.dataset.id === id)));
  pintarDetalle();
  $('detalle').scrollTop = 0;
  const fila = document.querySelector(`.fila[data-id="${CSS.escape(id)}"]`);
  if (fila) { fila.scrollIntoView({ block: 'nearest' }); if (enfocar) fila.focus(); }
}

function guardarRevision(pr, cambios) {
  const nueva = { ...(revision(pr) ?? {}), ...cambios, fecha: new Date().toISOString(), headSha: pr.headSha };
  const ok = almacen.escribir(claveRevision(pr), nueva);
  const g = $('guardado');
  if (g) g.textContent = ok ? `Saved ${new Date(nueva.fecha).toLocaleString('en-US')}` : 'Could not save: the browser is blocking local storage.';
  pintarLateral();
  pintarCola();
}

function revisionesExportables() {
  return FOTO.prs.map((pr) => {
    const r = revision(pr);
    const pasos = almacen.leer(clavePasos(pr), []);
    const cs = comentarios(pr);
    if (!r && !pasos.length && !cs.length) return null;
    return { id: pr.id, repo: pr.repo, numero: pr.numero, titulo: pr.titulo, url: pr.url, headSha: pr.headSha, ...r, pasosProbados: pasos, comentarios: cs };
  }).filter(Boolean);
}

function exportar() {
  const datos = { proyecto: FOTO.proyecto, exportado: new Date().toISOString(), revisiones: revisionesExportables() };
  if (!datos.revisiones.length) return avisar('There are no decisions, checked steps or comments to export yet.');
  const blob = new Blob([JSON.stringify(datos, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `revision-prs-${datos.exportado.slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  avisar(`${plural(datos.revisiones.length, 'review exported', 'reviews exported')}.`);
}

function resumenTexto() {
  const notasDe = (r) => (r.comentarios ?? []).filter((c) => c.tipo === 'nota' && c.estado !== 'descartado');
  const rs = revisionesExportables().filter((r) => r.decision || notasDe(r).length);
  if (!rs.length) return 'No review decisions or notes recorded.';
  const nota = (c) => `  · ${c.archivo}:${rangoTexto(c)} · ${c.texto.replace(/\s+/g, ' ')}${c.sugerido !== undefined ? `\n    Suggested code:\n${c.sugerido.split('\n').map((l) => `      ${l}`).join('\n')}` : ''}`;
  return rs.map((r) => {
    const cab = `- ${r.repo}#${r.numero} ${r.titulo}${r.decision ? `: ${(DECISIONES[r.decision] ?? [r.decision])[0]}${r.nota ? `. ${r.nota.replace(/\s+/g, ' ')}` : ''}` : ''}\n  ${r.url}`;
    return [cab, ...notasDe(r).map(nota)].join('\n');
  }).join('\n');
}

function importar(archivo) {
  archivo.text().then((t) => {
    const datos = JSON.parse(t);
    let n = 0;
    for (const r of datos.revisiones ?? []) {
      const pr = FOTO.prs.find((p) => p.id === r.id);
      if (!pr) continue;
      const { pasosProbados, comentarios: cs, id, repo, numero, titulo, url, ...decision } = r;
      if (decision.decision) almacen.escribir(claveRevision(pr), decision);
      if (cs?.length) { escribirComentarios(pr, fusionarComentarios(comentarios(pr), cs)); sincronizarComentarios(pr); }
      if (pasosProbados?.length) almacen.escribir(clavePasos(pr, r.headSha), pasosProbados);
      n++;
    }
    pintarTodo();
    avisar(`${plural(n, 'review imported', 'reviews imported')}.`);
  }).catch(() => avisar('The file is not a review exported from this dashboard.'));
}

const prSel = () => FOTO.prs.find((p) => p.id === estado.seleccion);

function repreguntar(pr, id) {
  const c = comentarios(pr).find((x) => x.id === id);
  if (!c) return;
  // The AI receives the full thread from the server; only a short reminder is shown here.
  const r = c.respuesta.replace(/\s+/g, ' ');
  const resumen = r.length > 90 ? `${r.slice(0, 90)}…` : r;
  if (c.ambito === 'pr') {
    estado.respondeA = { id: c.id, ambito: 'pr', resumen };
    repintarDetalle();
    const caja = $('preguntaPr');
    if (!caja) return;
    if ($('preguntaPrSeccion')) $('preguntaPrSeccion').value = c.seccion ?? '';
    caja.scrollIntoView({ block: 'center' });
    return caja.focus();
  }
  editarComentario(pr, id);
  estado.caja = { ...cajaVacia('pregunta'), respondeA: c.id, resumenRespondeA: resumen };
  marcarSeleccion();
}

async function enviarRevision(pr, soloIds) {
  const pedidos = (soloIds ? comentarios(pr).filter((c) => soloIds.includes(c.id)) : borradores(pr)).filter((c) => c.tipo !== 'nota');
  const viejos = pedidos.filter((c) => deOtroCommit(pr, c));
  const ids = pedidos.filter((c) => !deOtroCommit(pr, c)).map((c) => c.id);
  if (viejos.length) avisar(`Not sent because they belong to an earlier commit: ${plural(viejos.length, 'comment', 'comments')}. Editing them anchors them to the current commit.`);
  if (!ids.length) return;
  try {
    await sincronizarComentarios(pr);
    await api('/api/enviar-revision', { id: pr.id, ids });
    escribirComentarios(pr, comentarios(pr).map((c) => (ids.includes(c.id) ? { ...c, estado: 'en_cola', actualizado: new Date().toISOString() } : c)));
    repintarDetalle();
    pintarCola();
  } catch (err) { avisar(err.message); }
  sondear();
}

function aplicarCola(oculta) {
  document.body.toggleAttribute('data-sin-cola', oculta);
  document.querySelector('[data-accion="cola"]').setAttribute('aria-pressed', String(!oculta));
}

function alternarCola() {
  const oculta = !document.body.hasAttribute('data-sin-cola');
  almacen.escribir('seki-review:sin-cola', oculta);
  aplicarCola(oculta);
}

function aplicarLateral(oculto) {
  document.body.toggleAttribute('data-sin-lateral', oculto);
  document.querySelector('[data-accion="lateral"]').setAttribute('aria-pressed', String(!oculto));
}

function alternarLateral() {
  const oculto = !document.body.hasAttribute('data-sin-lateral');
  almacen.escribir('seki-review:sin-lateral', oculto);
  aplicarLateral(oculto);
}

function avisar(texto) {
  const destino = $('guardado') ?? $('foto');
  const previo = destino.textContent;
  destino.textContent = texto;
  setTimeout(() => { if (destino.textContent === texto) destino.textContent = previo; }, 3500);
}

