function leerCaja() {
  const t = $('cajaTexto');
  if (t) estado.caja.texto = t.value;
  const s = $('cajaSugerido');
  if (s) estado.caja.sugerido = s.value;
}

function cajaHtml(rango) {
  const c = estado.caja;
  const pr = FOTO.prs.find((p) => p.id === estado.seleccion);
  const abierta = pr?.estadoPr === 'OPEN';
  const motivo = (k) => (k === 'nota' ? '' : !API ? 'Available when the dashboard is opened from Claude Code (tablero_servir)' : k === 'cambio' && !abierta ? 'The PR is no longer open' : '');
  const tabs = Object.entries(TIPOS_COMENTARIO).map(([k, t]) => `<button type="button" data-caja-tipo="${k}" aria-pressed="${c.tipo === k}" ${motivo(k) ? `disabled title="${motivo(k)}"` : ''}>${t.nombre}</button>`).join('');
  const sugerible = rango.lado === 'nuevo';
  const sugerido = c.tipo === 'nota'
    ? `<label><input type="checkbox" data-caja-sugerido ${c.conSugerido && sugerible ? 'checked' : ''} ${sugerible ? '' : 'disabled'}> Include suggested code</label>
       ${sugerible ? '' : ' <span class="muy-tenue">Suggested code only applies to new or unchanged lines</span>'}
       ${c.conSugerido && sugerible ? `<textarea id="cajaSugerido" class="mono" rows="${Math.min(14, rango.claves.length + 1)}" spellcheck="false" aria-label="Suggested code">${esc(c.sugerido ?? rango.texto)}</textarea>` : ''}`
    : '';
  return `<tr class="caja"><td class="n"></td><td class="n"></td><td><div class="caja-com" role="group" aria-label="Comment on ${rangoTexto(rango)}">
    <div class="caja-cab"><span class="mono muy-tenue">${rangoTexto(rango)}</span><div class="tabs-caja" role="group" aria-label="Comment type">${tabs}</div></div>
    ${c.respondeA ? `<div class="respondiendo">Continues the conversation from: “${esc(c.resumenRespondeA ?? '')}”</div>` : ''}
    <textarea id="cajaTexto" rows="3" placeholder="${TIPOS_COMENTARIO[c.tipo].ayuda}" aria-label="${TIPOS_COMENTARIO[c.tipo].ayuda}">${esc(c.texto)}</textarea>
    ${sugerido}
    <div class="caja-acciones">
      <button type="button" class="btn chico primario" data-accion="cajaAgregar">${c.editando ? 'Save changes' : c.tipo === 'nota' ? 'Save note' : 'Add to review'}</button>
      <button type="button" class="btn chico" data-accion="cajaCancelar">Cancel</button>
      <span class="muy-tenue">Ctrl + Enter</span>
    </div>
  </div></td></tr>`;
}

const hiloHtml = (c, nivel = 0) => `<tr class="hilo"><td class="n"></td><td class="n"></td><td>${hiloCuerpo(c, nivel)}</td></tr>`;

// What the AI opened while investigating: without this list you can’t tell whether a claim comes from the code or the diff.
function consultadoHtml(c) {
  const a = c.consultado?.archivos ?? [];
  const b = c.consultado?.busquedas ?? [];
  const bloq = c.bloqueadas ?? [];
  if (!c.investigado || (!a.length && !b.length && !bloq.length)) return '';
  const rango = (x) => (x.desde ? ` L${Number(x.desde)}${x.hasta ? `–${Number(x.hasta)}` : ''}` : '');
  const filas = [
    ...a.map((x) => `<li><span class="mono">${x.repo ? `${esc(x.repo)}: ` : ''}${esc(x.ruta)}${rango(x)}</span></li>`),
    ...b.map((x) => `<li>${esc(x.herramienta === 'Grep' ? 'Search' : 'Files')} <span class="mono">${esc(x.patron)}</span>${x.repo ? ` in ${esc(x.repo)}` : ''}</li>`),
    ...bloq.map((x) => `<li>Blocked by permissions: <span class="mono">${esc(x.herramienta)} ${esc(x.ruta)}</span></li>`),
  ];
  return `<details class="leido muy-tenue"><summary>Files read: ${a.length}${b.length ? ` · ${plural(b.length, 'search', 'searches')}` : ''}${bloq.length ? ` · ${plural(bloq.length, 'blocked attempt', 'blocked attempts')}` : ''}</summary><ul>${filas.join('')}</ul></details>`;
}

