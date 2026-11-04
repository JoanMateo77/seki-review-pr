function copiar(boton, texto) {
  const original = boton.innerHTML;
  const fin = (t) => { boton.textContent = t; setTimeout(() => { boton.innerHTML = original; }, 1400); };
  (navigator.clipboard ? navigator.clipboard.writeText(texto) : Promise.reject()).then(() => fin('Copied'), () => fin('Could not copy'));
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
if (API) sondear();
