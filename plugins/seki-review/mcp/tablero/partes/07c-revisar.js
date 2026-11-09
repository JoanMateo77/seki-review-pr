
// To review: PRs requested from the owner or added by link, the "Review a PR" field and the Markdown copy of a review.
// Evaluated before 08-script-5.js, which ends with the first paint.
const GRUPOS_PARA_REVISAR = {
  necesita: ['Needs my review', 'No decision yet, or with questions'],
  espera_autor: ['Waiting on the author', 'Changes were requested'],
  aprobada: ['Approved by me', 'Approved or verified in testing'],
};
const ORIGEN_PARA_REVISAR = { solicitada: 'Requested', enlace: 'Added by link' };
const ID_PR = /^[\w.-]+#\d+$/;

function grupoParaRevisar(decision) {
  return decision === 'cambios' ? 'espera_autor' : decision === 'aprobada' || decision === 'probada' ? 'aprobada' : 'necesita';
}

function agruparParaRevisar(prs) {
  const grupos = { necesita: [], espera_autor: [], aprobada: [] };
  for (const pr of prs) grupos[grupoParaRevisar(revision(pr)?.decision)].push(pr);
  return grupos;
}

// The remove action sits beside the row, not inside it: a button cannot hold a button. It also appears on the owner's own
// PRs that are listed.
function conQuitarRevisar(pr, filaHtml) {
  if (!pr.paraRevisar || !API) return filaHtml;
  return `<div class="fila-revisar">${filaHtml}<button type="button" class="btn-texto quitar-revisar" data-quitar-revisar="${esc(pr.id)}" title="Only removes it from this list; nothing changes on GitHub">Remove from To review</button></div>`;
}

function filaParaRevisar(pr) {
  const origen = ORIGEN_PARA_REVISAR[pr.paraRevisar] ?? '';
  return conQuitarRevisar(pr, `<button class="fila" data-id="${esc(pr.id)}" aria-current="${estado.seleccion === pr.id}">
      <span class="punto ${tono(pr)}"></span>
      <span class="id mono">${esc(pr.repoEtiqueta)} #${pr.numero}</span>
      <span class="titulo" title="${esc(pr.titulo)}">${esc(pr.titulo)}</span>
      <span class="senales"><span class="etiqueta-revisar">${esc(origen)}</span>${pr.autor ? `<span class="autor-revisar" title="Author">@${esc(pr.autor)}</span>` : ''}${senales(pr)}</span>
    </button>`);
}

// Empty when nothing is listed: users with no requested PRs see no change.
function seccionParaRevisar(prs) {
  if (!prs.length) return '';
  const grupos = agruparParaRevisar(prs);
  const orden = (a, b) => a.repo.localeCompare(b.repo) || b.numero - a.numero;
  return `<div class="para-revisar"><h2 class="titulo-revisar">To review<span class="n">${prs.length}</span></h2>${Object.keys(GRUPOS_PARA_REVISAR).filter((g) => grupos[g].length).map((g) => {
    const [nombre, desc] = GRUPOS_PARA_REVISAR[g];
    const clave = `revisar_${g}`;
    const cerrado = estado.cerrados.has(clave);
    return `<section class="grupo" ${cerrado ? 'data-cerrado' : ''}>
      <button class="grupo-cab" data-grupo-toggle="${clave}" aria-expanded="${!cerrado}">${icono('chevron')}<span>${esc(nombre)}</span><span class="n">${grupos[g].length}</span><span class="desc">${esc(desc)}</span></button>
      <div class="filas">${grupos[g].sort(orden).map(filaParaRevisar).join('')}</div>
    </section>`;
  }).join('')}</div>`;
}

const rangoRevision = (c) => (c.desde ? `:L${Number(c.desde)}${c.hasta && Number(c.hasta) !== Number(c.desde) ? `–${Number(c.hasta)}` : ''}` : '');

// A template result counts only for the PR's current commit: an outdated one never reaches the copied review.
const plantillasVigentes = (pr, r) => !!r && !r.desactualizada && (!pr?.headSha || r.headSha === pr.headSha);