const valorarHtml = (c) => (API && c.estado === 'respondido'
  ? `<span class="valorar" role="group" aria-label="Was the answer helpful?">Helpful? <button type="button" class="btn-texto" data-com-valorar="${esc(c.id)}" data-util="si" aria-pressed="${c.valoracion === true}">Yes</button><button type="button" class="btn-texto" data-com-valorar="${esc(c.id)}" data-util="no" aria-pressed="${c.valoracion === false}">No</button></span> · `
  : '');

function respuestaHtml(c) {
  const larga = c.respuesta.length > 900 || c.respuesta.split('\n').length > 14;
  const abierta = estado.expandidas.has(c.id);
  const costo = c.desdeCache ? 'Saved answer, no cost' : `${esc(nombreModelo(c.modelo))}${c.costo ? ` · ${usd(c.costo)}${Number(c.lote) > 1 ? ` for the batch of ${Number(c.lote)}` : ''}` : ''}`;
  const investigar = API && c.tipo === 'pregunta' && !c.investigado && c.estado === 'respondido'
    ? `<button type="button" class="btn-texto${c.necesitaCodigo ? ' destacado' : ''}" data-com-investigar="${esc(c.id)}" title="AI searches and reads the code of the PR and the other repos (no secrets)">${icono('buscar')} Investigate in the code</button>` : '';
  return `<div class="hilo-respuesta">
    ${c.necesitaCodigo && !c.investigado ? '<p class="aviso-codigo">Answering with certainty requires checking the repository code.</p>' : ''}
    <div class="md${larga && !abierta ? ' plegada' : ''}">${md(c.respuesta)}</div>
    ${larga ? `<button type="button" class="btn-texto" data-ver-mas="${esc(c.id)}">${abierta ? 'Show less' : 'Show more'}</button>` : ''}
    ${c.leido?.length ? `<p class="leido muy-tenue">Checked in: ${c.leido.map((x) => `<span class="mono">${esc(x.repo)}${x.portal && x.portal !== x.repo ? ` (${esc(x.portal)})` : ''} ${esc(x.rama)}@${esc(String(x.sha ?? '').slice(0, 7))}</span>`).join(' · ')}</p>` : ''}
    ${consultadoHtml(c)}
    <div class="hilo-pie muy-tenue"><span>AI answer</span> · ${c.investigado ? `${icono('buscar')} Checked in the code · ` : ''}${costo}${valorarHtml(c)}<button type="button" class="btn-texto" data-com-repreguntar="${esc(c.id)}">Follow up</button>${investigar}</div></div>`;
}

// Orders a list of comments as a conversation: each follow-up below the question it replies to.
function enHilo(cs) {
  const ids = new Set(cs.map((c) => c.id));
  const hijos = new Map();
  for (const c of cs) if (c.respondeA && ids.has(c.respondeA)) hijos.set(c.respondeA, [...(hijos.get(c.respondeA) ?? []), c]);
  const salida = [];
  const poner = (c, n) => { salida.push([c, n]); for (const h of hijos.get(c.id) ?? []) poner(h, n + 1); };
  for (const c of cs) if (!(c.respondeA && ids.has(c.respondeA))) poner(c, 0);
  return salida;
}
const hilosDiv = (cs) => enHilo(cs).map(([c, n]) => hiloCuerpo(c, n)).join('');

