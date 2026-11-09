async function api(ruta, cuerpo, cabeceras = {}) {
  const r = await fetch(ruta, {
    method: cuerpo === undefined ? 'GET' : 'POST',
    headers: { 'X-Seki-Token': API.token, 'Content-Type': 'application/json', ...cabeceras },
    body: cuerpo === undefined ? undefined : JSON.stringify(conModo(ruta, cuerpo)),
  });
  if (r.status === 404 && servidorDesfasado()) throw new Error('The dashboard server is from an older version and doesn’t have this feature: restart Claude Code.');
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw Object.assign(new Error(e.error ?? `HTTP ${r.status}`), { estado: r.status, forzar: e.forzar === true });
  }
  return r.json();
}

// One poll at a time and a single timer: a call made during a poll runs once more right after it.
let sondeo = null;
let sondeando = false;
let otraVez = false;
async function sondear() {
  if (sondeando) { otraVez = true; return; }
  sondeando = true;
  clearTimeout(sondeo);
  let espera;
  try {
    const previo = new Map([...estado.trabajos].map(([k, t]) => [k, t.estado]));
    const eraRefresco = estado.refrescando;
    const fechaPrevia = estado.ultimoRefresco?.fecha;
    const e = await api('/api/estado', undefined, document.visibilityState === 'visible' ? { 'X-Seki-Tablero': '1' } : {});
    estado.trabajos = new Map(e.trabajos.map((t) => [t.id, t]));
    estado.refrescando = e.refrescando;
    estado.ultimoRefresco = e.ultimoRefresco;
    estado.vigia = e.vigia ?? null;
    if (e.costoHoy?.trabajos !== estado.costoHoy?.trabajos) api('/api/costos').then((r) => { estado.resumenCostos = r; pintarBarra(); }).catch(() => {});
    estado.costoHoy = e.costoHoy;
    estado.presupuesto = e.presupuesto ?? null;
    estado.modoProyecto = e.modo ?? 'normal';
    const marcas = e.comentarios ?? {};
    for (const [id, marca] of Object.entries(marcas)) {
      const pr = FOTO.prs.find((x) => x.id === id);
      if (pr && estado.marcasComentarios[id] !== marca && estado.comentariosCargados.has(id)) sincronizarComentarios(pr);
    }
    estado.marcasComentarios = marcas;
    estado.avances = e.avances ?? {};
    estado.versionServidor = e.version ?? 'an older version';
    const termino = e.trabajos.some((t) => t.estado === 'terminado' && previo.get(t.id) !== 'terminado') || (eraRefresco && !e.refrescando) || (fechaPrevia && e.ultimoRefresco?.ok && e.ultimoRefresco.fecha !== fechaPrevia);
    if (termino) { FOTO = await api('/api/foto'); recargarEntregas(); }
    // If the user is typing in the detail, do not repaint: they would lose focus and half-written text.
    pintarTodo({ detalle: !$('detalle').contains(document.activeElement) });
    const activo = e.refrescando || e.trabajos.some((t) => ['en_cola', 'en_curso', 'bloqueado_presupuesto'].includes(t.estado));
    // While idle it keeps asking once a minute: that tells the server the dashboard is open (merge watcher).
    espera = activo ? 3000 : 60000;
  } catch (err) {
    // If the session serving the dashboard closed, another open session takes it over on the same link: it retries on its own.
    estado.ultimoRefresco = { ok: false, sinConexion: true, mensaje: `No connection to the local server (${err.message}). Retrying every 5 seconds; if no other Claude Code session is open, open it with /seki-review:review-prs.` };
    pintarBarra();
    espera = 5000;
  }
  sondeando = false;
  clearTimeout(sondeo);
  sondeo = setTimeout(sondear, otraVez ? 0 : espera);
  otraVez = false;
}

// A hidden tab stops marking the dashboard as open; coming back to it polls at once.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && API) sondear(); });

async function accionApi(ruta, cuerpo) {
  try {
    const r = await api(ruta, cuerpo);
    if (r?.reutilizados) avisar('The explanation already covers the current commit.');
  } catch (err) { avisar(err.message); }
  sondear();
}

function copiar(boton, texto) {
  const fin = (t) => marcarCopia(boton, t);
  // writeText may throw before returning a promise (no permission, insecure context): that is a failed copy too.
  let escrito;
  try { escrito = navigator.clipboard ? navigator.clipboard.writeText(texto) : Promise.reject(); } catch { escrito = Promise.reject(); }
  Promise.resolve(escrito).then(() => fin('Copied'), () => fin('Could not copy'));
}

