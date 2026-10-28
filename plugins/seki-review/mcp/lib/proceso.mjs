import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const OPCIONES = { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GH_PAGER: '', GIT_PAGER: '' } };

export async function gh(args) {
  const { stdout } = await exec(process.env.SEKI_GH ?? 'gh', args, OPCIONES);
  return stdout;
}

export const ghJson = async (args) => JSON.parse(await gh(args));

// gh api --paginate concatena arreglos JSON; --slurp los junta en uno de páginas.
export async function ghApiLista(ruta) {
  const paginas = await ghJson(['api', '--paginate', '--slurp', ruta]);
  return paginas.flat();
}

export async function git(dir, args, opciones = {}) {
  const { stdout } = await exec('git', ['-C', dir, ...args], { ...OPCIONES, ...opciones, env: { ...OPCIONES.env, ...opciones.env } });
  return stdout;
}

export async function enParalelo(items, limite, fn) {
  const resultados = new Array(items.length);
  let siguiente = 0;
  const trabajador = async () => {
    while (siguiente < items.length) {
      const i = siguiente++;
      resultados[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limite, items.length) }, trabajador));
  return resultados;
}
