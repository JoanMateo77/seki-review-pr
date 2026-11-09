<script>
let FOTO = /*DATOS*/null;
// With the local server (tablero_servir) this is { token } and actions appear; as a standalone file it is null.
const API = /*API*/null;
const VERSION_PAGINA = /*VERSION*/null;
// Diffs per PR, already trimmed. When served, missing ones are fetched from /api/diff.
const DIFFS = /*DIFFS*/null ?? {};

const GRUPOS = {
  pruebas_sin_prod: ['In testing, not in production', 'Code in testing that is not in production or in any PR to production'],
  solo_prod: ['Ready for production', 'The code is already in testing; it still needs merging to production'],
  revisar_diferencias: ['Review differences with testing', 'Testing has a different version of the change'],
  pruebas_abierta: ['Waiting for merge in testing', 'Its PR to testing is still open'],
  sin_pruebas: ['Not through testing', 'There is no PR to testing and the code is not there'],
  hacia_pruebas: ['To testing', 'Open PRs against the testing branches'],
  pruebas_automaticas: ['Automated tests only', 'They do not change behavior'],
  otra: ['Other branches', 'Base outside the configured lines'],
  inactiva: ['Branches no longer in use', 'Branches marked as inactive in the project configuration'],
};
const DECISIONES = {
  aprobada: ['Approved', 'verde'],
  probada: ['Verified in testing', 'verde'],
  duda: ['Has questions', 'ambar'],
  cambios: ['Requests changes', 'rojo'],
};
const GRUPOS_REVISOR = {
  sin_revisar: ['Not reviewed', 'No reviewer decision yet'],
  cambios: ['Requests changes', 'The reviewer left feedback'],
  duda: ['Has questions', 'Waiting on a clarification from the author'],
  aprobada: ['Approved', 'Ready from the reviewer’s point of view'],
  probada: ['Verified in testing', 'Functionally validated'],
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icono = (nombre, clase = '') => `<svg class="i ${clase}" aria-hidden="true"><use href="#i-${nombre}"/></svg>`;
const almacen = {
  leer(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  escribir(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
const claveRevision = (pr) => `seki-review:revision:${pr.id}`;
const clavePasos = (pr, sha = pr.headSha) => `seki-review:probado:${pr.id}:${sha}`;
const revision = (pr) => almacen.leer(claveRevision(pr));
const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
const gh = (repo, n) => `https://github.com/${FOTO.owner}/${repo}/pull/${n}`;

const estado = {
  expandidas: new Set(),
  respondeA: null,
  rol: almacen.leer('seki-review:rol', 'autor'),
  vista: 'cola',
  seleccionLineas: null,
  lineasArchivo: [],
  archivosTab: [],
  caja: null,
  confirmarDescarte: false,
  comentariosCargados: new Set(),
  propuestas: new Map(),
  confirmarAprobar: null,
  ajustando: null,
  marcasComentarios: {},
  avances: {},
  filtroIa: null,
  portal: null,
  filtros: new Set(),
  cerrados: new Set(almacen.leer('seki-review:cerrados', ['pruebas_automaticas'])),
  seleccion: null,
  tab: 'resumen',
  trabajos: new Map(),
  refrescando: false,
  ultimoRefresco: null,
  confirmarPendientes: false,
};
const trabajo = (pr) => estado.trabajos.get(pr.id);
// Brief feedback on a copy button. The original label is kept once per button, so a second click inside the window
// does not take "Copied" as the label to restore.
const marcasCopia = new WeakMap();
function marcarCopia(boton, texto) {
  const previa = marcasCopia.get(boton);
  if (previa) clearTimeout(previa.reloj);
  const original = previa?.original ?? boton.innerHTML;
  boton.textContent = texto;
  // A button re-rendered away meanwhile keeps its new markup: the stale original is not written back.
  marcasCopia.set(boton, { original, reloj: setTimeout(() => { if (boton.isConnected) boton.innerHTML = original; marcasCopia.delete(boton); }, 1400) });
}
const usd = (x) => { const n = Number(x) || 0; return `USD ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 0.01 ? 4 : 2 })}`; };
const nombreModelo = (m) => (m ?? '').replace(/^claude-/, '').replace(/-\d.*$/, '').replace(/^./, (c) => c.toUpperCase());
const costoTexto = (t) => `${t.modelo ? ` · ${nombreModelo(t.modelo)}` : ''}${t.costo ? ` · ${usd(t.costo)}` : ''}`;
const trabajoActivo = (pr) => ['en_cola', 'en_curso', 'bloqueado_presupuesto'].includes(trabajo(pr)?.estado);
// PRs listed only to be reviewed are analyzed one by one from their detail, never in bulk.
const pendientesDeAnalisis = () => FOTO.prs.filter((p) => p.ambiente !== 'inactiva' && !p.soloRevision && (!p.explicacion || p.explicacion.desactualizada) && !trabajoActivo(p));

// One tone per PR, the most severe that applies: red blocks, amber needs a look, green ready, violet merged.
function tono(pr) {
  const v = pr.verificaciones?.resumen ?? {};
  if (v.bloqueante || (pr.sinProd && pr.seguridad)) return 'rojo';
  if (pr.sinProd || v.alto || pr.estadoPruebas?.estado === 'parcial' || pr.explicacion?.riesgo === 'alto') return 'ambar';
  if (pr.estadoPr === 'MERGED') return 'violeta';
  if (pr.accion === 'solo_prod') return 'verde';
  return '';
}

const definicionGrupos = () => (estado.rol === 'revisor' ? GRUPOS_REVISOR : GRUPOS);
const grupoDe = (pr) => (estado.rol === 'revisor' ? revision(pr)?.decision ?? 'sin_revisar' : pr.accion);
const enVista = (pr) => (estado.vista === 'inactivas' ? pr.ambiente === 'inactiva' : pr.ambiente !== 'inactiva');

function pasaFiltros(pr) {
  if (!enVista(pr)) return false;
  if (estado.filtroIa?.estado === 'listo' && !incluidaEnFiltro(estado.filtroIa, pr.id)) return false;
  if (estado.portal && pr.portal !== estado.portal) return false;
  const v = pr.verificaciones?.resumen ?? {};
  if (estado.filtros.has('seguridad') && !pr.seguridad) return false;
  if (estado.filtros.has('hallazgos') && !(v.bloqueante || v.alto)) return false;
  if (estado.filtros.has('sinExplicacion') && pr.explicacion && !pr.explicacion.desactualizada) return false;
  if (estado.filtros.has('sinRevisar') && revision(pr)) return false;
  const q = $('buscar').value.trim().toLowerCase();
  if (q) {
    const archivos = [...(pr.explicacion?.orden_lectura ?? []).map((o) => o.archivo), ...(pr.verificaciones?.hallazgos ?? []).map((h) => h.archivo)].join(' ');
    if (!`${pr.numero} #${pr.numero} ${pr.titulo} ${pr.rama} ${pr.repo} ${pr.portal} ${archivos}`.toLowerCase().includes(q)) return false;
  }
  return true;
}

function pintarLateral() {
  const base = FOTO.prs.filter(enVista);
  const portales = [...new Set(base.map((p) => p.portal))].sort();
  const cuenta = (fn) => base.filter(fn).length;
  const inactivas = FOTO.prs.filter((p) => p.ambiente === 'inactiva').length;
  const nav = (attrs, contenido, n, activo) => `<button class="nav" ${attrs} aria-pressed="${activo}">${contenido}<span class="n">${n}</span></button>`;
  const filtro = (clave, texto, n) => nav(`data-filtro="${clave}"`, texto, n, estado.filtros.has(clave));
  $('lateral').innerHTML = `
    <h2>Views</h2>
    ${nav('data-vista="cola"', 'Work queue', FOTO.prs.length - inactivas, estado.vista === 'cola')}
    ${nav('data-vista="inactivas"', 'Branches no longer in use', inactivas, estado.vista === 'inactivas')}
    <h2>Portal</h2>
    ${nav('data-portal=""', 'All', base.length, !estado.portal)}
    ${portales.map((p) => nav(`data-portal="${esc(p)}"`, esc(p), cuenta((x) => x.portal === p), estado.portal === p)).join('')}
    <h2>Filters</h2>
    ${filtro('hallazgos', `${icono('alerta')} High findings`, cuenta((x) => x.verificaciones?.resumen.bloqueante || x.verificaciones?.resumen.alto))}
    ${filtro('seguridad', `${icono('escudo')} Security`, cuenta((x) => x.seguridad))}
    ${filtro('sinExplicacion', `${icono('circulo')} No explanation`, cuenta((x) => !x.explicacion || x.explicacion.desactualizada))}
    ${filtro('sinRevisar', `${icono('ojo')} Not reviewed`, cuenta((x) => !revision(x)))}
    ${API && vistasIa().length ? `<h2>AI views</h2>${vistasIa().map((v, i) => {
      const activa = mismaConsulta(estado.filtroIa?.consulta, v);
      return `<div class="vista-ia">${nav(`data-vista-ia="${i}" title="${esc(v)}"`, `${icono('chispa')}<span class="recorte">${esc(v)}</span>`, activa && estado.filtroIa.estado === 'listo' ? cuentaFiltro(estado.filtroIa).directas : '', activa)}<button type="button" class="btn-texto quitar-vista" data-quitar-vista-ia="${i}" aria-label="Remove the view ${esc(v)}" title="Remove the view">×</button></div>`;
    }).join('')}` : ''}
    ${API ? `<h2>AI analysis</h2>
      ${estado.confirmarPendientes
        ? nav('data-accion="analizarPendientes"', `${icono('chispa')} Confirm: ${plural(pendientesDeAnalisis().length, 'PR', 'PRs')}`, '', true)
        : nav('data-accion="pedirConfirmacion"', `${icono('chispa')} Analyze those without an explanation`, pendientesDeAnalisis().length, false)}
      ${(() => { const esperando = [...estado.trabajos.values()].filter((t) => t.estado === 'en_cola' || t.estado === 'bloqueado_presupuesto').length; return esperando ? nav('data-accion="cancelarCola"', `${icono('bloqueo')} Cancel queued ones`, esperando, false) : ''; })()}
      ${trabajosIaHtml()}` : ''}
    <div class="solo-escritorio">
      <h2>Review</h2>
      <button class="nav" data-accion="exportar">${icono('descargar')} Export review</button>
      <button class="nav" data-accion="importar">${icono('subir')} Import review</button>
      <div class="ayuda"><span><kbd>j</kbd> <kbd>k</kbd> move through the queue</span><span><kbd>o</kbd> open in GitHub</span><span><kbd>/</kbd> search</span><span><kbd>[</kbd> sidebar</span><span><kbd>]</kbd> queue</span></div>
    </div>`;
}

function senales(pr) {
  const s = [];
  const v = pr.verificaciones?.resumen ?? {};
  if (v.bloqueante) s.push(`<span class="senal rojo" title="${plural(v.bloqueante, 'blocking check', 'blocking checks')}">${icono('bloqueo')}${v.bloqueante}</span>`);
  else if (v.alto) s.push(`<span class="senal ambar" title="${plural(v.alto, 'high finding', 'high findings')}">${icono('alerta')}${v.alto}</span>`);
  const r = revision(pr);
  if (r?.decision) {
    const [txt, cls] = DECISIONES[r.decision] ?? [r.decision, ''];
    s.push(`<span class="senal ${cls}" title="Reviewer: ${esc(txt)}">${icono(cls === 'rojo' ? 'bloqueo' : cls === 'ambar' ? 'alerta' : 'ok')}</span>`);
  }
  const t = trabajo(pr);
  if (t?.estado === 'en_curso') s.push(`<span class="senal azul" title="Analyzing with AI">${icono('actualizar', 'girando')}</span>`);
  else if (t?.estado === 'en_cola') s.push(`<span class="senal azul" title="Queued for analysis">${icono('reloj')}</span>`);
  else if (t?.estado === 'bloqueado_presupuesto') s.push(`<span class="senal ambar" title="Blocked by the daily budget">${icono('alerta')}</span>`);
  else if (t?.estado === 'error') s.push(`<span class="senal rojo" title="The analysis failed">${icono('bloqueo')}</span>`);
  const cs = vivos(pr).length;
  if (cs) s.push(`<span class="senal" title="${plural(cs, 'comment', 'comments')} on the diff">${icono('comentario')}${cs}</span>`);
  if (pr.paraRevisar && !pr.soloRevision) s.push(`<span class="senal" title="Also in the To review list">${esc(ORIGEN_PARA_REVISAR[pr.paraRevisar] ?? '')}</span>`);
  if (pr.seguridad) s.push(`<span class="senal" title="Security">${icono('escudo')}</span>`);
  if (pr.ultraSugerida && modoActual() !== 'ahorro') s.push(`<span class="senal violeta" title="Ultra review suggested">${icono('chispa')}Ultra</span>`);
  const esfuerzo = pr.explicacion?.esfuerzo ?? pr.esfuerzoTamano;
  if (esfuerzo) s.push(`<span title="Review effort, 1 to 5">E${esfuerzo}</span>`);
  s.push(`<span title="Days since it was opened">${pr.dias} d</span>`);
  return s.join('');
}

function pintarCola() {
  const todos = FOTO.prs.filter(pasaFiltros);
  const prs = todos.filter((p) => !p.soloRevision);
  const paraRevisar = todos.filter((p) => p.soloRevision);
  if (!todos.length) {
    $('cola').innerHTML = `${avisoVersion()}${bannerFiltroIa()}<div class="vacio"><p>No PRs match the search and active filters.</p><button class="btn" data-accion="limpiar">Clear filters</button></div>`;
    return;
  }
  const defs = definicionGrupos();
  const orden = Object.keys(defs);
  const porGrupo = new Map();
  for (const pr of prs) {
    const g = grupoDe(pr);
    if (!porGrupo.has(g)) porGrupo.set(g, []);
    porGrupo.get(g).push(pr);
  }
  const posicion = (g) => (orden.includes(g) ? orden.indexOf(g) : 99);
  $('cola').innerHTML = avisoVersion() + bannerFiltroIa() + seccionParaRevisar(paraRevisar) + (estado.filtroIa ? '' : seccionCambios()) + [...porGrupo.keys()].sort((a, b) => posicion(a) - posicion(b)).map((g) => {
    const [nombre, desc] = defs[g] ?? GRUPOS[g] ?? [FOTO.acciones?.[g] ?? g, ''];
    const filas = porGrupo.get(g).sort((a, b) => a.repo.localeCompare(b.repo) || b.numero - a.numero);
    const cerrado = estado.cerrados.has(g);
    return `<section class="grupo" ${cerrado ? 'data-cerrado' : ''}>
      <button class="grupo-cab" data-grupo-toggle="${g}" aria-expanded="${!cerrado}">${icono('chevron')}<span>${esc(nombre)}</span><span class="n">${filas.length}</span><span class="desc">${esc(desc)}</span></button>
      <div class="filas">${filas.map((pr) => conQuitarRevisar(pr, `
        <button class="fila" data-id="${esc(pr.id)}" aria-current="${estado.seleccion === pr.id}">
          <span class="punto ${tono(pr)}"></span>
          <span class="id mono">${esc(pr.repoEtiqueta)} #${pr.numero}</span>
          <span class="titulo" title="${esc(pr.titulo)}">${esc(pr.titulo)}</span>
          <span class="senales">${senales(pr)}</span>
          ${estado.filtroIa?.estado === 'listo' ? motivoHtml(estado.filtroIa.motivos.get(pr.id)) : ''}
        </button>`)).join('')}</div>
    </section>`;
  }).join('');
}

// AI filter: the need is typed in the search box. Needs saved as views live in this browser.
const claveVistasIa = () => `seki-review:vistas-ia:${FOTO.proyecto}`;
const vistasIa = () => almacen.leer(claveVistasIa(), []);
const mismaConsulta = (a, b) => a?.toLowerCase() === b?.toLowerCase();
// Direct: the PR’s purpose is the need. Related: touches the area with another purpose; shown only on request.
const incluidaEnFiltro = (f, id) => { const m = f.motivos.get(id); return !!m && (m.relacion !== 'relacionada' || f.conRelacionadas); };
const cuentaFiltro = (f) => {
  const todas = [...f.motivos.values()];
  return { directas: todas.filter((m) => m.relacion !== 'relacionada').length, relacionadas: todas.filter((m) => m.relacion === 'relacionada').length };
};
const motivoHtml = (m) => (m ? `<span class="motivo-ia">${m.relacion === 'relacionada' ? '<span class="etiqueta-relacionada">Related</span> ' : ''}${esc(m.motivo)}</span>` : '');
const firmaFoto = () => FOTO.prs.map((x) => `${x.id}@${x.headSha}`).sort().join('|');

async function filtrarConIa(consulta, { forzar = false } = {}) {
  const q = (consulta ?? $('buscar').value).replace(/\s+/g, ' ').trim();
  if (!q) { avisar('Type in the search box which PRs you are looking for, for example “cybersecurity PRs”.'); return $('buscar').focus(); }
  if (servidorDesfasado()) return avisar('Restart Claude Code: the dashboard server is from an older version and does not have Filter with AI yet.');
  if (estado.filtroIa?.estado === 'cargando' && mismaConsulta(estado.filtroIa.consulta, q)) return;
  const pedido = { consulta: q, estado: 'cargando', inicio: new Date().toISOString(), firma: firmaFoto() };
  estado.filtroIa = pedido;
  $('buscar').value = '';
  pintarTodo({ detalle: false });
  let siguiente;
  try {
    const r = await api('/api/filtrar', forzar ? { consulta: q, forzar: true } : { consulta: q });
    siguiente = { ...pedido, estado: 'listo', motivos: new Map(r.coincidencias.map((c) => [c.id, c])), conRelacionadas: false, costo: r.costo, desdeCache: r.desdeCache };
  } catch (err) {
    siguiente = { ...pedido, estado: 'error', mensaje: err.message, forzar: err.estado === 429 && err.forzar };
  }
  // If the filter was removed or another one requested meanwhile, this response no longer applies.
  if (estado.filtroIa !== pedido) return;
  estado.filtroIa = siguiente;
  pintarTodo({ detalle: false });
  if (siguiente.estado === 'listo' && !siguiente.desdeCache) sondear();
}

const servidorDesfasado = () => !!(API && VERSION_PAGINA && estado.versionServidor && estado.versionServidor !== VERSION_PAGINA);
function avisoVersion() {
  if (!servidorDesfasado()) return '';
  return `<div class="filtro-ia error" role="alert"><p>${icono('alerta')} The plugin was updated to version ${esc(VERSION_PAGINA)}, but the dashboard server is still on ${esc(estado.versionServidor)}. New features (such as Filter with AI) won’t respond until you restart Claude Code.</p></div>`;
}

function bannerFiltroIa() {
  const f = estado.filtroIa;
  if (!f) return '';
  const q = `“${esc(f.consulta)}”`;
  const quitar = '<button type="button" class="btn-texto" data-accion="quitarFiltroIa">Remove filter</button>';
  if (f.estado === 'cargando') {
    return `<div class="filtro-ia" role="status"><p class="trabajando">${icono('actualizar', 'girando')}<span>AI is reviewing ${plural(FOTO.prs.length, 'PR', 'PRs')} for ${q} · ${transcurrido(f.inicio)}</span></p>
      <div class="progreso" aria-hidden="true"></div><p class="muy-tenue">Uses each PR’s title, branch and files; usually takes 10 to 40 seconds. ${quitar}</p></div>`;
  }
  if (f.estado === 'error') {
    return `<div class="filtro-ia error" role="alert"><p>${icono('alerta')} ${esc(f.mensaje)}</p>
      <p>${f.forzar ? '<button type="button" class="btn chico" data-accion="forzarFiltroIa">Run anyway</button>' : '<button type="button" class="btn chico" data-accion="reintentarFiltroIa">Retry</button>'} ${quitar}</p></div>`;
  }
  const visibles = FOTO.prs.filter(pasaFiltros).length;
  const { directas, relacionadas } = cuentaFiltro(f);
  const ocultas = (f.conRelacionadas ? directas + relacionadas : directas) - visibles;
  const verRelacionadas = relacionadas
    ? ` · <button type="button" class="btn-texto" data-accion="relacionadasFiltroIa" aria-pressed="${f.conRelacionadas}" title="PRs that touch the area but have a different purpose (copy, a visual tweak, a feature)">${f.conRelacionadas ? 'Hide' : 'Show'} ${plural(relacionadas, 'related', 'related')}</button>` : '';
  const guardada = vistasIa().some((v) => mismaConsulta(v, f.consulta));
  const cambio = f.firma !== firmaFoto()
    ? `<p class="aviso-lento">${icono('reloj')} The queue changed after filtering. <button type="button" class="btn-texto" data-accion="reintentarFiltroIa">Filter again</button></p>` : '';
  return `<div class="filtro-ia" role="status">
    <p><strong>${icono('chispa')} AI filter</strong> ${q}: ${directas ? plural(directas, 'PR is about this', 'PRs are about this') : 'no PR is about this'}${verRelacionadas}${ocultas > 0 ? ` · ${plural(ocultas, 'hidden', 'hidden')} by the other filters or the view` : ''}</p>
    <p class="muy-tenue">${f.desdeCache ? 'Saved result, no cost' : usd(f.costo)} · decided by title, branch and files: check the reason for each one.</p>
    <p>${guardada ? '' : '<button type="button" class="btn-texto" data-accion="guardarFiltroIa">Save as view</button> · '}${quitar}</p>${cambio}</div>`;
}

function seccionCambios() {
  const c = FOTO.cambios;
  if (!c || estado.vista !== 'cola') return '';
  const fecha = (f) => new Date(f).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });
  const enlace = (x) => `<a href="${gh(x.repo, x.numero)}" target="_blank" rel="noopener" title="${esc(x.titulo)}">${esc(x.titulo)}</a>`;
  const fila = (etiqueta, color, x, extra = '') => `<div class="cambio"><span class="estado ${color}">${etiqueta}</span><span class="mono muy-tenue">${esc(x.repo.replace('core-', ''))} #${x.numero}</span><span class="titulo">${FOTO.prs.some((p) => p.id === x.id) ? `<a href="#" data-ir="${esc(x.id)}">${esc(x.titulo)}</a>` : enlace(x)}${extra}</span></div>`;
  const nombreGrupo = (g) => (GRUPOS[g] ?? [g])[0];
  const filas = [
    ...c.mergeadas.map((x) => fila('Merged', 'violeta', x, ` <span class="muy-tenue">into ${esc(x.base)}</span>`)),
    ...c.cerradas.map((x) => fila(x.estado === 'cerrada' ? 'Closed' : 'Left', '', x)),
    ...c.nuevas.map((x) => fila('New', 'verde', x)),
    ...c.movidas.map((x) => fila('Changed', 'ambar', x, ` <span class="muy-tenue">${esc(nombreGrupo(x.de))} → ${esc(nombreGrupo(x.a))}</span>`)),
  ];
  const n = filas.length;
  const cerrado = estado.cerrados.has('_cambios');
  return `<section class="grupo" ${cerrado ? 'data-cerrado' : ''}>
    <button class="grupo-cab" data-grupo-toggle="_cambios" aria-expanded="${!cerrado}">${icono('chevron')}<span>Detected changes</span><span class="n">${n}</span><span class="desc">between ${fecha(c.desde)} and ${fecha(c.hasta)}</span></button>
    <div class="filas">${filas.join('')}</div>
  </section>`;
}

// Elapsed time that updates every second without repainting the view.
const reloj = (desde) => { const s = Math.max(0, Math.floor((Date.now() - new Date(desde)) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
// aria-live="off": inside a live region, the clock would be announced every second.
const transcurrido = (desde) => (desde ? `<span class="transcurrido" data-desde="${esc(desde)}" aria-live="off">${reloj(desde)}</span>` : '');
setInterval(() => { for (const el of document.querySelectorAll('[data-desde]')) el.textContent = reloj(el.dataset.desde); }, 1000);

function check(icon, color, nombre, valor, detalle = '') {
  return `<div class="check"><span class="icono ${color}">${icono(icon)}</span><span class="nombre">${nombre}</span><span class="valor">${valor}${detalle ? `<small>${detalle}</small>` : ''}</span></div>`;
}

function pilaEstados(pr) {
  const filas = [];
  const ep = pr.estadoPruebas;
  if (ep) {
    const metodo = ep.metodo === 'parche' ? 'Checked by applying the change to the testing branch' : 'Compared file by file';
    const mapa = { en_pruebas: ['ok', 'verde', 'The code is already in testing'], parcial: ['alerta', 'ambar', 'Testing has a different version of the change'], no_en_pruebas: ['circulo', '', 'Not in testing yet'] };
    const [i, c, t] = mapa[ep.estado] ?? ['circulo', '', ep.estado];
    filas.push(check(i, c, 'Testing', t, `${ep.iguales} of ${ep.total} files identical${ep.conflicto ? ', with conflict' : ''}. ${metodo}.`));
  }
  if (pr.estadoProd) {
    const det = `${pr.estadoProd.iguales} of ${pr.estadoProd.total} files identical in production`;
    filas.push(pr.sinProd
      ? check('bloqueo', pr.seguridad ? 'rojo' : 'ambar', 'Production', 'Code not found in production and no PR to production', det)
      : check('ok', '', 'Production', pr.cubiertaPor ? `PR <a href="${gh(pr.repo, pr.cubiertaPor)}" target="_blank" rel="noopener">#${pr.cubiertaPor}</a> to production brings the same files` : 'No alerts', det));
  }
  if (pr.gemela) {
    const txt = { MERGED: 'merged', OPEN: 'open', CLOSED: 'closed without merging' }[pr.gemela.estado] ?? pr.gemela.estado;
    filas.push(check(pr.gemela.estado === 'MERGED' ? 'merge' : 'circulo', pr.gemela.estado === 'MERGED' ? 'verde' : '', pr.ambiente === 'prod' ? 'PR to testing' : 'PR to production',
      `<a href="${gh(pr.repo, pr.gemela.numero)}" target="_blank" rel="noopener">#${pr.gemela.numero}</a> ${txt}`, 'Found by title; the testing status above is the actual check'));
  }
  if (pr.hermanas?.length) {
    const faltan = pr.hermanas.some((h) => !h.numero);
    filas.push(check(faltan ? 'alerta' : 'ok', faltan ? 'ambar' : 'verde', 'Other portals',
      pr.hermanas.map((h) => (h.numero ? `${esc(h.portal)}: <a href="${gh(pr.repo, h.numero)}" target="_blank" rel="noopener">#${h.numero}</a>` : `${esc(h.portal)}: no equivalent PR`)).join(' · '),
      faltan ? 'Confirm whether the change also applies to that portal' : ''));
  }
  const v = pr.verificaciones;
  if (v) {
    const r = v.resumen;
    const [i, c] = r.bloqueante ? ['bloqueo', 'rojo'] : r.alto ? ['alerta', 'ambar'] : ['ok', 'verde'];
    const partes = [r.bloqueante && plural(r.bloqueante, 'blocking', 'blocking'), r.alto && plural(r.alto, 'high', 'high'), r.medio && plural(r.medio, 'medium', 'medium'), r.aviso && plural(r.aviso, 'warning', 'warnings')].filter(Boolean);
    filas.push(check(i, c, 'Checks', partes.length ? partes.join(', ') : 'No findings in the added lines', partes.length ? '<a href="#" data-tab-ir="verificaciones">View findings</a>' : ''));
  }
  const tr = trabajo(pr);
  if (tr) {
    const hora = (f) => (f ? new Date(f).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '');
    const mapa = {
      en_cola: ['reloj', '', 'Queued for analysis', ''],
      en_curso: ['actualizar', '', 'Analyzing the PR', `${transcurrido(tr.inicio)} · since ${hora(tr.inicio)} · usually takes one to three minutes<div class="progreso" role="progressbar" aria-label="Analysis in progress"></div>`],
      terminado: ['ok', 'verde', 'Explanation generated', `At ${hora(tr.fin)}${costoTexto(tr)}`],
      error: ['bloqueo', 'rojo', 'The analysis did not complete', esc(tr.mensaje ?? '')],
      bloqueado_presupuesto: ['alerta', 'ambar', 'Blocked by the daily budget', `${esc(tr.mensaje ?? '')} <button type="button" class="btn chico" data-forzar="${esc(tr.id)}">Run anyway</button>`],
      cancelado: ['circulo', '', 'Analysis canceled', ''],
    };
    const [i, c, txt, det] = mapa[tr.estado] ?? ['circulo', '', tr.estado, ''];
    filas.push(check(i, c, 'AI analysis', txt, det).replace('<svg class="i "', tr.estado === 'en_curso' ? '<svg class="i girando"' : '<svg class="i "'));
  }
  const rev = revision(pr);
  if (rev?.decision) {
    const [txt, cls] = DECISIONES[rev.decision] ?? [rev.decision, ''];
    const cambio = rev.headSha && rev.headSha !== pr.headSha ? ' · the PR changed after this review' : '';
    filas.push(check(cls === 'rojo' ? 'bloqueo' : cls === 'ambar' ? 'alerta' : 'ok', cls, 'Reviewer', esc(txt), `${esc(new Date(rev.fecha).toLocaleDateString('en-US'))}${cambio}`));
  } else if (pr.revisionGithub) {
    filas.push(check('ojo', '', 'GitHub review', esc(pr.revisionGithub)));
  }
  return filas.length ? `<div class="checks">${filas.join('')}</div>` : '';
}

const lista = (items) => (items?.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p class="sin-dato">No data.</p>');
const sec = (titulo, cuerpo, clave) => {
  if (!clave || !API) return `<div class="seccion"><h3>${titulo}</h3>${cuerpo}</div>`;
  const pr = prSel();
  const hilos = pr ? dePr(pr, clave) : [];
  return `<div class="seccion" data-seccion="${clave}"><h3 class="con-accion">${titulo}<button type="button" class="btn-texto" data-ampliar="${clave}" title="AI expands this section with examples from the diff">${icono('chispa')} Expand</button></h3>${cuerpo}
    ${hilos.length ? `<div class="hilos-pr">${hilosDiv(hilos)}</div>` : ''}</div>`;
};

function preguntaPrHtml(pr) {
  if (!API) return '';
  const generales = dePr(pr, null);
  const opciones = Object.entries(SECCIONES).filter(([k]) => pr.explicacion?.[k]?.length || k === 'resumen')
    .map(([k, t]) => `<option value="${k}">${esc(t)}</option>`).join('');
  return `<div class="seccion pregunta-pr"><h3>Ask about this PR</h3>
    ${generales.length ? `<div class="hilos-pr">${hilosDiv(generales)}</div>` : ''}
    ${estado.respondeA?.ambito === 'pr' ? `<div class="respondiendo">Continues the conversation from: “${esc(estado.respondeA.resumen)}” <button type="button" class="btn-texto" data-accion="quitarRespondeA">Remove</button></div>` : ''}
    <textarea id="preguntaPr" rows="3" placeholder="For example: what happens to the webhooks already configured in production?" aria-label="Question about the PR"></textarea>
    <div class="prop-acciones"><select id="preguntaPrSeccion" aria-label="Which part"><option value="">Whole PR</option>${opciones}</select>
      <label class="muy-tenue"><input type="checkbox" id="preguntaPrCodigo"> Check the code</label>
      <button type="button" class="btn chico primario" data-accion="preguntarPr">Ask</button><button type="button" class="btn chico" data-accion="agregarPreguntaPr">Add to review</button><span class="muy-tenue">Ctrl + Enter asks · you can also select text in the explanation or in an answer to ask about that part · the answer is more useful if the question doesn’t suggest the conclusion</span></div></div>`;
}

function coberturaHtml(e, pr) {
  const c = e.cobertura;
  if (!c) return '';
  const gen = c.generados ?? [];
  const aparte = c.leidosAparte ?? [];
  const extra = [aparte.length ? `${plural(aparte.length, 'file read', 'files read')} outside the message` : '', gen.length ? `${plural(gen.length, 'generated file skipped', 'generated files skipped')}` : ''].filter(Boolean).join(' · ');
  if (c.completa) return extra ? `<p class="origen">${icono('ok')} <span>AI reviewed the whole diff (${extra}).</span></p>` : '';
  const sin = c.sinDiff ?? [];
  const rec = c.recortados ?? [];
  const items = [...sin.map((a) => `<li><span class="mono">${esc(a)}</span> · not reviewed</li>`), ...rec.map((a) => `<li><span class="mono">${esc(a)}</span> · partly reviewed</li>`), ...gen.map((a) => `<li><span class="mono">${esc(a)}</span> · generated, not reviewed</li>`)];
  const boton = API ? `<p style="margin-top:8px"><button type="button" class="btn chico" data-accion="completarCobertura" ${trabajoActivo(pr) ? 'disabled' : ''}>${icono('chispa')} Review what was missed</button> <span class="muy-tenue">Analyzes only those files and extends the explanation</span></p>` : '';
  return `<details class="seccion cobertura"><summary><span class="estado ambar">${icono('alerta')} Partial coverage: AI did not see the full diff (${plural(sin.length, 'file not reviewed', 'files not reviewed')}${rec.length ? `, ${plural(rec.length, 'truncated', 'truncated')}` : ''})</span>${extra ? ` <span class="muy-tenue">${extra}</span>` : ''}</summary>
    ${boton}${items.length ? `<ul class="tenue">${items.slice(0, 80).join('')}</ul>` : ''}</details>`;
}