document.addEventListener('click', (ev) => {
  if ($('barraSel') && !ev.target.closest('#barraSel') && window.getSelection()?.isCollapsed) cerrarBarraSel();
  const salto = ev.target.closest('a[data-saltar]');
  if (salto) { ev.preventDefault(); const a = $(salto.dataset.saltar); a.removeAttribute('data-plegado'); a.scrollIntoView({ block: 'start' }); return; }
  const ir = ev.target.closest('a[data-ir]');
  if (ir) { ev.preventDefault(); return seleccionar(ir.dataset.ir); }
  const casilla = ev.target.closest('[data-caja-sugerido]');
  if (casilla) { leerCaja(); estado.caja.conSugerido = casilla.checked; return marcarSeleccion(); }
  const nSel = ev.target.closest('.n-sel');
  if (nSel) return seleccionarLinea(nSel, ev.shiftKey);
  const t = ev.target.closest('button, a[data-tab-ir]');
  if (!t) return;
  const d = t.dataset;
  if (d.id) return seleccionar(d.id);
  if (d.grupoToggle) {
    estado.cerrados.has(d.grupoToggle) ? estado.cerrados.delete(d.grupoToggle) : estado.cerrados.add(d.grupoToggle);
    almacen.escribir('seki-review:cerrados', [...estado.cerrados]);
    t.closest('.grupo').toggleAttribute('data-cerrado');
    t.setAttribute('aria-expanded', String(!estado.cerrados.has(d.grupoToggle)));
    return;
  }
  if (d.vista) { estado.vista = d.vista; return pintarTodo(); }
  if (d.portal !== undefined) { estado.portal = d.portal || null; return pintarTodo(); }
  if (d.filtro) { estado.filtros.has(d.filtro) ? estado.filtros.delete(d.filtro) : estado.filtros.add(d.filtro); return pintarTodo(); }
  if (d.rol) {
    estado.rol = d.rol;
    almacen.escribir('seki-review:rol', estado.rol);
    document.querySelectorAll('[data-rol]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.rol === estado.rol)));
    return pintarTodo();
  }
  if (d.tab) { estado.tab = d.tab; history.replaceState(null, '', `#${encodeURIComponent(estado.seleccion)}/${estado.tab}`); return pintarDetalle(); }
  if (d.tabIr) { ev.preventDefault(); estado.tab = d.tabIr; return pintarDetalle(); }
  if (d.copiar) return copiar(t, d.copiar);
  if (d.accion === 'limpiar') { estado.filtros.clear(); estado.portal = null; estado.filtroIa = null; $('buscar').value = ''; return pintarTodo(); }
  if (d.accion === 'filtrarIa') return filtrarConIa();
  if (d.accion === 'forzarFiltroIa') { const q = estado.filtroIa?.consulta; estado.filtroIa = null; return filtrarConIa(q, { forzar: true }); }
  if (d.accion === 'reintentarFiltroIa') { const q = estado.filtroIa?.consulta; estado.filtroIa = null; return filtrarConIa(q); }
  if (d.accion === 'relacionadasFiltroIa' && estado.filtroIa?.estado === 'listo') { estado.filtroIa.conRelacionadas = !estado.filtroIa.conRelacionadas; return pintarTodo({ detalle: false }); }
  if (d.accion === 'quitarFiltroIa') { estado.filtroIa = null; return pintarTodo({ detalle: false }); }
  if (d.accion === 'guardarFiltroIa' && estado.filtroIa) {
    almacen.escribir(claveVistasIa(), [...vistasIa().filter((v) => !mismaConsulta(v, estado.filtroIa.consulta)), estado.filtroIa.consulta]);
    avisar('View saved in the sidebar.');
    return pintarTodo({ detalle: false });
  }
  if (d.vistaIa !== undefined) {
    const v = vistasIa()[+d.vistaIa];
    if (mismaConsulta(estado.filtroIa?.consulta, v)) { estado.filtroIa = null; return pintarTodo({ detalle: false }); }
    return v && filtrarConIa(v);
  }
  if (d.quitarVistaIa !== undefined) {
    almacen.escribir(claveVistasIa(), vistasIa().filter((_, i) => i !== +d.quitarVistaIa));
    return pintarLateral();
  }
  if (d.accion === 'volver') { document.body.dataset.vista = 'cola'; return; }
  if (d.accion === 'exportar') return exportar();
  if (d.accion === 'importar') return $('archivoRevision').click();
  if (d.accion === 'copiarResumen') return copiar(t, resumenTexto());
  if (d.plegar) return $(d.plegar).toggleAttribute('data-plegado');
  if (d.accion === 'lateral') return alternarLateral();
  if (d.accion === 'cola') return alternarCola();
  if (d.accion === 'preguntarPr') return preguntarPr(prSel());
  if (d.accion === 'quitarRespondeA') { estado.respondeA = null; return repintarDetalle(); }
  if (d.verMas) { estado.expandidas.has(d.verMas) ? estado.expandidas.delete(d.verMas) : estado.expandidas.add(d.verMas); return repintarDetalle(); }
  if (d.comInvestigar) return investigar(prSel(), d.comInvestigar);
  if (d.comValorar) return valorar(prSel(), d.comValorar, d.util === 'si');
  if (d.accion === 'agregarPreguntaPr') return preguntarPr(prSel(), undefined, undefined, { enviar: false });
  if (d.bsel || d.bselRapida !== undefined) return accionBarraSel(d.bsel, d.bselRapida === undefined ? undefined : Number(d.bselRapida));
  if (d.bselLineas) return abrirCajaDeSeleccion(d.bselLineas);
  if (d.ampliar) return preguntarPr(prSel(), d.ampliar, `Expand the “${SECCIONES[d.ampliar]}” section: more detail and concrete examples taken from the diff.`);
  if (d.cajaTipo) { leerCaja(); estado.caja.tipo = d.cajaTipo; return marcarSeleccion(); }
  if (d.accion === 'cajaAgregar') return agregarComentario();
  if (d.accion === 'cajaCancelar') return cerrarCaja();
  if (d.comEditar) return editarComentario(prSel(), d.comEditar);
  if (d.comBorrar) { borrarComentarios(prSel(), [d.comBorrar]); repintarDetalle(); return pintarCola(); }
  if (d.accion === 'descartarBorradores') {
    if (!estado.confirmarDescarte) { estado.confirmarDescarte = true; return repintarDetalle(); }
    estado.confirmarDescarte = false;
    const pr = prSel();
    borrarComentarios(pr, borradores(pr).map((c) => c.id));
    repintarDetalle();
    return pintarCola();
  }
  if (d.accion === 'enviarRevision') return enviarRevision(prSel());
  if (d.comReintentar) return enviarRevision(prSel(), [d.comReintentar]);
  if (d.comRepreguntar) return repreguntar(prSel(), d.comRepreguntar);
  if (d.propAprobar) {
    if (estado.propuestas.get(d.propAprobar)?.conFallos && estado.confirmarAprobar !== d.propAprobar) { estado.confirmarAprobar = d.propAprobar; return repintarDetalle(); }
    t.disabled = true;
    return accionPropuesta('aprobar', d.propAprobar, { confirmarFallos: estado.confirmarAprobar === d.propAprobar });
  }
  if (d.propAjustar) { estado.ajustando = estado.ajustando === d.propAjustar ? null : d.propAjustar; repintarDetalle(); return $('ajusteTexto')?.focus({ preventScroll: true }); }
  if (d.propEnviarAjuste) {
    const indicacion = $('ajusteTexto')?.value.trim();
    if (!indicacion) return avisar('Write what to change in the proposal.');
    return accionPropuesta('ajustar', d.propEnviarAjuste, { indicacion });
  }
  if (d.propDescartar) return accionPropuesta('descartar', d.propDescartar);
  if (d.propRegenerar) return accionPropuesta('regenerar', d.propRegenerar);
  if (d.propCopiar) return copiar(t, estado.propuestas.get(d.propCopiar)?.patch ?? '');
  if (d.accion === 'enfoque') { document.body.toggleAttribute('data-enfoque'); return pintarDetalle(); }
  if (d.accion === 'plegarTodo') { document.querySelectorAll('.archivo').forEach((a) => a.setAttribute('data-plegado', '')); return; }
  if (d.accion === 'refrescar') { estado.refrescando = true; pintarBarra(); return accionApi('/api/refrescar', {}); }
  if (d.accion === 'completarCobertura') {
    const pr = FOTO.prs.find((p) => p.id === estado.seleccion);
    estado.trabajos.set(pr.id, { id: pr.id, estado: 'en_cola' });
    pintarTodo();
    return accionApi('/api/analizar', { prs: [{ repo: pr.repo, numero: pr.numero }], completar: true });
  }
  if (d.accion === 'analizar') {
    const pr = FOTO.prs.find((p) => p.id === estado.seleccion);
    estado.trabajos.set(pr.id, { id: pr.id, estado: 'en_cola' });
    pintarTodo();
    return accionApi('/api/analizar', { prs: [{ repo: pr.repo, numero: pr.numero }] });
  }
  if (d.accion === 'pedirConfirmacion') { estado.confirmarPendientes = true; pintarLateral(); setTimeout(() => { estado.confirmarPendientes = false; pintarLateral(); }, 6000); return; }
  if (d.accion === 'analizarPendientes') {
    estado.confirmarPendientes = false;
    const prs = pendientesDeAnalisis().sort((a, b) => Number(b.seguridad) - Number(a.seguridad)).map((p) => ({ repo: p.repo, numero: p.numero }));
    return accionApi('/api/analizar', { prs });
  }
  if (d.accion === 'cancelarCola') return accionApi('/api/cancelar-cola', {});
});

document.addEventListener('change', (ev) => {
  if (ev.target.id === 'archivoRevision') {
    if (ev.target.files[0]) importar(ev.target.files[0]);
    ev.target.value = '';
    return;
  }
  const pr = FOTO.prs.find((p) => p.id === estado.seleccion);
  if (!pr) return;
  if (ev.target.name === 'decision') return guardarRevision(pr, { decision: ev.target.value });
  if (ev.target.dataset.visto !== undefined) {
    const vistos = new Set(almacen.leer(claveVistos(pr), []));
    ev.target.checked ? vistos.add(ev.target.dataset.visto) : vistos.delete(ev.target.dataset.visto);
    almacen.escribir(claveVistos(pr), [...vistos]);
    const seccion = ev.target.closest('.archivo');
    if (ev.target.checked) seccion.setAttribute('data-plegado', ''); else seccion.removeAttribute('data-plegado');
    const scroll = $('detalle').scrollTop;
    pintarDetalle();
    $('detalle').scrollTop = scroll;
    return;
  }
  if (ev.target.dataset.accionDiff === 'ajustar') { almacen.escribir('seki-review:ajustar', ev.target.checked); return pintarDetalle(); }
  if (ev.target.dataset.paso !== undefined) {
    const marcados = [...document.querySelectorAll('[data-paso]:checked')].map((x) => +x.dataset.paso);
    almacen.escribir(clavePasos(pr), marcados);
    pintarDetalle();
  }
});

let temporizadorNota;
document.addEventListener('input', (ev) => {
  if (ev.target.id === 'buscar') return pintarCola();
  if (ev.target.id === 'notaRevision') {
    const pr = FOTO.prs.find((p) => p.id === estado.seleccion);
    clearTimeout(temporizadorNota);
    temporizadorNota = setTimeout(() => guardarRevision(pr, { nota: ev.target.value }), 400);
  }
});

document.addEventListener('keydown', (ev) => {
  if ((ev.target.id === 'cajaTexto' || ev.target.id === 'cajaSugerido') && ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); return agregarComentario(); }
  if (ev.target.id === 'buscar' && ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && API) { ev.preventDefault(); return filtrarConIa(); }
  if (ev.target.id === 'preguntaPr' && ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); return preguntarPr(prSel()); }
  if (ev.target.id === 'barraSelTexto' && ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); return accionBarraSel('agregar'); }
  if (ev.key === 'Escape' && $('barraSel')) { ev.preventDefault(); return cerrarBarraSel(); }
  if (ev.target.matches('input, textarea, select')) {
    if (ev.key === 'Escape') ev.target.blur();
    return;
  }
  if (ev.key === 'Escape' && estado.seleccionLineas) { estado.seleccionLineas = null; return marcarSeleccion(); }
  if (ev.key === 'Escape' && document.body.hasAttribute('data-enfoque')) { document.body.removeAttribute('data-enfoque'); return pintarDetalle(); }
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const filas = [...document.querySelectorAll('.grupo:not([data-cerrado]) .fila')];
  const i = filas.findIndex((f) => f.dataset.id === estado.seleccion);
  const ir = (f) => f && seleccionar(f.dataset.id, { enfocar: true });
  if (ev.key === 'j' || ev.key === 'ArrowDown') { ev.preventDefault(); ir(filas[i + 1] ?? filas[i]); }
  if (ev.key === 'k' || ev.key === 'ArrowUp') { ev.preventDefault(); ir(filas[Math.max(i - 1, 0)]); }
  if (ev.key === '/') { ev.preventDefault(); $('buscar').focus(); }
  if (ev.key === '[') { ev.preventDefault(); alternarLateral(); }
  if (ev.key === ']') { ev.preventDefault(); alternarCola(); }
  if (ev.key === 'o') { const pr = FOTO.prs.find((p) => p.id === estado.seleccion); if (pr) window.open(pr.url, '_blank', 'noopener'); }
});

$('titulo').textContent = `Seki Review · ${FOTO.proyecto}`;
$('foto').textContent = `GitHub data from ${new Date(FOTO.generado).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`;
document.querySelectorAll('[data-rol]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.rol === estado.rol)));
aplicarLateral(almacen.leer('seki-review:sin-lateral', false));
aplicarCola(almacen.leer('seki-review:sin-cola', false));
estado.caja = cajaVacia();
const [inicial, tabInicial] = decodeURIComponent(location.hash.slice(1)).split('/');
if (CUERPOS[tabInicial]) estado.tab = tabInicial;
pintarTodo();
if (FOTO.prs.some((p) => p.id === inicial)) seleccionar(inicial);
else if (mensajeRutaDesconocida(inicial)) {
  // A PR added from the chat arrives with the next refresh: it is selected then.
  if (API) { estado.seleccionPendiente = inicial; estado.pendienteDeRuta = true; }
  avisar(mensajeRutaDesconocida(inicial));
}
if (API) sondear();
