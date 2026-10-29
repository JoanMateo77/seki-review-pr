// Live progress of AI jobs, in memory: the current stage and what the AI is reading. The dashboard reads it
// on every poll so a long job does not look stuck. Keys: `c:<comment>` and `pr:<repo>#<n>`.
const mapa = new Map();

export function fijarAvance(clave, cambios) {
  const previo = mapa.get(clave) ?? { archivos: 0, busquedas: 0 };
  mapa.set(clave, { ...previo, ...cambios, actualizado: new Date().toISOString() });
}

// Each tool call adds to the counter; Read records the last file, relative to the working directory.
export function contarHerramienta(clave, { nombre, entrada }, raices = []) {
  const a = mapa.get(clave) ?? { archivos: 0, busquedas: 0 };
  if (nombre === 'Read' && typeof entrada?.file_path === 'string') {
    const raiz = [raices].flat().find((r) => r && entrada.file_path.startsWith(`${r}/`));
    const ruta = raiz ? entrada.file_path.slice(raiz.length + 1) : entrada.file_path.split('/').slice(-3).join('/');
    fijarAvance(clave, { archivos: a.archivos + 1, ultimo: ruta.slice(-120) });
  } else if (nombre === 'Grep' || nombre === 'Glob') {
    fijarAvance(clave, { busquedas: a.busquedas + 1 });
  } else if (nombre === 'Edit' || nombre === 'Write') {
    fijarAvance(clave, { ediciones: (a.ediciones ?? 0) + 1 });
  }
}

export const quitarAvance = (clave) => mapa.delete(clave);
export const avances = () => Object.fromEntries(mapa);
