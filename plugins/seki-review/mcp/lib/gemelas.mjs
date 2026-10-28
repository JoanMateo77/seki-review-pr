// La PR "gemela" es la misma tarea abierta contra la otra rama de la línea (prod <-> pruebas).
// Se detecta por parecido del título: los títulos difieren solo en el sufijo de ambiente.
const VACIAS = new Set(['para', 'por', 'con', 'sin', 'los', 'las', 'del', 'que', 'una', 'uno', 'the', 'and']);

export function tokensTitulo(titulo) {
  return new Set(
    titulo
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/^\s*\[[^\]]*\]\s*/, '')
      .replace(/^[a-z]+(\([^)]*\))?!?:\s*/, '')
      .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !VACIAS.has(t)),
  );
}

export function parecido(a, b) {
  const ta = tokensTitulo(a);
  const tb = tokensTitulo(b);
  if (!ta.size || !tb.size) return 0;
  let comunes = 0;
  for (const t of ta) if (tb.has(t)) comunes++;
  return comunes / (ta.size + tb.size - comunes);
}

export function buscarGemela(titulo, candidatas, umbral = 0.6) {
  let mejor = null;
  for (const c of candidatas) {
    const p = parecido(titulo, c.title);
    if (p >= umbral && (!mejor || p > mejor.parecido)) mejor = { numero: c.number, estado: c.state, titulo: c.title, parecido: +p.toFixed(2) };
  }
  return mejor;
}
