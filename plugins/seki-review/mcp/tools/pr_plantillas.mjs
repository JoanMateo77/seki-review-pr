import { proyecto as cargarProyecto } from '../lib/config.mjs';
import { leerJson, rutaInstantanea } from '../lib/cache.mjs';
import { datosPlantillas } from '../lib/revision-plantillas.mjs';
import { nombresDeArchivos } from '../lib/tablero.mjs';

export default {
  name: 'pr_plantillas',
  description:
    'Template review of a PR, read-only: the review templates that apply to the PR and why (the matching file and glob, or ' +
    'always), the omitted ones, the files covered only by the base template, the template files skipped as invalid, the cost ' +
    'estimate and its cap, the stored result (checklist per template and the Conventional Comments, marked outdated when the PR ' +
    'has newer commits) and the dashboard link that opens the confirmation. It never starts the review and spends no AI: the ' +
    'review is launched and confirmed from the dashboard. The selection uses the cached diff of the current commit; without it, ' +
    'only the templates that always apply are listed.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'numero'],
    properties: {
      proyecto: { type: 'string', description: 'Project key in proyectos.json; defaults to the default project if omitted' },
      repo: { type: 'string' },
      numero: { type: 'integer', description: 'PR number on GitHub' },
    },
  },
  async handler({ proyecto, repo, numero }) {
    if (!Number.isInteger(numero) || numero < 1) throw new Error('numero must be a positive integer.');
    const p = cargarProyecto(proyecto);
    const pr = leerJson(rutaInstantanea(p.salida))?.prs.find((x) => x.repo === repo && x.numero === numero);
    if (!pr) throw new Error(`${repo}#${numero} is not in the last snapshot of open PRs: refresh the dashboard status first.`);
    return {
      repo, numero, headSha: pr.headSha,
      disponible: pr.estadoPr === 'OPEN',
      ...datosPlantillas(p, pr, nombresDeArchivos(p, pr)),
      enlace: `#/pr/${repo}/${numero}?plantillas=1`,
    };
  },
};
