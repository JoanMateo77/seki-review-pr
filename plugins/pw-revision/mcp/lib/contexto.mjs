// Contexto que se entrega a la IA para responder preguntas sobre líneas: el hunk del diff y el archivo
// alrededor de esas líneas en la versión de la PR (no en la rama en que esté parado el checkout).
import { expandir } from './config.mjs';
import { asegurarDiff } from './diffs.mjs';
import { enCola } from './estado.mjs';
import { git } from './proceso.mjs';
import { SECCIONES } from './comentarios.mjs';

const MARGEN = 40;
// Un archivo corto va completo: cuesta poco y evita respuestas de "no se puede determinar".
const ARCHIVO_COMPLETO = 400;
const TOPE = 60000;

export async function archivoEnSha(p, repo, numero, headSha, archivo) {
  const dir = expandir(p.repos[repo].checkout);
  const mostrar = () => git(dir, ['show', `${headSha}:${archivo}`]);
  try { return await mostrar(); } catch { /* el commit no está en el checkout */ }
  const ref = `refs/pw-revision/${numero}/contexto`;
  return enCola(dir, async () => {
    try {
      await git(dir, ['fetch', '-q', '--no-write-fetch-head', 'origin', `+pull/${numero}/head:${ref}`]);
      return await mostrar();
    } catch {
      return null;
    } finally {
      await git(dir, ['update-ref', '-d', ref]).catch(() => {});
    }
  });
}

export function fragmento(texto, desde, hasta, margen = MARGEN) {
  const lineas = texto.replace(/\n$/, '').split('\n');
  const ini = Math.max(1, desde - margen);
  const fin = Math.min(lineas.length, hasta + margen);
  const ancho = Math.max(5, String(fin).length);
  return {
    desde: ini,
    hasta: fin,
    texto: lineas.slice(ini - 1, fin).map((l, i) => `${String(ini + i).padStart(ancho)}│ ${l}`).join('\n'),
  };
}

function hunks(patch) {
  const lista = [];
  for (const l of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (h) lista.push({ viejo: [+h[1], +h[1] + Math.max(0, (h[2] ?? 1) - 1)], nuevo: [+h[3], +h[3] + Math.max(0, (h[4] ?? 1) - 1)], lineas: [l] });
    else lista.at(-1)?.lineas.push(l);
  }
  return lista;
}

const cruza = ([a, b], desde, hasta) => a <= hasta && desde <= b;

function recortar(texto, max) {
  return texto.length <= max ? texto : `${texto.slice(0, Math.max(0, max - 40))}\n... (recortado por longitud)`;
}

function contextoDePr(pr, archivos) {
  const e = pr.explicacion;
  const explicacion = e ? Object.entries(SECCIONES).filter(([k]) => e[k] !== undefined && e[k] !== null && e[k] !== '')
    .map(([k, titulo]) => `#### ${titulo}\n${typeof e[k] === 'string' ? e[k] : JSON.stringify(e[k], null, 1)}`).join('\n') : '';
  const diff = archivos.map((a) => `### ${a.filename}\n${a.patch ?? '(sin diff: binario o demasiado grande)'}`).join('\n\n');
  return [explicacion ? `## Explicación actual de la PR\n${explicacion}` : '## La PR aún no tiene explicación', `## Diff de la PR\n${diff}`].join('\n\n');
}

// Preguntas y respuestas anteriores de una repregunta, de la más vieja a la más nueva, completas.
function hilo(c, todos) {
  const porId = new Map(todos.map((x) => [x.id, x]));
  const previos = [];
  for (let x = porId.get(c.respondeA); x && previos.length < 6; x = porId.get(x.respondeA)) previos.unshift(x);
  if (!previos.length) return '';
  return `Conversación previa:\n${previos.map((x) => `- Pregunta: ${x.texto}\n  Respuesta: ${x.respuesta ?? '(sin respuesta)'}`).join('\n')}`;
}

export async function contextoPreguntas(p, pr, comentarios, { archivos, todos = [] } = {}) {
  archivos ??= await asegurarDiff(p, pr.repo, pr.numero, pr.headSha);
  const contenidos = new Map();
  const bloques = [];
  const dePr = comentarios.filter((c) => c.ambito === 'pr');
  for (const c of dePr) {
    bloques.push([`### Pregunta ${c.id} sobre la PR${c.seccion ? ` (sección «${SECCIONES[c.seccion]}»)` : ''}`, c.citado ? `Texto citado de la explicación: «${c.citado}»` : '', hilo(c, todos), `Texto: ${c.texto}`].filter(Boolean).join('\n'));
  }
  if (dePr.length) bloques.push(contextoDePr(pr, archivos));
  for (const c of comentarios.filter((x) => x.ambito !== 'pr')) {
    const a = archivos.find((x) => x.filename === c.archivo);
    const lado = c.lado === 'viejo' ? 'viejo' : 'nuevo';
    const diff = a?.patch ? hunks(a.patch).filter((h) => cruza(h[lado], c.desde, c.hasta)).map((h) => h.lineas.join('\n')).join('\n') : '';
    let archivo = '';
    if (lado === 'nuevo') {
      if (!contenidos.has(c.archivo)) contenidos.set(c.archivo, await archivoEnSha(p, pr.repo, pr.numero, pr.headSha, c.archivo));
      const texto = contenidos.get(c.archivo);
      if (texto !== null) {
        const total = texto.split('\n').length;
        const f = fragmento(texto, c.desde, c.hasta, total <= ARCHIVO_COMPLETO ? total : MARGEN);
        archivo = `Archivo en la versión de la PR (líneas ${f.desde}–${f.hasta}):\n${f.texto}`;
      }
    }
    const rango = c.desde === c.hasta ? `L${c.desde}` : `L${c.desde}–${c.hasta}`;
    bloques.push([
      `### Comentario ${c.id} · ${c.archivo} ${rango}${lado === 'viejo' ? ' (líneas borradas)' : ''}`,
      hilo(c, todos),
      `Texto: ${c.texto}`,
      diff ? `Diff:\n${diff}` : 'Diff: no disponible para estas líneas.',
      archivo,
    ].filter(Boolean).join('\n'));
  }
  const pie = [
    `## PR ${pr.id}: ${pr.titulo}`,
    pr.cuerpo ? `Descripción:\n${recortar(pr.cuerpo, 1500)}` : '',
    pr.explicacion?.resumen ? `Resumen de la explicación: ${pr.explicacion.resumen}` : '',
  ].filter(Boolean).join('\n');
  const porBloque = Math.floor((TOPE - pie.length - 200) / Math.max(1, bloques.length));
  return [...bloques.map((b) => recortar(b, porBloque)), pie].join('\n\n');
}
