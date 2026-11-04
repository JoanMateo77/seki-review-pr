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
