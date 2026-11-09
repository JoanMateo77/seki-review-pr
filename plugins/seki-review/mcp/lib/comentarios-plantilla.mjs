// Conventional Comments from template review results. Pure: no I/O, no clock.
const TOPE_POR_PLANTILLA = 5;
const ENCABEZADO = { en: 'Not verifiable from the diff', es: 'No se pudo verificar desde el diff' };

const una = (s) => String(s).replace(/\s*[\r\n]+\s*/g, ' ').trim();
const hay = (v) => v !== undefined && v !== null && v !== '';

function comentarioDe(plantilla, item) {
  const h = item.hallazgos?.[0];
  const determinista = item.origen === 'determinista';
  const etiqueta = item.siFalla?.etiqueta ?? 'issue';
  const bloquea = Boolean(item.siFalla?.bloqueante) && (determinista || item.veredicto === 'CONFIRMED');
  const decoraciones = [];
  if (bloquea) decoraciones.push('blocking');
  else if (etiqueta !== 'nitpick') decoraciones.push('non-blocking');
  if (item.siFalla?.tema) decoraciones.push(item.siFalla.tema);
  const cita = item.cita ?? (determinista ? h?.texto : undefined);
  return {
    etiqueta,
    decoraciones,
    asunto: determinista ? (h?.mensaje ?? item.titulo ?? item.pregunta) : (item.titulo ?? item.pregunta),
    archivo: item.archivo ?? h?.archivo ?? null,
    linea: item.linea ?? h?.linea ?? null,
    cita: hay(cita) ? una(cita) : null,
    detalle: item.detalle ?? '',
    ref: `${plantilla.id}/${item.id}`,
    bloqueante: bloquea,
  };
}

function bloque(cabecera, c) {
  const lineas = [cabecera];
  if (hay(c.archivo)) lineas.push(`\`${c.archivo}${hay(c.linea) ? `:${c.linea}` : ''}\``);
  if (c.cita) lineas.push(`> ${c.cita}`);
  if (c.detalle) lineas.push('', c.detalle);
  lineas.push(`_[${c.ref}]_`);
  return lineas.join('\n');
}

function aMarkdown(c) {
  const deco = c.decoraciones.length ? ` (${c.decoraciones.join(', ')})` : '';
  return bloque(`**${c.etiqueta}${deco}: ${c.asunto}**`, c);
}

export function comentariosDePlantillas(resultado) {
  const plantillas = Array.isArray(resultado?.plantillas) ? resultado.plantillas : [];
  const comentarios = [];
  let recortados = 0;
  for (const p of plantillas) {
    const propios = (p.items ?? []).filter((i) => i.estado === 'falla').map((i) => comentarioDe(p, i));
    const ordenados = [...propios.filter((c) => c.bloqueante), ...propios.filter((c) => !c.bloqueante)];
    recortados += Math.max(0, ordenados.length - TOPE_POR_PLANTILLA);
    comentarios.push(...ordenados.slice(0, TOPE_POR_PLANTILLA));
  }
  // Stable: blocking first, then template and item order.
  comentarios.sort((a, b) => Number(b.bloqueante) - Number(a.bloqueante));

  const partes = comentarios.map(aMarkdown);

  for (const p of plantillas) {
    const i = (p.items ?? []).find((x) => x.estado === 'cumple' && x.origen === 'ia' && hay(x.cita));
    if (!i) continue;
    const c = {
      archivo: i.archivo ?? null, linea: i.linea ?? null, cita: una(i.cita),
      detalle: i.detalle ?? '', ref: `${p.id}/${i.id}`,
    };
    partes.push(bloque(`**praise: ${i.titulo ?? i.pregunta}**`, c));
    break;
  }

  const sinVerificar = plantillas.flatMap((p) => (p.items ?? []).filter((i) => i.estado === 'no_verificable'));
  if (sinVerificar.length) {
    const idioma = plantillas[0]?.idioma === 'es' ? 'es' : 'en';
    partes.push([`**${ENCABEZADO[idioma]}**`, ...sinVerificar.map((i) => `- ${i.pregunta} — ${i.pedido ?? i.motivo ?? ''}`)].join('\n'));
  }
  return { comentarios, markdown: partes.join('\n\n'), recortados };
}
