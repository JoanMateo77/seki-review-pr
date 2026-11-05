import { proyecto as cargarProyecto, cargarProyectos } from '../lib/config.mjs';
import { leerJson, rutaInstantanea } from '../lib/cache.mjs';
import { modoDe } from '../lib/perfiles.mjs';
import { gastoMaquina } from '../lib/presupuesto.mjs';
import { nombresDeArchivos } from '../lib/tablero.mjs';
import { datosUltra } from '../lib/ultra.mjs';

export default {
  name: 'pr_ultra',
  description:
    'Ultra review of a PR, read-only: the cost estimate and what it is based on, whether Ultra is suggested (sensitive paths or a ' +
    'security PR), the stored result for the PR (marked outdated when the PR has newer commits) and the dashboard link that opens the ' +
    'confirmation. It never starts the review and spends no AI: the review is launched and confirmed from the dashboard.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'numero'],
    properties: {
      proyecto: { type: 'string', description: 'Project key in proyectos.json; defaults to the default project if omitted' },
      repo: { type: 'string' },
      numero: { type: 'integer', description: 'PR number on GitHub' },
    },
  },
  // `disponible` reflects the project mode only: the dashboard selector can still allow Ultra.
  async handler({ proyecto, repo, numero }) {
    if (!Number.isInteger(numero) || numero < 1) throw new Error('numero must be a positive integer.');
    const p = cargarProyecto(proyecto);
    const pr = leerJson(rutaInstantanea(p.salida))?.prs.find((x) => x.repo === repo && x.numero === numero);
    if (!pr) throw new Error(`${repo}#${numero} is not in the last snapshot of open PRs: refresh the dashboard status first.`);
    const modo = modoDe(p);
    const limite = p.ia.presupuestoDiarioUsd;
    let presupuesto = null;
    if (limite) {
      let gastado = null;
      try { gastado = gastoMaquina({ proyectos: cargarProyectos().proyectos }); } catch { console.error('[seki-review/presupuesto] The project list could not be read: the spend is not reported'); }
      presupuesto = { limite, gastado };
    }
    return {
      repo, numero, headSha: pr.headSha, modo,
      disponible: pr.estadoPr === 'OPEN' && modo !== 'ahorro',
      presupuesto,
      ...datosUltra(p, pr, nombresDeArchivos(p, pr)),
      enlace: `#/pr/${repo}/${numero}?ultra=1`,
    };
  },
};