// Minimal formatting for AI answers: code blocks, inline code, bold, lists and paragraphs.
function md(texto) {
  return String(texto ?? '').replace(/\r/g, '').split('```').map((b, i) => (i % 2
    ? `<pre class="md-codigo">${esc(b.replace(/^[a-zA-Z]*\n/, '').replace(/\n$/, ''))}</pre>`
    : mdTexto(b))).join('');
}
// Only http(s) links: esc() already removed the quotes, so the href cannot break out of the attribute.
const mdEnLinea = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
function mdTexto(t) {
  return t.split(/\n\s*\n/).map((par) => {
    const partes = [];
    let lista = null;
    const agregar = (tipo, valor) => {
      if (!lista || lista.tipo !== tipo) { lista = { tipo, items: [] }; partes.push(lista); }
      lista.items.push(valor);
    };
    for (const linea of par.split('\n')) {
      const item = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(linea);
      const titulo = /^\s*#{1,6}\s+(.*)$/.exec(linea);
      if (/^\s*\|/.test(linea)) {
        agregar('pre', linea);
      } else if (item) {
        agregar(item[1] ? 'ol' : 'ul', item[2]);
      } else if (titulo) {
        lista = null;
        partes.push({ tipo: 'h', items: [titulo[1]] });
      } else if (linea.trim()) {
        lista = null;
        partes.push(linea);
      }
    }
    return partes.map((x) => {
      if (typeof x === 'string') return `<p>${mdEnLinea(x)}</p>`;
      if (x.tipo === 'pre') return `<pre class="md-codigo">${esc(x.items.join('\n'))}</pre>`;
      if (x.tipo === 'h') return `<h4 class="md-titulo">${mdEnLinea(x.items[0])}</h4>`;
      return `<${x.tipo}>${x.items.map((i) => `<li>${mdEnLinea(i)}</li>`).join('')}</${x.tipo}>`;
    }).join('');
  }).join('');
}

// What the AI is doing while working on a comment, with elapsed time: a static dot looks like a frozen app.
const PROGRESO = {
  investigar: ['AI is searching and reading the code of the PR and the other repos', 'Usually takes 30 seconds to 2 minutes.'],
  pregunta: ['AI is writing the answer', 'Usually takes a few seconds.'],
  cambio: ['AI is applying the change to a copy and running the checks', 'Usually takes 1 to 3 minutes.'],
};
// Stages reported by the server (mcp/lib/avance.mjs). The fix-up stages only appear if the first check failed.
const PASOS = {
  investigar: [['copias', 'Prepare copies of the code'], ['leyendo', 'Read the code and write the answer']],
  cambio: [['editando', 'Apply the change to a copy'], ['comprobando', 'Run the checks'], ['corrigiendo', 'Fix what failed'], ['recomprobando', 'Check again']],
  explicar: [['preparando', 'Fetch the diff and description'], ['leyendo', 'Read the diff and related code'], ['completando', 'Read what was missed and extend the explanation']],
};
// Seconds after which a "taking longer than usual" notice is shown.
const LENTO = { investigar: 150, pregunta: 60, cambio: 240, explicar: 240 };

function avanceHtml(tipo, av, desde) {
  let pasos = PASOS[tipo] ?? [];
  if (!av?.corrigio) pasos = pasos.filter(([f]) => f !== 'corrigiendo' && f !== 'recomprobando');
  const actual = pasos.findIndex(([f]) => f === av?.fase);
  const lista = av && pasos.length > 1 ? `<ol class="etapas">${pasos.map(([, nombre], i) => {
    const clase = i < actual ? 'hecho' : i === actual ? 'actual' : '';
    return `<li class="${clase}"${i === actual ? ' aria-current="step"' : ''}>${icono(i < actual ? 'ok' : i === actual ? 'actualizar' : 'circulo', i === actual ? 'girando' : '')} ${nombre}</li>`;
  }).join('')}</ol>` : '';
  const cuentas = [
    av?.archivos ? plural(av.archivos, 'file read', 'files read') : '',
    av?.busquedas ? plural(av.busquedas, 'search', 'searches') : '',
    av?.ediciones ? plural(av.ediciones, 'edit', 'edits') : '',
  ].filter(Boolean).join(' · ');
  const leido = cuentas ? `<p class="muy-tenue avance-cuenta">${cuentas}${av.ultimo ? ` · last: <code>${esc(av.ultimo)}</code>` : ''}</p>` : '';
  const seg = desde ? (Date.now() - new Date(desde)) / 1000 : 0;
  const lento = seg > (LENTO[tipo] ?? 120)
    ? `<p class="aviso-lento">${icono('reloj')} Taking longer than usual, but still running. If it reaches 10 minutes it stops and is marked as an error.</p>` : '';
  return lista + leido + lento;
}

