// What changed between two snapshots: PRs that left the open list (and whether they were merged or
// closed), new PRs and PRs that changed group. Departures are looked up on GitHub one by one.
import { enParalelo, ghJson } from './proceso.mjs';

const abiertas = (foto) => new Map((foto?.prs ?? []).filter((x) => x.estadoPr !== 'MERGED').map((x) => [x.id, x]));

export async function compararFotos(anterior, actual, owner) {
  if (!anterior?.prs) return null;
  const antes = abiertas(anterior);
  const ahora = abiertas(actual);
  const salieron = [...antes.values()].filter((x) => !ahora.has(x.id));
  const resueltas = await enParalelo(salieron, 6, async (x) => {
    const r = await ghJson(['api', `repos/${owner}/${x.repo}/pulls/${x.numero}`]).catch(() => null);
    return {
      id: x.id, repo: x.repo, numero: x.numero, titulo: x.titulo, base: x.base, portal: x.portal,
      estado: r?.merged_at ? 'mergeada' : r?.state === 'closed' ? 'cerrada' : 'fuera de la lista',
      fecha: r?.merged_at ?? r?.closed_at ?? null,
    };
  });
  const nuevas = [...ahora.values()].filter((x) => !antes.has(x.id)).map(({ id, repo, numero, titulo, base, portal }) => ({ id, repo, numero, titulo, base, portal }));
  const movidas = [...ahora.values()]
    .filter((x) => antes.has(x.id) && antes.get(x.id).accion !== x.accion)
    .map((x) => ({ id: x.id, repo: x.repo, numero: x.numero, titulo: x.titulo, de: antes.get(x.id).accion, a: x.accion }));
  return {
    desde: anterior.generado,
    hasta: actual.generado,
    mergeadas: resueltas.filter((x) => x.estado === 'mergeada'),
    cerradas: resueltas.filter((x) => x.estado !== 'mergeada'),
    nuevas,
    movidas,
  };
}

export const hayCambios = (c) => !!c && (c.mergeadas.length + c.cerradas.length + c.nuevas.length + c.movidas.length) > 0;
