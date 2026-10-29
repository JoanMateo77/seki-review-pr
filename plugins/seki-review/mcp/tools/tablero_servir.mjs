import { iniciarServidor } from '../lib/servidor-web.mjs';

export default {
  name: 'tablero_servir',
  description:
    'Opens the interactive review dashboard, served on 127.0.0.1 for the duration of this session (fixed link per machine; if another session already serves it, that one is opened and this one stays on standby; a newer version takes the port over from an older one): a button to refresh the status ' +
    '(what was merged, what is new, what changed group) and buttons to analyze one PR or all pending PRs with AI ' +
    '(runs claude -p in the background with the sonnet model and read-only tools). Nothing is published outside this machine.',
  inputSchema: {
    type: 'object',
    properties: {
      proyecto: { type: 'string', description: 'Project key in proyectos.json; defaults to the default project if omitted' },
      puerto: { type: 'integer', default: 4317 },
      abrir: { type: 'boolean', default: true },
    },
  },
  async handler({ proyecto, puerto = 4317, abrir = true }) {
    const { url, yaEstaba, aviso } = await iniciarServidor({ proyecto, puerto, abrir });
    return `${yaEstaba ? 'The dashboard was already being served' : 'Dashboard served'} at ${url} (this machine only; the link includes the access token).${aviso ? ` ${aviso}` : ''}`;
  },
};
