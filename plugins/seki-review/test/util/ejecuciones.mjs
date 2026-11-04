// Records the input of every run of a regex whose source contains `fuente`. Patching exec keeps the vm guard in force,
// so tests assert which inputs a catastrophic pattern ran on instead of how long it took. A run starved of CPU may be
// repeated on the same input, so tests compare distinct inputs, not the number of runs.
export function ejecuciones(fuente, fn) {
  const original = RegExp.prototype.exec;
  const entradas = [];
  RegExp.prototype.exec = function exec(texto) {
    if (this.source.includes(fuente)) entradas.push(String(texto));
    return original.call(this, texto);
  };
  try { return [fn(), entradas]; } finally { RegExp.prototype.exec = original; }
}

export const distintas = (entradas) => [...new Set(entradas)];

// Counts the text work done by `fn`: characters scanned by String#indexOf plus regex runs (the tokenizer tests one
// character per run). It does not depend on speed, so a linear-work bound can be asserted exactly.
export function trabajoDeTexto(fn) {
  const indexOf = String.prototype.indexOf;
  const exec = RegExp.prototype.exec;
  let trabajo = 0;
  String.prototype.indexOf = function (buscado, desde) {
    const inicio = Math.max(0, Math.trunc(Number(desde) || 0));
    const r = indexOf.call(this, buscado, desde);
    trabajo += (r < 0 ? this.length : r) - inicio + 1;
    return r;
  };
  RegExp.prototype.exec = function (texto) {
    trabajo++;
    return exec.call(this, texto);
  };
  try {
    let resultado;
    let error = null;
    try { resultado = fn(); } catch (e) { error = e; }
    return { resultado, error, trabajo };
  } finally {
    String.prototype.indexOf = indexOf;
    RegExp.prototype.exec = exec;
  }
}
