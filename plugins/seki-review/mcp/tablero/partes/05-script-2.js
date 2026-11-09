function tabResumen(pr) {
  const e = pr.explicacion;
  if (!e) {
    const tr = trabajo(pr);
    if (API && tr?.estado === 'en_curso') return `<div class="seccion" aria-live="polite"><p class="trabajando">${icono('actualizar', 'girando')}<span>AI is reading the diff and related code · ${transcurrido(tr.inicio)}</span></p>
      <div class="progreso" aria-hidden="true"></div>${avanceHtml('explicar', estado.avances[`pr:${pr.id}`], tr.inicio)}
      <div class="esqueleto" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div></div>`;
    if (API && tr?.estado === 'en_cola') return `<div class="seccion"><p class="trabajando">${icono('reloj')} Queued: starts when the current analysis finishes.</p></div>`;
    if (API) return `<div class="seccion"><p class="tenue">This PR doesn’t have an explanation yet.</p>
      <p style="margin-top:12px"><button class="btn chico" data-accion="analizar" ${trabajoActivo(pr) ? 'disabled' : ''}>${trabajoActivo(pr) ? `${icono('actualizar', 'girando')} Analyzing` : `${icono('chispa')} Analyze with AI`}</button></p></div>`;
    return `<div class="seccion"><p class="tenue">This PR doesn’t have an explanation yet. It is generated from Claude Code and appears here when the dashboard is regenerated.</p>
      <p style="margin-top:12px"><button class="btn chico" data-copiar="/seki-review:review-prs explain ${esc(pr.repo)}#${pr.numero}">${icono('copiar')} Copy the command</button></p></div>`;
  }
  return `
    <p class="origen">${icono('chispa')} <span><strong>AI explanation.</strong> A reading aid for the PR; it does not replace reviewing the diff. The fixed rules are under Checks.</span></p>
    ${e.desactualizada ? `<div class="seccion"><span class="estado ambar">${icono('alerta')} The PR received commits after this explanation</span></div>` : ''}
    ${coberturaHtml(e, pr)}
    ${sec('What it solves', `<p>${esc(e.resumen)}</p>`, 'resumen')}
    ${sec('Why', `<p>${esc(e.por_que)}</p>`, 'por_que')}
    ${e.impacto_usuario ? sec('What users notice', `<p>${esc(e.impacto_usuario)}</p>`, 'impacto_usuario') : ''}
    ${sec('What changes', lista(e.que_cambia), 'que_cambia')}
    ${e.orden_lectura?.length ? sec('Reading order', `<ol class="lectura">${e.orden_lectura.map((o) => `<li><span class="mono">${esc(o.archivo)}</span><br><span class="tenue">${esc(o.motivo)}</span></li>`).join('')}</ol>`, 'orden_lectura') : ''}
    ${e.diagrama ? sec('Flow', `<pre class="mermaid">${esc(e.diagrama.replace(/#(?!\d+;)/g, '#35;'))}</pre>`, 'diagrama') : ''}
    ${e.tecnologias?.length ? sec('Technologies', `<div class="tabla"><table><thead><tr><th>Technology</th><th>Use in this change</th><th>Why this one</th><th>Ruled out</th></tr></thead><tbody>
      ${e.tecnologias.map((t) => `<tr><td><strong>${esc(t.nombre)}</strong></td><td>${esc(t.uso)}</td><td>${esc(t.por_que)}</td><td class="tenue">${esc((t.alternativas_descartadas ?? []).join(' '))}</td></tr>`).join('')}
      </tbody></table></div>`, 'tecnologias') : ''}
    ${e.alternativas?.length ? sec('Alternatives considered', lista(e.alternativas), 'alternativas') : ''}
    ${e.dependencias?.length ? sec('Must go first', lista(e.dependencias), 'dependencias') : ''}
    ${e.riesgos?.length ? sec('Risks', lista(e.riesgos), 'riesgos') : ''}
    ${barraPendiente(pr)}
    ${preguntaPrHtml(pr)}
    <p class="nota-pie">Explanation from ${esc(e.fecha?.slice(0, 10))} on commit <span class="mono">${esc(e.headSha?.slice(0, 7))}</span>${e.riesgo ? ` · ${esc(nivel(e.riesgo))} risk` : ''}${e.esfuerzo ? ` · effort ${e.esfuerzo} of 5` : ''}.${API ? ` <button type="button" class="btn-texto" data-accion="analizar" ${trabajoActivo(pr) ? 'disabled' : ''}>Analyze again with AI</button>` : ''}</p>`;
}

function tabVerificaciones(pr) {
  const v = pr.verificaciones;
  if (!v) return '<p class="sin-dato">No checks for this PR.</p>';
  if (!v.hallazgos.length) return '<p class="tenue">The added lines pass all rules.</p>';
  const color = { bloqueante: 'rojo', alto: 'ambar', medio: '', aviso: '' };
  return `<div class="tabla"><table><thead><tr><th>Severity</th><th>Finding</th><th>Where</th></tr></thead><tbody>
    ${v.hallazgos.map((h) => `<tr>
      <td><span class="estado ${color[h.severidad]}">${esc(nivel(h.severidad))}</span></td>
      <td><strong>${esc(h.titulo)}</strong><br><span class="tenue">${esc(h.mensaje)}</span><br><span class="muy-tenue">${esc(h.origen)}</span></td>
      <td><a class="mono" href="${esc(pr.url)}/files" target="_blank" rel="noopener">${esc(h.archivo)}${h.linea ? ':' + h.linea : ''}</a>${h.texto ? `<code class="codigo">${esc(h.texto)}</code>` : ''}</td>
    </tr>`).join('')}
  </tbody></table></div>
  <p class="nota-pie">Fixed rules over the added lines, no AI: they flag patterns, they don’t confirm there is a problem. A line is excluded from a rule with the comment <span class="mono">seki-review: ignore &lt;rule&gt;</span>.</p>`;
}

function tabDescripcion(pr) {
  const texto = (pr.descripcion ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
  let cuerpo = `<div class="md-desc lectura">${md(texto)}</div>`;
  if (pr.descripcion === undefined) cuerpo = '<p class="sin-dato">This data doesn’t include the description. Use “Refresh status”.</p>';
  else if (!texto) cuerpo = `<p class="sin-dato">The PR has no description.${pr.seguridad ? ' This is a security PR: ask the author what changes, why, and in what order it is deployed.' : ''}</p>`;
  const commits = pr.commits ?? [];
  const lista = commits.length
    ? `<ol class="commits">${commits.map((c) => `<li>
        <a class="mono" href="${esc(pr.url)}/commits/${esc(c.sha)}" target="_blank" rel="noopener">${esc(c.sha.slice(0, 7))}</a>
        ${esc(c.titulo)}
        <span class="muy-tenue">${esc(c.autor ?? '')}${c.fecha ? ` · ${esc(new Date(c.fecha).toLocaleString('en-US'))}` : ''}</span>
        ${c.cuerpo ? `<details><summary class="muy-tenue">Full message</summary><div class="tenue">${md(c.cuerpo)}</div></details>` : ''}
      </li>`).join('')}</ol>`
    : '<p class="sin-dato">No commits in this data.</p>';
  return `${sec('Author’s description', cuerpo)}${sec('Commits', lista)}`;
}

function tabProbar(pr) {
  const pasos = pr.explicacion?.como_probar ?? [];
  if (!pasos.length) return '<p class="sin-dato">The explanation has no test steps.</p>';
  const marcados = almacen.leer(clavePasos(pr), []);
  return `<ul class="pasos">${pasos.map((p, i) => `<li><input type="checkbox" id="paso${i}" data-paso="${i}" ${marcados.includes(i) ? 'checked' : ''}><label for="paso${i}">${esc(p)}</label></li>`).join('')}</ul>
    <p class="nota-pie">${marcados.length} of ${plural(pasos.length, 'step checked', 'steps checked')}. Saved in this browser and included in the exported review.</p>`;
}

function tabRevision(pr) {
  const r = revision(pr) ?? {};
  if (API) precargarPlantillas(pr);
  return `${sec('Decision', `<div class="decision" role="radiogroup">${Object.entries(DECISIONES).map(([k, [t]]) => `<label><input type="radio" name="decision" value="${k}" ${r.decision === k ? 'checked' : ''}> ${t}</label>`).join('')}</div>`)}
    ${sec('Feedback for the author', `<textarea id="notaRevision" placeholder="What’s missing, what was tested, what needs clarifying">${esc(r.nota ?? '')}</textarea>
      <div class="guardado" id="guardado">${r.fecha ? `Saved ${esc(new Date(r.fecha).toLocaleString('en-US'))}` : ''}</div>`)}
    <p class="tenue">The review stays in this browser. To send it to the author:</p>
    <div class="acciones"><button class="btn" data-accion="exportar">${icono('descargar')} Export review</button><button class="btn" data-accion="copiarResumen">${icono('copiar')} Copy summary</button><button class="btn" data-copiar-revision title="Decision, comments on the diff, notes and the comments of a current template review as Markdown, to paste on GitHub">${icono('copiar')} Copy review</button></div>`;
}

const ESTADO_ARCHIVO = { added: 'Added', removed: 'Removed', modified: 'Modified', renamed: 'Renamed', copied: 'Copied', changed: 'Changed' };
const claveVistos = (pr) => `seki-review:vistos:${pr.id}:${pr.headSha}`;
const idArchivo = (i) => `archivo-${i}`;

function barrita(a, d) {
  const total = a + d;
  if (!total) return '';
  const verdes = Math.round((a / total) * 5);
  return `<span class="barrita" aria-hidden="true">${[0, 1, 2, 3, 4].map((i) => `<i class="${i < verdes ? 'a' : 'd'}"></i>`).join('')}</span>`;
}

// Comments on diff lines. Questions and change requests start as drafts and are sent
// together; manual notes are saved when added and travel in the exported review.
const TIPOS_COMENTARIO = {
  pregunta: { nombre: 'Ask', etiqueta: 'Question', ayuda: 'What you want to understand about these lines. “What happens if…?” beats “Is this OK?”' },
  cambio: { nombre: 'Request change', etiqueta: 'Change request', ayuda: 'How this code should end up' },
  nota: { nombre: 'Note', etiqueta: 'Note', ayuda: 'Comment for the author' },
};
const ESTADOS_COMENTARIO = {
  borrador: ['Draft', ''], nota: ['Note saved', ''], en_cola: ['Queued', 'azul'], en_curso: ['In progress', 'azul'],
  respondido: ['Answered', 'verde'], propuesta: ['Proposal ready', 'ambar'], aprobado: ['Approved', 'violeta'],
  descartado: ['Discarded', ''], error: ['Error', 'rojo'],
};
const claveComentarios = (pr) => `seki-review:comentarios:${pr.id}`;
const comentarios = (pr) => almacen.leer(claveComentarios(pr), []);
const vivos = (pr) => comentarios(pr).filter((c) => c.estado !== 'descartado');
const deLineas = (pr) => vivos(pr).filter((c) => !c.ambito);
const dePr = (pr, seccion) => vivos(pr).filter((c) => c.ambito === 'pr' && (c.seccion ?? null) === (seccion ?? null));
// Display labels for values the server stores in Spanish.
const NIVELES = { bloqueante: 'blocking', alto: 'high', medio: 'medium', aviso: 'notice', bajo: 'low' };
const nivel = (v) => NIVELES[v] ?? v;

const SECCIONES = {
  resumen: 'What it solves', por_que: 'Why', impacto_usuario: 'What users notice', que_cambia: 'What changes',
  orden_lectura: 'Reading order', diagrama: 'Flow', tecnologias: 'Technologies', alternativas: 'Alternatives considered',
  dependencias: 'Must go first', riesgos: 'Risks', como_probar: 'How to test',
};

// Questions about the PR or a section of the explanation: sent right away, without going through "Pending review".
// A second click on the same option removes the rating.
async function valorar(pr, id, util) {
  const c = comentarios(pr).find((x) => x.id === id);
  const valor = c?.valoracion === util ? null : util;
  try {
    await api('/api/valorar', { id: pr.id, comentario: id, util: valor });
    escribirComentarios(pr, comentarios(pr).map((x) => (x.id === id ? { ...x, valoracion: valor ?? undefined } : x)));
    repintarDetalle();
  } catch (err) { avisar(err.message); }
}

async function investigar(pr, id) {
  try {
    await api('/api/investigar', { id: pr.id, comentario: id });
    escribirComentarios(pr, comentarios(pr).map((c) => (c.id === id ? { ...c, estado: 'en_cola', investigar: true } : c)));
    repintarDetalle();
  } catch (err) { avisar(err.message); }
  sondear();
}

async function preguntarPr(pr, seccion, textoFijo, { citado, enviar = true, investigar } = {}) {
  const caja = $('preguntaPr');
  const texto = (textoFijo ?? caja?.value ?? '').trim();
  if (!texto) { avisar('Write the question before sending it.'); return caja?.focus(); }
  const sobre = seccion ?? ($('preguntaPrSeccion')?.value || undefined);
  const respondeA = !textoFijo && estado.respondeA?.ambito === 'pr' ? estado.respondeA.id : undefined;
  const conCodigo = investigar ?? (!textoFijo && !!$('preguntaPrCodigo')?.checked);
  const c = { id: nuevoIdComentario(), creado: new Date().toISOString(), tipo: 'pregunta', estado: 'borrador', ambito: 'pr', seccion: sobre, citado: citado || undefined, respondeA, investigar: conCodigo || undefined, texto, headSha: pr.headSha };
  guardarComentario(pr, c);
  if (respondeA) estado.respondeA = null;
  if (caja && !textoFijo) caja.value = '';
  if (enviar) await enviarRevision(pr, [c.id]);
  else { repintarDetalle(); pintarCola(); }
}

// Text selection in the Summary: floating bar to ask about the fragment (as in Plannotator).
const RAPIDAS = [
  ['Why?', 'Why was it done this way and not another?'],
  ['Give an example', 'Give a concrete example taken from the diff.'],
  ['Expand', 'Expand this point with more detail and examples from the diff.'],
];
const RAPIDAS_RESPUESTA = [
  ['Why?', 'What is this part based on? Point to the file and lines.'],
  ['Give an example', 'Give a concrete example of this part taken from the diff.'],
  ['Expand', 'Expand this part with more detail.'],
];
let seleccionResumen = null;

function cerrarBarraSel() {
  $('barraSel')?.remove();
  seleccionResumen = null;
}

// Text selected with the mouse inside the diff: mapped to the rows it touches so those lines can be commented on.
function lineasDeSeleccion(rango) {
  const fila = (n) => (n.nodeType === 1 ? n : n.parentElement)?.closest('tr[data-clave]');
  const a = fila(rango.startContainer);
  const b = fila(rango.endContainer);
  const archivo = a?.closest('.archivo');
  if (!a || !b || !archivo || archivo !== b.closest('.archivo') || a.closest('tr.hilo, tr.caja')) return null;
  return { archivo: +archivo.dataset.k, claveA: a.dataset.clave, claveB: b.dataset.clave };
}

function abrirCajaDeSeleccion(tipo) {
  const s = seleccionResumen?.lineas;
  cerrarBarraSel();
  if (!s) return;
  window.getSelection()?.removeAllRanges();
  leerCaja();
  estado.caja = { ...cajaVacia(tipo), texto: '' };
  estado.seleccionLineas = s;
  marcarSeleccion();
}

function colocarBarra(barra, caja) {
  document.body.append(barra);
  const ancho = Math.min(420, window.innerWidth - 24);
  barra.style.width = `${ancho}px`;
  barra.style.left = `${Math.max(12, Math.min(caja.left, window.innerWidth - ancho - 12))}px`;
  const abajo = caja.bottom + 8;
  barra.style.top = `${abajo + 170 > window.innerHeight ? Math.max(12, caja.top - 8 - barra.offsetHeight) : abajo}px`;
}

function abrirBarraSel() {
  const sel = window.getSelection();
  const texto = sel?.toString().replace(/\s+/g, ' ').trim();
  if (!texto || sel.rangeCount === 0) return;
  if (API && barraEnRespuesta(sel, texto)) return;
  if (estado.tab === 'archivos') {
    const lineas = lineasDeSeleccion(sel.getRangeAt(0));
    if (!lineas) return;
    seleccionResumen = { lineas, tab: 'archivos' };
    $('barraSel')?.remove();
    const barra = document.createElement('div');
    barra.id = 'barraSel';
    barra.className = 'barra-sel';
    barra.setAttribute('role', 'dialog');
    barra.setAttribute('aria-label', 'Comment on the selected lines');
    barra.innerHTML = `<div class="barra-sel-botones">
      ${API ? `<button type="button" class="btn chico primario" data-bsel-lineas="pregunta">${icono('chispa')} Ask</button>` : ''}
      ${API && prSel()?.estadoPr === 'OPEN' ? '<button type="button" class="btn chico" data-bsel-lineas="cambio">Request change</button>' : ''}
      <button type="button" class="btn chico${API ? '' : ' primario'}" data-bsel-lineas="nota">Note</button>
      <button type="button" class="btn-texto" data-bsel="cerrar" aria-label="Close">Esc</button></div>`;
    colocarBarra(barra, sel.getRangeAt(0).getBoundingClientRect());
    barra.style.width = 'auto';
    return;
  }
  if (!API || estado.tab !== 'resumen') return;
  const rango = sel.getRangeAt(0);
  const nodo = rango.commonAncestorContainer.nodeType === 1 ? rango.commonAncestorContainer : rango.commonAncestorContainer.parentElement;
  const seccion = nodo?.closest('[data-seccion]');
  if (!seccion || nodo.closest('.hilos-pr, textarea, button')) return;
  seleccionResumen = { seccion: seccion.dataset.seccion, citado: texto.slice(0, 2000), tab: 'resumen' };
  ponerBarraPregunta(rango.getBoundingClientRect(), 'Ask about the selected text', 'Question or comment about this fragment');
}

// Text selected in the AI answer of a thread (Summary or Files): a follow-up is asked in that thread about that part.
function barraEnRespuesta(sel, texto) {
  const rango = sel.getRangeAt(0);
  const nodo = rango.commonAncestorContainer.nodeType === 1 ? rango.commonAncestorContainer : rango.commonAncestorContainer.parentElement;
  const md = nodo?.closest('.hilo-respuesta .md');
  const hilo = md?.closest('[data-hilo]');
  const c = hilo && comentarios(prSel() ?? {}).find((x) => x.id === hilo.dataset.hilo);
  if (!c?.respuesta || c.estado === 'en_cola' || c.estado === 'en_curso') return false;
  seleccionResumen = { hilo: c.id, citado: texto.slice(0, 2000), tab: estado.tab };
  ponerBarraPregunta(rango.getBoundingClientRect(), 'Follow up on this part of the answer', 'What do you want to know about this part of the answer');
  return true;
}

function ponerBarraPregunta(caja, etiqueta, ayuda) {
  $('barraSel')?.remove();
  const barra = document.createElement('div');
  barra.id = 'barraSel';
  barra.className = 'barra-sel';
  barra.setAttribute('role', 'dialog');
  barra.setAttribute('aria-label', etiqueta);
  barra.innerHTML = `<div class="barra-sel-botones">
      <button type="button" class="btn chico primario" data-bsel="preguntar">${icono('chispa')} Ask</button>
      ${(seleccionResumen.hilo ? RAPIDAS_RESPUESTA : RAPIDAS).map(([e], i) => `<button type="button" class="btn chico" data-bsel-rapida="${i}">${esc(e)}</button>`).join('')}
      <button type="button" class="btn-texto" data-bsel="cerrar" aria-label="Close">Esc</button>
    </div>
    <div class="barra-sel-caja" hidden>
      <blockquote class="cita">${esc(seleccionResumen.citado.length > 180 ? `${seleccionResumen.citado.slice(0, 180)}…` : seleccionResumen.citado)}</blockquote>
      <textarea id="barraSelTexto" rows="3" placeholder="${esc(ayuda)}" aria-label="${esc(ayuda)}"></textarea>
      <label class="muy-tenue" style="display:block;margin-bottom:6px"><input type="checkbox" id="barraSelCodigo"> Check the repository code</label>
      <div class="prop-acciones"><button type="button" class="btn chico primario" data-bsel="enviar">Send now</button><button type="button" class="btn chico" data-bsel="agregar">Add to review</button><span class="muy-tenue">Ctrl + Enter adds</span></div>
    </div>`;
  colocarBarra(barra, caja);
}

function accionBarraSel(accion, rapida) {
  const pr = prSel();
  const s = seleccionResumen;
  if (!pr || !s) return cerrarBarraSel();
  const preguntar = (texto, opciones) => (s.hilo ? preguntarSobreRespuesta(pr, s.hilo, texto, opciones) : preguntarPr(pr, s.seccion, texto, opciones));
  if (rapida !== undefined) { cerrarBarraSel(); return preguntar((s.hilo ? RAPIDAS_RESPUESTA : RAPIDAS)[rapida][1], { citado: s.citado, enviar: false }); }
  if (accion === 'cerrar') return cerrarBarraSel();
  if (accion === 'preguntar') { $('barraSel').querySelector('.barra-sel-caja').hidden = false; return $('barraSelTexto').focus(); }
  const texto = $('barraSelTexto')?.value.trim();
  if (!texto) { avisar('Write the question before adding it.'); return $('barraSelTexto')?.focus(); }
  const investigar = !!$('barraSelCodigo')?.checked;
  cerrarBarraSel();
  window.getSelection()?.removeAllRanges();
  return preguntar(texto, { citado: s.citado, enviar: accion === 'enviar', investigar });
}

// The follow-up inherits where the thread lives (PR section or diff lines) so it hangs off it.
async function preguntarSobreRespuesta(pr, padreId, texto, { citado, enviar, investigar }) {
  const padre = comentarios(pr).find((x) => x.id === padreId);
  if (!padre) return;
  const lugar = padre.ambito === 'pr'
    ? { ambito: 'pr', seccion: padre.seccion }
    : { archivo: padre.archivo, lado: padre.lado, desde: padre.desde, hasta: padre.hasta, claves: padre.claves, textoOriginal: padre.textoOriginal };
  const c = { id: nuevoIdComentario(), creado: new Date().toISOString(), tipo: 'pregunta', estado: 'borrador', ...lugar, citado, citadoDe: 'respuesta', respondeA: padre.id, investigar: investigar || undefined, texto, headSha: pr.headSha };
  guardarComentario(pr, c);
  if (enviar) await enviarRevision(pr, [c.id]);
  else { repintarDetalle(); pintarCola(); }
}

// Highlights in the explanation the fragments quoted by questions (CSS Highlight API; without it nothing is highlighted).
function resaltarCitas(pr) {
  if (!globalThis.CSS?.highlights || !globalThis.Highlight) return;
  const rangos = [];
  for (const c of vivos(pr).filter((x) => x.citado && (x.ambito === 'pr' || x.citadoDe === 'respuesta'))) {
    const el = c.citadoDe === 'respuesta'
      ? document.querySelector(`[data-hilo="${CSS.escape(c.respondeA)}"] > .hilo-respuesta .md, [data-hilo="${CSS.escape(c.respondeA)}"] > .anterior .md`)
      : document.querySelector(`[data-seccion="${c.seccion}"]`);
    const rg = el && rangoDeTexto(el, c.citado);
    if (rg) rangos.push(rg);
  }
  CSS.highlights.set('seki-citado', new Highlight(...rangos));
}

function rangoDeTexto(el, buscado) {
  const nodos = [];
  const andar = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => {
    const fuera = n.parentElement.closest('.hilos-pr, h3');
    return fuera && el.contains(fuera) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
  } });
  let texto = '';
  const mapa = [];
  for (let n = andar.nextNode(); n; n = andar.nextNode()) {
    for (let i = 0; i < n.data.length; i++) {
      const ch = /\s/.test(n.data[i]) ? ' ' : n.data[i];
      if (ch === ' ' && texto.endsWith(' ')) continue;
      texto += ch;
      mapa.push([n, i]);
    }
    nodos.push(n);
  }
  const ini = texto.indexOf(buscado);
  if (ini < 0) return null;
  const [na, ia] = mapa[ini];
  const [nb, ib] = mapa[ini + buscado.length - 1];
  const rg = document.createRange();
  rg.setStart(na, ia);
  rg.setEnd(nb, ib + 1);
  return rg;
}
const borradores = (pr) => comentarios(pr).filter((c) => c.estado === 'borrador');
// The server does not send comments made on another commit; editing them anchors them to the current commit.
const deOtroCommit = (pr, c) => !!c.headSha && c.headSha !== pr.headSha;
const nuevoIdComentario = () => `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const rangoTexto = (c) => esc(c.desde === c.hasta ? `L${c.desde}` : `L${c.desde}–${c.hasta}`);
const cajaVacia = (tipo) => ({ tipo: tipo ?? (API ? 'pregunta' : 'nota'), texto: '', conSugerido: false, sugerido: null, editando: null });

function escribirComentarios(pr, lista) {
  if (!almacen.escribir(claveComentarios(pr), lista)) avisar('Could not save: the browser is blocking local storage.');
}

function guardarComentario(pr, c) {
  const nuevo = { ...c, actualizado: new Date().toISOString() };
  escribirComentarios(pr, [...comentarios(pr).filter((x) => x.id !== c.id), nuevo]);
  sincronizarComentarios(pr, [nuevo]);
}

function borrarComentarios(pr, ids) {
  escribirComentarios(pr, comentarios(pr).filter((x) => !ids.includes(x.id)));
  sincronizarComentarios(pr, [], ids);
}

// Merges comments by id; the most recently updated wins, unless the server already moved it out
// of draft or note: that is not reverted from the browser.
const DEL_NAVEGADOR = new Set(['borrador', 'nota']);
function fusionarComentarios(actuales, entrantes) {
  const porId = new Map(actuales.map((c) => [c.id, c]));
  for (const c of entrantes) {
    const previo = porId.get(c.id);
    if (previo && !DEL_NAVEGADOR.has(previo.estado) && DEL_NAVEGADOR.has(c.estado)) continue;
    if (!previo || (c.actualizado ?? '') > (previo.actualizado ?? '')) porId.set(c.id, c);
  }
  return [...porId.values()];
}

// With the served dashboard, comments also live on disk: they are not lost and the AI reads them.
async function sincronizarComentarios(pr, cambios = [], borrados = []) {
  if (!API) return;
  try {
    let delServidor = cambios.length || borrados.length
      ? await api('/api/comentarios', { id: pr.id, comentarios: cambios, borrados })
      : await api(`/api/comentarios?id=${encodeURIComponent(pr.id)}`);
    // Drafts and notes that only exist in this browser (no server when created, or imported) are uploaded.
    const enServidor = new Set(delServidor.map((c) => c.id));
    const faltan = comentarios(pr).filter((c) => DEL_NAVEGADOR.has(c.estado) && !enServidor.has(c.id) && !borrados.includes(c.id));
    if (faltan.length) delServidor = await api('/api/comentarios', { id: pr.id, comentarios: faltan });
    const antes = JSON.stringify(comentarios(pr));
    escribirComentarios(pr, fusionarComentarios(comentarios(pr).filter((c) => !borrados.includes(c.id)), delServidor));
    estado.comentariosCargados.add(pr.id);
    if (JSON.stringify(comentarios(pr)) !== antes && estado.seleccion === pr.id && !$('detalle').contains(document.activeElement)) { repintarDetalle(); pintarCola(); }
  } catch (err) { avisar(`The comments were saved only in this browser: ${err.message}`); }
}

