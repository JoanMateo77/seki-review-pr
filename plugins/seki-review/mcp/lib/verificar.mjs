import { SEVERIDADES, reglasDelRepo } from './reglas.mjs';

// Accepts both `ignore` and the original Spanish `ignorar`, so existing directives keep working.
const IGNORAR = /seki-review:\s*(?:ignore|ignorar)\s+([\w-]+)/;
const MAX_POR_REGLA_Y_ARCHIVO = 5;

// Added lines of a unified patch, with their line number in the new version of the file.
export function lineasAgregadas(patch = '') {
  const salida = [];
  let nueva = 0;
  for (const l of patch.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (h) { nueva = +h[1]; continue; }
    if (l.startsWith('+') && !l.startsWith('+++')) salida.push({ linea: nueva++, texto: l.slice(1) });
    else if (l.startsWith(' ')) nueva++;
  }
  return salida;
}

// Local `git diff` -> same shape as GitHub's files API ({ filename, status, patch }).
export function archivosDeDiff(diff) {
  return diff.split(/^diff --git /m).slice(1).map((bloque) => {
    const destino = /^\+\+\+ (?:b\/)?(.+)$/m.exec(bloque)?.[1];
    const origen = /^--- (?:a\/)?(.+)$/m.exec(bloque)?.[1];
    const status = destino === '/dev/null' ? 'removed' : origen === '/dev/null' ? 'added' : 'modified';
    const filename = destino && destino !== '/dev/null' ? destino : origen ?? bloque.split(' ')[0].replace(/^a\//, '');
    const inicio = bloque.indexOf('\n@@');
    return { filename, status, patch: inicio >= 0 ? bloque.slice(inicio + 1) : undefined };
  });
}

const ATRIBUCION_IA = /co-authored-by:\s*claude|claude-session:|generated with \[?claude/i;

export function verificar({ repo, archivos, commits = [], omitidas = [], extra = [] }) {
  const reglas = reglasDelRepo(repo, omitidas, extra);
  const hallazgos = [];

  for (const a of archivos) {
    if (a.status === 'removed') continue;
    for (const r of reglas.filter((x) => x.archivos.test(a.filename))) {
      if (r.porArchivo) {
        if (!r.soloAgregados || a.status === 'added') hallazgos.push(hallazgo(r, a.filename));
        continue;
      }
      if (r.excluir && r.excluir.test(a.filename)) continue;
      let n = 0;
      for (const { linea, texto } of lineasAgregadas(a.patch)) {
        if (!r.patron.test(texto)) continue;
        if (r.excluir && r.excluir.test(texto)) continue;
        if (r.cuando && !r.cuando(texto, a.filename)) continue;
        if (IGNORAR.exec(texto)?.[1] === r.id) continue;
        const severidad = r.severidadPara ? r.severidadPara(texto) : r.severidad;
        if (!severidad) continue;
        if (++n > MAX_POR_REGLA_Y_ARCHIVO) break;
        hallazgos.push({ ...hallazgo(r, a.filename, linea, texto.trim().slice(0, 200)), severidad });
      }
    }
  }

  for (const c of commits) {
    if (ATRIBUCION_IA.test(`${c.messageHeadline}\n${c.messageBody ?? ''}`)) {
      hallazgos.push({
        regla: 'atribucion-ia',
        titulo: 'Commit with AI attribution',
        severidad: 'alto',
        archivo: `commit ${c.oid?.slice(0, 7) ?? ''}`.trim(),
        texto: c.messageHeadline,
        mensaje: 'Remove the Co-Authored-By / Claude-Session trailer before merging.',
        origen: 'Standing rule: no AI attribution in commits or PRs.',
      });
    }
  }

  hallazgos.sort((x, y) => SEVERIDADES.indexOf(x.severidad) - SEVERIDADES.indexOf(y.severidad));
  return { hallazgos, resumen: resumir(hallazgos) };
}

function hallazgo(r, archivo, linea, texto) {
  return { regla: r.id, titulo: r.titulo, severidad: r.severidad, archivo, linea, texto, mensaje: r.mensaje, origen: r.origen };
}

export function resumir(hallazgos) {
  return Object.fromEntries(SEVERIDADES.map((s) => [s, hallazgos.filter((h) => h.severidad === s).length]));
}
