import { proyecto as cargarProyecto } from '../lib/config.mjs';
import { leerJson, rutaExplicacion, rutaInstantanea } from '../lib/cache.mjs';
import { archivosPr } from '../lib/estado.mjs';
import { ghJson } from '../lib/proceso.mjs';

export default {
  name: 'pr_detalle',
  description:
    'Full context of a PR for understanding and explaining it: description, commits, files with their (truncated) diff, ' +
    'status against the testing branch, twin PR, and the saved explanation if one exists.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'numero'],
    properties: {
      proyecto: { type: 'string', description: 'Project key in proyectos.json; defaults to the default project if omitted' },
      repo: { type: 'string' },
      numero: { type: 'integer' },
      max_lineas_diff: { type: 'integer', default: 600, description: 'Maximum total diff lines' },
    },
  },
  async handler({ proyecto, repo, numero, max_lineas_diff = 600 }) {
    const p = cargarProyecto(proyecto);
    const nombre = `${p.owner}/${repo}`;
    const [pr, archivos] = await Promise.all([
      ghJson(['pr', 'view', String(numero), '-R', nombre, '--json', 'title,body,url,baseRefName,headRefName,headRefOid,state,createdAt,commits,additions,deletions']),
      archivosPr(p.owner, repo, numero),
    ]);
    const foto = leerJson(rutaInstantanea(p.salida));
    const enFoto = foto?.prs.find((x) => x.repo === repo && x.numero === numero);

    let restantes = max_lineas_diff;
    const diffs = archivos.map((a) => {
      const lineas = (a.patch ?? '').split('\n');
      const tomadas = lineas.slice(0, Math.max(0, restantes));
      restantes -= tomadas.length;
      return {
        archivo: a.filename,
        estado: a.status,
        cambios: `+${a.additions}/-${a.deletions}`,
        diff: a.patch === undefined ? '(binary or too large)' : tomadas.join('\n') + (tomadas.length < lineas.length ? `\n... (${lineas.length - tomadas.length} lines omitted)` : ''),
      };
    });

    return {
      repo,
      numero,
      titulo: pr.title,
      url: pr.url,
      base: pr.baseRefName,
      rama: pr.headRefName,
      headSha: pr.headRefOid,
      estado: pr.state,
      cambios: `+${pr.additions}/-${pr.deletions} in ${archivos.length} files`,
      descripcion: pr.body,
      commits: pr.commits.map((c) => c.messageHeadline),
      ambiente: enFoto?.ambiente,
      portal: enFoto?.portal,
      estadoPruebas: enFoto?.estadoPruebas,
      gemela: enFoto?.gemela,
      contextoProyecto: p.contexto ?? null,
      explicacionGuardada: leerJson(rutaExplicacion(p.salida, repo, numero)),
      archivos: diffs,
    };
  },
};