function progresoHtml(c) {
  if (c.estado === 'en_cola') return `<div class="hilo-progreso" aria-live="polite"><p class="trabajando">${icono('reloj')} Queued: starts when the current job finishes.</p></div>`;
  const tipo = c.investigar ? 'investigar' : c.tipo;
  const [texto, ayuda] = PROGRESO[tipo] ?? PROGRESO.pregunta;
  const desde = c.actualizado ?? c.creado;
  return `<div class="hilo-progreso" aria-live="polite"><p class="trabajando">${icono('actualizar', 'girando')}<span>${texto} · ${transcurrido(desde)}</span></p>
    <div class="progreso" aria-hidden="true"></div>${avanceHtml(tipo, estado.avances[`c:${c.id}`], desde)}<p class="muy-tenue">${ayuda} You can keep using the dashboard meanwhile.</p></div>`;
}

function hiloCuerpo(c, nivel = 0) {
  const revisando = c.investigar && (c.estado === 'en_cola' || c.estado === 'en_curso');
  const trabajando = c.estado === 'en_cola' || c.estado === 'en_curso';
  const [txt, cls] = revisando ? ['Checking the code', 'azul'] : ESTADOS_COMENTARIO[c.estado] ?? [c.estado, ''];
  const editable = (c.estado === 'borrador' || c.estado === 'nota') && !c.ambito;
  const donde = c.ambito === 'pr' ? (c.seccion ? esc(SECCIONES[c.seccion] ?? '') : 'Whole PR') : rangoTexto(c);
  return `<div class="hilo-com${nivel ? ' respuesta-a' : ''}" data-hilo="${esc(c.id)}" style="${nivel ? `margin-left:${Math.min(nivel, 3) * 18}px` : ''}">
    <div class="hilo-cab">${nivel ? '<span class="muy-tenue">Follow-up</span>' : ''}<strong>${TIPOS_COMENTARIO[c.tipo]?.etiqueta ?? esc(c.tipo)}</strong><span class="mono muy-tenue">${donde}</span><span class="punto-estado ${cls}${trabajando ? ' vivo' : ''}">${esc(txt)}</span>
      ${editable ? `<span class="der"><button type="button" class="btn-texto" data-com-editar="${esc(c.id)}">Edit</button><button type="button" class="btn-texto" data-com-borrar="${esc(c.id)}">Delete</button></span>` : ''}${c.ambito && c.estado === 'borrador' ? `<span class="der"><button type="button" class="btn-texto" data-com-borrar="${esc(c.id)}">Delete</button></span>` : ''}</div>
    ${c.citado ? `<blockquote class="cita"${c.citadoDe === 'respuesta' ? ' title="Fragment of the previous answer"' : ''}>${esc(c.citado)}</blockquote>` : ''}
    <div class="hilo-texto">${esc(c.texto)}</div>
    ${c.sugerido !== undefined ? `<pre class="sugerido" aria-label="Suggested code">${esc(c.sugerido)}</pre>` : ''}
    ${trabajando ? progresoHtml(c) : ''}
    ${c.respuesta ? (trabajando ? `<div class="anterior"><span class="etiqueta-anterior">Previous answer</span>${respuestaHtml(c)}</div>` : respuestaHtml(c)) : ''}
    ${c.propuestaId ? propuestaHtml(c) : ''}
    ${c.estado === 'error' && c.motivo ? `<div class="hilo-motivo">${esc(c.motivo)}${API && c.tipo !== 'nota' ? ` <button type="button" class="btn-texto" data-com-reintentar="${esc(c.id)}">Retry</button>` : ''}</div>` : ''}
  </div>`;
}

// AI change proposals, requested from the server on demand.
const propuestasPedidas = new Set();
function propuestaDe(c) {
  const prop = estado.propuestas.get(c.propuestaId);
  if (prop || !API || propuestasPedidas.has(c.propuestaId)) return prop;
  propuestasPedidas.add(c.propuestaId);
  api(`/api/propuesta?pr=${encodeURIComponent(estado.seleccion)}&id=${encodeURIComponent(c.propuestaId)}`)
    .then((x) => { estado.propuestas.set(x.id, x); repintarDetalle(); }, (e) => avisar(e.message))
    .finally(() => propuestasPedidas.delete(c.propuestaId));
  return null;
}

