import { proyecto as cargarProyecto } from '../lib/config.mjs';
import { incorporarEnlace } from '../lib/revisar.mjs';

export default {
  name: 'pr_revisar',
  description:
    'Adds a PR to the "To review" list of the dashboard from its link (https://github.com/<owner>/<repo>/pull/<n>, <repo>#<n> or "<repo> <n>"). ' +
    'The repository must be configured in the project and the PR open (one `gh pr view` checks it). It spends no AI and writes nothing to GitHub: ' +
    'a served dashboard with its tab open refreshes the repo on its next watcher probe (every few minutes) or on "Refresh status". Returns the PR id, whether it was added or already there, and the dashboard hash that selects it.',
  inputSchema: {
    type: 'object',
    required: ['enlace'],
    properties: {
      proyecto: { type: 'string', description: 'Project key in proyectos.json; defaults to the default project if omitted' },
      enlace: { type: 'string', description: 'PR link or repo#number, at most 500 characters' },
    },
  },
  async handler({ proyecto, enlace }) {
    const p = cargarProyecto(proyecto);
    const { id, estado } = await incorporarEnlace(p, enlace);
    return { id, estado, enlaceTablero: `#${encodeURIComponent(id)}/resumen` };
  },
};
