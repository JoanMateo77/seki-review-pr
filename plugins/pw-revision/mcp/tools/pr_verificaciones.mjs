import { basename } from 'node:path';
import { expandir, proyecto as cargarProyecto } from '../lib/config.mjs';
import { escribirJson, rutaVerificacion } from '../lib/cache.mjs';
import { archivosPr, commitsPr } from '../lib/estado.mjs';
import { ghJson, git } from '../lib/proceso.mjs';
import { archivosDeDiff, verificar } from '../lib/verificar.mjs';
import { REGLAS } from '../lib/reglas.mjs';

export default {
  name: 'pr_verificaciones',
  description:
    'Corre las verificaciones fijas del proyecto (SQL interpolado, secretos, "comercio" en texto visible, EJS sin escapar, ' +
    'as any, logs sensibles, variables de entorno, DDL, dependencias, firma de Claude en commits) sobre las líneas que agrega una PR, ' +
    'o sobre una rama local antes de abrir la PR (dir + base). Sin IA: el resultado es reproducible.',
  inputSchema: {
    type: 'object',
    properties: {
      proyecto: { type: 'string', default: 'demo' },
      repo: { type: 'string' },
      numero: { type: 'integer', description: 'PR en GitHub' },
      dir: { type: 'string', description: 'Checkout o worktree local, para verificar una rama sin PR' },
      base: { type: 'string', description: 'Con dir: rama base (por ejemplo origin/main)' },
      listar_reglas: { type: 'boolean', description: 'Solo devolver el catálogo de reglas' },
    },
  },
  async handler({ proyecto, repo, numero, dir, base, listar_reglas }) {
    if (listar_reglas) return REGLAS.map((r) => `${r.id} [${r.severidad}] ${r.titulo}. ${r.origen}`).join('\n');
    const p = cargarProyecto(proyecto);

    if (dir) {
      if (!base) throw new Error('Con dir hace falta base (por ejemplo origin/main).');
      const d = expandir(dir);
      const nombre = repo ?? basename((await git(d, ['remote', 'get-url', 'origin'])).trim()).replace(/\.git$/, '');
      const archivos = archivosDeDiff(await git(d, ['diff', `${base}...HEAD`]));
      const log = await git(d, ['log', '--format=%H%x1f%s%x1f%b%x1e', `${base}..HEAD`]);
      const commits = log.split('\x1e').map((x) => x.trim()).filter(Boolean).map((x) => {
        const [oid, messageHeadline, messageBody] = x.split('\x1f');
        return { oid, messageHeadline, messageBody };
      });
      return { repo: nombre, rama: (await git(d, ['branch', '--show-current'])).trim(), base, ...verificar({ repo: nombre, archivos, commits, omitidas: p.repos[nombre]?.reglas_omitidas }) };
    }

    if (!repo || !numero) throw new Error('Indicar repo y numero, o dir y base.');
    const [archivos, commits, { headRefOid }] = await Promise.all([
      archivosPr(p.owner, repo, numero),
      commitsPr(p.owner, repo, numero),
      ghJson(['pr', 'view', String(numero), '-R', `${p.owner}/${repo}`, '--json', 'headRefOid']),
    ]);
    const resultado = { repo, numero, headSha: headRefOid, ...verificar({ repo, archivos, commits, omitidas: p.repos[repo]?.reglas_omitidas }) };
    escribirJson(rutaVerificacion(p.salida, repo, numero), resultado);
    return resultado;
  },
};