function diffPropuesta(prop) {
  return prop.patch.split(/^diff --git /m).slice(1).map((bloque) => {
    const archivo = /^\+\+\+ (?:b\/)?(.+)$/m.exec(bloque)?.[1] ?? bloque.split(' ')[0].replace(/^a\//, '');
    const inicio = bloque.indexOf('\n@@');
    const lineas = inicio >= 0 ? SekiAnclaje.lineasDePatch(bloque.slice(inicio + 1).replace(/\n$/, '')) : [];
    const filas = lineas.map((l) => (l.tipo === 'hunk'
      ? `<tr class="hunk"><td class="n"></td><td class="n"></td><td class="c">${esc(l.texto)}</td></tr>`
      : `<tr class="${l.tipo}"><td class="n">${l.viejo ?? ''}</td><td class="n">${l.nuevo ?? ''}</td><td class="c">${esc(l.texto)}</td></tr>`)).join('');
    const fuera = prop.fueraDelComentario.includes(archivo);
    return `<div class="prop-archivo"><div class="ruta"><span>${esc(archivo)}</span>${fuera ? '<span class="estado ambar">Outside the comment</span>' : ''}</div><div class="codigo-diff"><table>${filas}</table></div></div>`;
  }).join('');
}

function checksPropuesta(prop) {
  const c = prop.comprobaciones;
  const fila = (nombre, r, configurado = true) => {
    if (!configurado || !r) return check('circulo', '', nombre, 'Not checked', configurado ? 'No files to check' : 'Not configured for this repo');
    if (r.omitido) return check('alerta', 'ambar', nombre, 'Exceeded the time limit', '');
    if (r.ok) return check('ok', 'verde', nombre, 'No new failures', r.sinBaseline ? 'No baseline: not compared with the previous state' : '');
    return check('bloqueo', 'rojo', nombre, plural(r.nuevosFallos.length, 'new failure', 'new failures'), `${esc(r.nuevosFallos.slice(0, 6).join(' · '))}${r.sinBaseline ? ' · No baseline: may include pre-existing failures' : ''}`);
  };
  const reglas = c.reglas.bloqueantes
    ? check('bloqueo', 'rojo', 'Rules', plural(c.reglas.bloqueantes, 'blocking', 'blocking'), esc(c.reglas.hallazgos.filter((h) => h.severidad === 'bloqueante').map((h) => `${h.archivo}:${h.linea} ${h.titulo}`).join(' · ')))
    : c.reglas.resumen?.alto ? check('alerta', 'ambar', 'Rules', plural(c.reglas.resumen.alto, 'high finding', 'high findings'), esc(c.reglas.hallazgos.filter((h) => h.severidad === 'alto').map((h) => h.titulo).join(' · ')))
    : check('ok', 'verde', 'Rules', 'No findings', '');
  return `<div class="prop-checks">${reglas}${fila('Types', c.tipos, c.tipos !== null)}${fila('Tests', c.tests, c.tests !== null)}</div>
    ${(c.avisos ?? []).map((a) => `<p class="muy-tenue" style="margin:6px 0 0">${esc(a)}</p>`).join('')}`;
}

function propuestaHtml(c) {
  const prop = propuestaDe(c);
  if (!prop) return `<div class="propuesta tenue">${API ? 'Loading the proposal.' : 'The proposal is only visible with the dashboard opened from Claude Code.'}</div>`;
  const pr = prSel();
  const pie = `<span class="muy-tenue">${esc(nombreModelo(prop.modelo))}${prop.costo ? ` · ${usd(prop.costo)}` : ''}</span>`;
  let acciones = '';
  if (prop.estado === 'lista') {
    const confirmar = estado.confirmarAprobar === prop.id;
    acciones = `<div class="prop-acciones">
      <button type="button" class="btn chico primario" data-prop-aprobar="${esc(prop.id)}">${prop.conFallos ? (confirmar ? 'Confirm: approve with failures' : 'Approve with failures') : 'Approve and push to the branch'}</button>
      <button type="button" class="btn chico" data-prop-ajustar="${esc(prop.id)}" aria-expanded="${estado.ajustando === prop.id}">Request adjustment</button>
      <button type="button" class="btn chico" data-prop-descartar="${esc(prop.id)}">Discard</button>${pie}
    </div>
    ${confirmar ? '<p class="hilo-motivo">The proposal has failing checks. A second click pushes it to the branch anyway.</p>' : ''}
    ${estado.ajustando === prop.id ? `<div class="prop-ajuste"><textarea id="ajusteTexto" placeholder="What to change in this proposal" aria-label="What to change in this proposal"></textarea>
      <div class="prop-acciones"><button type="button" class="btn chico primario" data-prop-enviar-ajuste="${esc(prop.id)}">Send adjustment</button></div></div>` : ''}`;
  } else if (prop.estado === 'conflicto' || prop.estado === 'rechazada') {
    acciones = `<p class="hilo-motivo">${esc(prop.motivo ?? '')}</p><div class="prop-acciones">
      <button type="button" class="btn chico" data-prop-regenerar="${esc(prop.id)}" ${pr?.estadoPr === 'OPEN' ? '' : 'disabled title="The PR is no longer open"'}>Regenerate</button>
      ${prop.estado === 'rechazada' ? `<button type="button" class="btn chico" data-prop-copiar="${esc(prop.id)}">${icono('copiar')} Copy patch</button>` : ''}${pie}</div>`;
  } else if (prop.estado === 'aprobada') {
    acciones = `<div class="prop-acciones"><span class="punto-estado violeta">Pushed to the branch</span><a href="${esc(pr?.url ?? '')}/commits/${esc(prop.commit)}" target="_blank" rel="noopener" class="mono">${esc(prop.commit.slice(0, 7))} ${icono('externo')}</a>${pie}</div>`;
  }
  return `<div class="propuesta">
    <div class="prop-cab"><strong>Proposal</strong><span>${esc(prop.resumen)}</span></div>
    ${diffPropuesta(prop)}
    ${checksPropuesta(prop)}
    ${acciones}
  </div>`;
}

async function accionPropuesta(accion, id, extra = {}) {
  const pr = prSel();
  try {
    const r = await api(`/api/propuesta/${accion}`, { pr: pr.id, id, ...extra });
    estado.propuestas.delete(id);
    if (accion === 'aprobar' && !r.ok) {
      if (r.motivo === 'requiere_confirmacion') { estado.confirmarAprobar = id; return repintarDetalle(); }
      avisar(r.motivo);
    }
    if (accion === 'aprobar' && r.ok) avisar(`Change pushed to the branch (${r.commit.slice(0, 7)}).`);
    estado.confirmarAprobar = null;
    estado.ajustando = null;
    await sincronizarComentarios(pr);
    repintarDetalle();
  } catch (err) { avisar(err.message); }
  sondear();
}

function agregarComentario() {
  leerCaja();
  const pr = FOTO.prs.find((p) => p.id === estado.seleccion);
  const rango = rangoSeleccion();
  const c = estado.caja;
  if (!pr || !rango) return;
  if (!c.texto.trim()) { avisar('Write the comment before adding it.'); return $('cajaTexto')?.focus(); }
  const previo = c.editando ? comentarios(pr).find((x) => x.id === c.editando) : null;
  const conSugerido = c.tipo === 'nota' && c.conSugerido && rango.lado === 'nuevo';
  guardarComentario(pr, {
    ...(previo ?? { id: nuevoIdComentario(), creado: new Date().toISOString() }),
    tipo: c.tipo,
    estado: c.tipo === 'nota' ? 'nota' : 'borrador',
    archivo: estado.archivosTab[estado.seleccionLineas.archivo],
    lado: rango.lado, desde: rango.desde, hasta: rango.hasta, claves: rango.claves,
    textoOriginal: rango.texto,
    texto: c.texto.trim(),
    sugerido: conSugerido ? SekiAnclaje.textoSugerido(c.sugerido ?? rango.texto) : undefined,
    headSha: pr.headSha,
    respondeA: c.tipo === 'pregunta' && !previo ? c.respondeA : previo?.respondeA,
  });
  cerrarCaja(c.tipo);
}

function cerrarCaja(tipo) {
  document.querySelectorAll('.codigo-diff tr.caja').forEach((f) => f.remove());
  estado.seleccionLineas = null;
  estado.caja = cajaVacia(tipo ?? estado.caja.tipo);
  repintarDetalle();
  pintarCola();
}

function repintarDetalle() {
  const y = $('detalle').scrollTop;
  pintarDetalle();
  $('detalle').scrollTop = y;
}

function editarComentario(pr, id) {
  const c = comentarios(pr).find((x) => x.id === id);
  const k = estado.archivosTab.indexOf(c?.archivo);
  if (!c || k < 0) return;
  const claves = c.claves?.length ? c.claves : [`${c.lado === 'viejo' ? 'v' : 'n'}${c.desde}`, `${c.lado === 'viejo' ? 'v' : 'n'}${c.hasta}`];
  estado.seleccionLineas = { archivo: k, claveA: claves[0], claveB: claves[claves.length - 1] };
  estado.caja = { tipo: c.tipo, texto: c.texto, conSugerido: c.sugerido !== undefined, sugerido: c.sugerido ?? null, editando: c.id };
  marcarSeleccion();
}

// Rows of a unified patch with old and new line numbers; findings hang below their new line.
// k: index of the file in the tab, to locate the line selection.
function filasDiff(lineas, hallazgos, k, hilos = new Map()) {
  const filas = [];
  const porLinea = new Map();
  for (const h of hallazgos) {
    if (!porLinea.has(h.linea)) porLinea.set(h.linea, []);
    porLinea.get(h.linea).push(h);
  }
  const color = { bloqueante: 'rojo', alto: 'ambar', medio: '', aviso: '' };
  const sel = estado.seleccionLineas?.archivo === k ? clavesSeleccion() : new Set();
  const num = (n, clave) => (n === null ? '<td class="n"></td>' : `<td class="n"><button class="n-sel" data-sel="${clave}" aria-label="Select line ${n}">${n}</button></td>`);
  for (const l of lineas) {
    if (l.tipo === 'hunk') {
      filas.push(`<tr class="hunk"><td class="n"></td><td class="n"></td><td class="c">${esc(l.texto)}</td></tr>`);
      continue;
    }
    const clave = SekiAnclaje.claveLinea(l);
    filas.push(`<tr class="${l.tipo}${sel.has(clave) ? ' sel' : ''}" data-clave="${clave}">${num(l.viejo, clave)}${num(l.nuevo, clave)}<td class="c">${esc(l.texto)}</td></tr>`);
    if (l.tipo !== 'del' && porLinea.has(l.nuevo)) {
      for (const x of porLinea.get(l.nuevo)) {
        filas.push(`<tr class="nota"><td class="n"></td><td class="n"></td><td><span class="estado ${color[x.severidad]}">${esc(nivel(x.severidad))}</span> <strong>${esc(x.titulo)}</strong> · <span class="tenue">${esc(x.mensaje)}</span></td></tr>`);
      }
    }
    for (const [c, n] of enHilo(hilos.get(clave) ?? [])) filas.push(hiloHtml(c, n));
  }
  return filas.join('');
}

// Diff line selection: click marks a line, Shift + click extends the range within the same file.
function rangoSeleccion() {
  const s = estado.seleccionLineas;
  if (!s) return null;
  return SekiAnclaje.normalizarRango(estado.lineasArchivo[s.archivo] ?? [], s.claveA, s.claveB);
}

const clavesSeleccion = () => new Set(rangoSeleccion()?.claves ?? []);

function marcarSeleccion() {
  leerCaja();
  document.querySelectorAll('.codigo-diff tr.sel').forEach((f) => f.classList.remove('sel'));
  document.querySelectorAll('.codigo-diff tr.caja').forEach((f) => f.remove());
  const s = estado.seleccionLineas;
  const rango = rangoSeleccion();
  if (!s || !rango) return;
  const tabla = document.querySelector(`#${idArchivo(s.archivo)} .codigo-diff`);
  if (!tabla) return;
  tabla.closest('.archivo').removeAttribute('data-plegado');
  let ultima = null;
  for (const clave of rango.claves) {
    const fila = tabla.querySelector(`tr[data-clave="${clave}"]`);
    fila?.classList.add('sel');
    ultima = fila ?? ultima;
  }
  ultima?.insertAdjacentHTML('afterend', cajaHtml(rango));
  const t = $('cajaTexto');
  if (t && document.activeElement?.id !== 'cajaSugerido') { t.focus({ preventScroll: true }); t.setSelectionRange(t.value.length, t.value.length); }
}

function seleccionarLinea(boton, extender) {
  const k = +boton.closest('.archivo').dataset.k;
  const clave = boton.dataset.sel;
  const previa = estado.seleccionLineas;
  const extiende = extender && previa?.archivo === k;
  if (!extiende && !estado.caja.editando) { leerCaja(); estado.caja = { ...cajaVacia(estado.caja.tipo), texto: estado.caja.texto }; }
  estado.seleccionLineas = extiende ? { ...previa, claveB: clave } : { archivo: k, claveA: clave, claveB: clave };
  marcarSeleccion();
}

