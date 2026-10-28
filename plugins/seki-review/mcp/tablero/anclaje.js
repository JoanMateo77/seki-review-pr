// Lógica pura del diff para el tablero: numeración de líneas, rangos seleccionados y anclaje de
// comentarios. Script clásico (sin módulos) para incrustarlo en la plantilla y probarlo con vm.
(function () {
  function lineasDePatch(patch) {
    const lineas = [];
    let viejo = 0;
    let nuevo = 0;
    for (const l of patch.split('\n')) {
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (h) {
        viejo = +h[1]; nuevo = +h[2];
        lineas.push({ tipo: 'hunk', viejo: null, nuevo: null, texto: l });
        continue;
      }
      if (l.startsWith('\\')) continue;
      const texto = l.slice(1);
      if (l[0] === '+') lineas.push({ tipo: 'add', viejo: null, nuevo: nuevo++, texto });
      else if (l[0] === '-') lineas.push({ tipo: 'del', viejo: viejo++, nuevo: null, texto });
      else lineas.push({ tipo: 'ctx', viejo: viejo++, nuevo: nuevo++, texto });
    }
    return lineas;
  }

  const claveLinea = (l) => (l.tipo === 'del' ? `v${l.viejo}` : `n${l.nuevo}`);

  function normalizarRango(lineas, claveA, claveB) {
    const posiciones = new Map();
    lineas.forEach((l, i) => { if (l.tipo !== 'hunk') posiciones.set(claveLinea(l), i); });
    if (!posiciones.has(claveA) || !posiciones.has(claveB)) return null;
    const [i, j] = [posiciones.get(claveA), posiciones.get(claveB)].sort((a, b) => a - b);
    const tramo = lineas.slice(i, j + 1).filter((l) => l.tipo !== 'hunk');
    const conNuevo = tramo.filter((l) => l.nuevo !== null);
    const hayBorradas = tramo.some((l) => l.tipo === 'del');
    const lado = !conNuevo.length ? 'viejo' : hayBorradas ? 'mixto' : 'nuevo';
    const numeros = lado === 'viejo' ? tramo.map((l) => l.viejo) : conNuevo.map((l) => l.nuevo);
    return {
      lado,
      desde: Math.min(...numeros),
      hasta: Math.max(...numeros),
      claves: tramo.map(claveLinea),
      texto: tramo.map((l) => l.texto).join('\n'),
    };
  }

  function clavesDe(c) {
    if (c.claves?.length) return c.claves;
    const prefijo = c.lado === 'viejo' ? 'v' : 'n';
    const claves = [];
    for (let n = c.desde; n <= c.hasta; n++) claves.push(prefijo + n);
    return claves;
  }

  function anclar(comentario, lineas) {
    const porClave = new Map(lineas.filter((l) => l.tipo !== 'hunk').map((l) => [claveLinea(l), l]));
    const claves = clavesDe(comentario);
    if (!claves.every((k) => porClave.has(k))) return { desactualizado: true };
    if (claves.map((k) => porClave.get(k).texto).join('\n') !== comentario.textoOriginal) return { desactualizado: true };
    return { claveFinal: claves[claves.length - 1] };
  }

  const textoSugerido = (t) => t.replace(/\r\n/g, '\n').replace(/\n$/, '');

  globalThis.SekiAnclaje = { lineasDePatch, claveLinea, normalizarRango, anclar, textoSugerido };
})();
