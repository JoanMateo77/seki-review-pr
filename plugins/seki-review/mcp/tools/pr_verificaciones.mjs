import { basename } from 'node:path';
import { expandir, proyecto as cargarProyecto } from '../lib/config.mjs';
import { escribirJson, rutaVerificacion } from '../lib/cache.mjs';
import { archivosPr, commitsPr } from '../lib/estado.mjs';
import { ghJson, git } from '../lib/proceso.mjs';
import { archivosDeDiff, verificar } from '../lib/verificar.mjs';
import { REGLAS, reglasDeConfig } from '../lib/reglas.mjs';

export default {
  name: 'pr_verificaciones',
  description:
    'Runs the project\'s fixed checks (interpolated SQL, secrets, "comercio" in visible text, unescaped EJS, ' +
    'as any, sensitive logs, environment variables, DDL, dependencies, AI attribution trailers in commits) on the lines a PR adds, ' +
    'or on a local branch before opening the PR (dir + base). No AI involved: the result is reproducible.',
  inputSchema: {
    type: 'object',
    properties: {
      proyecto: { type: 'string', description: 'Project key in proyectos.json; defaults to the default project if omitted' },
      repo: { type: 'string' },
      numero: { type: 'integer', description: 'PR number on GitHub' },
      dir: { type: 'string', description: 'Local checkout or worktree, to check a branch that has no PR' },
      base: { type: 'string', description: 'With dir: base branch (for example origin/main)' },
      listar_reglas: { type: 'boolean', description: 'Only return the rule catalog' },
    },
  },
  async handler({ proyecto, repo, numero, dir, base, listar_reglas }) {
    const p = cargarProyecto(proyecto);
    if (listar_reglas) return [...REGLAS, ...reglasDeConfig(p.reglas)].map((r) => `${r.id} [${r.severidad}] ${r.titulo}. ${r.origen}`).join('\n');

    if (dir) {
      if (!base) throw new Error('base is required with dir (for example origin/main).');
      const d = expandir(dir);
      const nombre = repo ?? basename((await git(d, ['remote', 'get-url', 'origin'])).trim()).replace(/\.git$/, '');
      const archivos = archivosDeDiff(await git(d, ['diff', `${base}...HEAD`]));
      const log = await git(d, ['log', '--format=%H%x1f%s%x1f%b%x1e', `${base}..HEAD`]);
      const commits = log.split('\x1e').map((x) => x.trim()).filter(Boolean).map((x) => {
        const [oid, messageHeadline, messageBody] = x.split('\x1f');
        return { oid, messageHeadline, messageBody };
      });
      return { repo: nombre, rama: (await git(d, ['branch', '--show-current'])).trim(), base, ...verificar({ repo: nombre, archivos, commits, omitidas: p.repos[nombre]?.reglas_omitidas, extra: reglasDeConfig(p.reglas) }) };
    }

    if (!repo || !numero) throw new Error('Provide repo and numero, or dir and base.');
    const [archivos, commits, { headRefOid }] = await Promise.all([
      archivosPr(p.owner, repo, numero),
      commitsPr(p.owner, repo, numero),
      ghJson(['pr', 'view', String(numero), '-R', `${p.owner}/${repo}`, '--json', 'headRefOid']),
    ]);
    const resultado = { repo, numero, headSha: headRefOid, ...verificar({ repo, archivos, commits, omitidas: p.repos[repo]?.reglas_omitidas, extra: reglasDeConfig(p.reglas) }) };
    escribirJson(rutaVerificacion(p.salida, repo, numero), resultado);
    return resultado;
  },
};