// Plain Markdown to paste on GitHub: decision, the owner's comments on the diff, then the general notes. No escaping.
// The comments of a current template review follow after a rule.
function revisionMarkdown(pr, revisionPr, comentariosPr, plantillasPr) {
  const partes = [];
  const decision = revisionPr?.decision;
  if (decision) partes.push(`Decision: ${(DECISIONES[decision] ?? [decision])[0]}`);
  for (const c of comentariosPr ?? []) {
    if (c.estado === 'descartado' || c.ambito || !c.archivo || !c.texto) continue;
    partes.push(`**${c.archivo}${rangoRevision(c)}**\n${c.tipo === 'pregunta' ? 'Question: ' : ''}${c.texto}`);
  }
  const nota = (revisionPr?.nota ?? '').trim();
  if (nota) partes.push(`Notes\n${nota}`);
  const propio = partes.join('\n\n');
  const md = plantillasVigentes(pr, plantillasPr) && typeof plantillasPr.markdown === 'string' && plantillasPr.markdown.trim() ? plantillasPr.markdown : '';
  if (!md) return propio;
  return propio ? `${propio}\n\n---\n\n${md}` : md;
}

function mensajeRutaDesconocida(id) {
  if (typeof id !== 'string' || !ID_PR.test(id)) return null;
  return `This PR is not in the dashboard.${API ? ' Paste its link in Review a PR.' : ''}`;
}

function errorRevisar(texto) {
  const e = $('errorRevisar');
  if (!e) return;
  e.textContent = texto;
  e.hidden = !texto;
}

// The PR is selected once a refresh brings it into the snapshot.
function seleccionarPendiente() {
  const id = estado.seleccionPendiente;
  if (!id) return;
  if (FOTO.prs.some((p) => p.id === id)) {
    const deRuta = estado.pendienteDeRuta;
    estado.seleccionPendiente = null;
    estado.pendienteDeRuta = false;
    // A route that arrives late never takes the selection from a PR the person already opened.
    return deRuta && estado.seleccion ? undefined : seleccionar(id);
  }
  if (!estado.refrescando && !estado.pendienteDeRuta) { estado.seleccionPendiente = null; avisar(`${id} was added, but the refresh did not bring it in. Refresh the status to try again.`); }
}

async function agregarPorEnlace() {
  const campo = $('enlaceRevisar');
  const texto = campo?.value.trim();
  if (!texto) return;
  errorRevisar('');
  campo.disabled = true;
  try {
    const r = await api('/api/revisar', { enlace: texto });
    campo.value = '';
    estado.seleccionPendiente = r.id;
    estado.pendienteDeRuta = false;
    estado.refrescando = true;
    pintarBarra();
    seleccionarPendiente();
    sondear();
  } catch (err) {
    errorRevisar(err.message);
  } finally {
    campo.disabled = false;
    campo.focus();
  }
}

async function quitarDeRevisar(id) {
  try {
    await api('/api/revisar/quitar', { id });
    estado.refrescando = true;
    pintarBarra();
    sondear();
  } catch (err) { avisar(err.message); }
}

if (API) $('enlaceRevisar')?.closest('.revisar-campo')?.removeAttribute('hidden');
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target?.id === 'enlaceRevisar') { ev.preventDefault(); agregarPorEnlace(); }
  else if (ev.key === 'Escape' && ev.target?.id === 'enlaceRevisar') errorRevisar('');
});
document.addEventListener('click', (ev) => {
  const quitar = ev.target.closest?.('[data-quitar-revisar]');
  if (quitar) return quitarDeRevisar(quitar.dataset.quitarRevisar);
  const copia = ev.target.closest?.('[data-copiar-revision]');
  if (!copia) return;
  const pr = FOTO.prs.find((p) => p.id === estado.seleccion);
  if (!pr) return avisar('There is no decision, comment or note to copy yet.');
  copiarRevision(copia, pr);
});

async function copiarRevision(boton, pr) {
  const texto = revisionMarkdown(pr, revision(pr), comentarios(pr), await plantillasParaCopiar(pr));
  if (!texto) return avisar('There is no decision, comment or note to copy yet.');
  copiar(boton, texto);
}
