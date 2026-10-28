// Pedidos de cambio: la IA trabaja en la copia de la PR, el servidor comprueba el resultado y lo guarda como
// propuesta. Solo Aprobar lo lleva a la rama, y solo si la rama sigue donde estaba cuando se generó.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escribirJson, leerJson, rutaPropuestas } from './cache.mjs';
import { comprobar } from './calidad.mjs';
import { actualizarComentario, leerComentarios } from './comentarios.mjs';
import { expandir } from './config.mjs';
import { contextoPreguntas } from './contexto.mjs';
import { borrarCopia, crearCopia, diffCopia, reiniciarCopia } from './copias.mjs';
import { argsClaude, ejecutarClaude, elegirModelo, registrarCosto, sistemaDe, tope, TURNOS } from './ia.mjs';
import { ghJson, git } from './proceso.mjs';
import { archivosDeDiff } from './verificar.mjs';

const PENDIENTES = new Set(['borrador', 'en_cola', 'en_curso', 'error']);
const HERRAMIENTAS = ['Read', 'Grep', 'Glob', 'Edit', 'Write'];
const SCHEMA = { type: 'object', properties: { resumen: { type: 'string' }, hecho: { type: 'boolean' } }, required: ['resumen', 'hecho'] };

// Todo lo que toca la copia de una PR va en serie: proponer, ajustar, aprobar y descartar comparten el worktree.
const series = new Map();
function enSerie(pr, fn) {
  const previa = series.get(pr.id) ?? Promise.resolve();
  const actual = previa.then(fn, fn);
  series.set(pr.id, actual.catch(() => {}));
  return actual;
}

const nuevoId = () => `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const rutaDe = (p, repo, numero, id) => join(rutaPropuestas(p.salida, repo, numero), `${id}.json`);

export function leerPropuestas(p, repo, numero) {
  const dir = rutaPropuestas(p.salida, repo, numero);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'estado.json')
    .map((f) => leerJson(join(dir, f))).sort((a, b) => a.creada.localeCompare(b.creada));
}

export const leerPropuesta = (p, repo, numero, id) => {
  if (!/^p-[a-z0-9]{4,32}$/.test(id ?? '')) throw new Error('Propuesta sin id válido');
  const prop = leerJson(rutaDe(p, repo, numero, id));
  if (!prop) throw Object.assign(new Error('La propuesta no existe'), { codigo: 404 });
  return prop;
};

function guardar(p, repo, numero, prop) {
  escribirJson(rutaDe(p, repo, numero, prop.id), prop);
  writeFileSync(rutaDe(p, repo, numero, prop.id).replace(/\.json$/, '.patch'), prop.patch ?? '');
  return prop;
}

const conFallos = (c) => !!(c.reglas.bloqueantes || c.tipos?.nuevosFallos.length || c.tests?.nuevosFallos.length || c.tipos?.omitido || c.tests?.omitido);

function textoFallos(c) {
  const partes = [];
  if (c.reglas.bloqueantes) partes.push(`Reglas bloqueantes:\n${c.reglas.hallazgos.filter((h) => h.severidad === 'bloqueante').map((h) => `- ${h.archivo}:${h.linea} ${h.titulo}: ${h.mensaje}`).join('\n')}`);
  if (c.tipos?.nuevosFallos.length) partes.push(`Errores de tipos nuevos:\n${c.tipos.nuevosFallos.join('\n')}`);
  if (c.tests?.nuevosFallos.length) partes.push(`Tests que fallan:\n${c.tests.nuevosFallos.join('\n')}\n${c.tests.salida.slice(-1500)}`);
  return partes.join('\n\n');
}

function lineamientos(p) {
  const dir = p.lineamientos ? expandir(p.lineamientos) : null;
  if (!dir || !existsSync(join(dir, 'SKILL.md'))) return null;
  const destilado = join(dir, 'destilado');
  const extras = existsSync(destilado) ? readdirSync(destilado).filter((f) => f.endsWith('.md')).sort().map((f) => readFileSync(join(destilado, f), 'utf8')) : [];
  return [readFileSync(join(dir, 'SKILL.md'), 'utf8'), ...extras].join('\n\n');
}

async function generar(p, pr, c, dir, { sistema, avisos, contexto, cuerpo, previa, indicacion }) {
  const modelo = elegirModelo({ tipo: 'cambiar', pr });
  const rango = c.desde === c.hasta ? `L${c.desde}` : `L${c.desde}–${c.hasta}`;
  const ctx = await contexto(p, { ...pr, cuerpo }, [c]);
  let prompt = `Pedido ${c.id} sobre ${c.archivo} ${rango}: ${c.texto}\n\n${ctx}`;
  if (previa) prompt += `\n\nPropuesta anterior (ya aplicada en la copia):\n${previa.patch}\n\nAjuste pedido: ${indicacion}`;
  const correr = (args) => ejecutarClaude(argsClaude({ modelo, sistema, schema: SCHEMA, tools: HERRAMIENTAS, tope: tope('cambiar'), turnos: TURNOS.cambiar, persistir: true, ...args }), { cwd: dir });
  let r = await correr({ prompt, sesion: previa?.sesion ?? undefined });
  let costo = r.costo ?? 0;
  registrarCosto(p, { tipo: 'cambiar', prId: pr.id, modelo: r.modelo ?? modelo, uso: r.uso, costo: r.costo, ok: r.ok });
  if (!r.ok) return { error: r.motivo, costo };
  let patch = await diffCopia(dir);
  if (!r.salida.hecho || !patch.trim()) return { error: r.salida.resumen || 'La IA no hizo cambios', costo };
  let comp = await comprobar(p, pr.repo, dir, patch, pr.headSha);
  if (conFallos(comp)) {
    const segunda = await correr({ prompt: `Las comprobaciones fallaron. Corregir sin ampliar el alcance del pedido.\n\n${textoFallos(comp)}`, sesion: r.sesion });
    costo += segunda.costo ?? 0;
    registrarCosto(p, { tipo: 'cambiar', prId: pr.id, modelo: segunda.modelo ?? modelo, uso: segunda.uso, costo: segunda.costo, ok: segunda.ok, reintento: true });
    if (segunda.ok) {
      r = { ...segunda, salida: segunda.salida.hecho ? segunda.salida : r.salida };
      patch = await diffCopia(dir);
      comp = await comprobar(p, pr.repo, dir, patch, pr.headSha);
    }
  }
  const archivos = archivosDeDiff(patch).map((a) => a.filename);
  return {
    propuesta: {
      id: nuevoId(), comentarioId: c.id, prId: pr.id, headSha: pr.headSha, patch, archivos,
      fueraDelComentario: archivos.filter((a) => a !== c.archivo),
      resumen: r.salida.resumen, comprobaciones: { ...comp, avisos }, conFallos: conFallos(comp),
      sesion: r.sesion, modelo: r.modelo ?? modelo, costo, estado: 'lista', creada: new Date().toISOString(),
    },
    costo,
  };
}

async function preparar(p, pr, deps) {
  const texto = lineamientos(p);
  const avisos = texto || !p.lineamientos ? [] : ['Lineamientos del proyecto no disponibles en esta máquina: la propuesta no los consideró.'];
  const sistema = [sistemaDe(p, 'base', 'cambiar'), ...(texto ? [`# Lineamientos del proyecto\n\n${texto}`] : avisos)].join('\n\n');
  const cuerpo = (await (deps.detalle ?? detallePr)(p, pr))?.body;
  const dir = await crearCopia(p, pr.repo, pr.numero, pr.headSha);
  await reiniciarCopia(dir, pr.headSha);
  return { sistema, avisos, cuerpo, dir, contexto: deps.contexto ?? contextoPreguntas };
}

const detallePr = (p, pr) => ghJson(['pr', 'view', String(pr.numero), '-R', `${p.owner}/${pr.repo}`, '--json', 'body']).catch(() => null);

export const proponerCambios = (...args) => enSerie(args[1], () => proponerCambiosSinSerie(...args));

async function proponerCambiosSinSerie(p, pr, ids, deps = {}) {
  const pedidos = new Set(ids);
  const lista = leerComentarios(p, pr.repo, pr.numero).filter((c) => c.tipo === 'cambio' && pedidos.has(c.id) && PENDIENTES.has(c.estado));
  const actualizar = (id, cambios) => actualizarComentario(p, pr.repo, pr.numero, id, cambios);
  if (!lista.length) return { ok: true, costo: 0 };
  if (pr.estadoPr !== 'OPEN') {
    for (const c of lista) actualizar(c.id, { estado: 'error', motivo: 'La PR ya no está abierta' });
    return { ok: false, motivo: 'La PR ya no está abierta' };
  }
  let ctx;
  try {
    ctx = await preparar(p, pr, deps);
  } catch (e) {
    for (const c of lista) actualizar(c.id, { estado: 'error', motivo: recortar(e.message) });
    throw e;
  }
  let costo = 0;
  let algunaOk = false;
  for (const c of lista) {
    actualizar(c.id, { estado: 'en_curso', motivo: null });
    try {
      const g = await generar(p, pr, c, ctx.dir, ctx);
      costo += g.costo;
      if (g.error) actualizar(c.id, { estado: 'error', motivo: g.error });
      else {
        guardar(p, pr.repo, pr.numero, g.propuesta);
        actualizar(c.id, { estado: 'propuesta', propuestaId: g.propuesta.id, motivo: null });
        algunaOk = true;
      }
    } catch (e) {
      actualizar(c.id, { estado: 'error', motivo: recortar(e.message) });
    } finally {
      await reiniciarCopia(ctx.dir, pr.headSha).catch(() => {});
    }
  }
  return { ok: algunaOk, motivo: algunaOk ? null : 'Ningún pedido generó propuesta', costo };
}

export const ajustarPropuesta = (...args) => enSerie(args[1], () => ajustarPropuestaSinSerie(...args));

async function ajustarPropuestaSinSerie(p, pr, propuestaId, indicacion, deps = {}) {
  const previa = leerPropuesta(p, pr.repo, pr.numero, propuestaId);
  if (previa.estado !== 'lista') throw new Error('Solo se ajusta una propuesta lista');
  if (pr.estadoPr !== 'OPEN') throw new Error('La PR ya no está abierta');
  const c = leerComentarios(p, pr.repo, pr.numero).find((x) => x.id === previa.comentarioId);
  const volver = (motivo) => actualizarComentario(p, pr.repo, pr.numero, c.id, { estado: 'propuesta', motivo: `El ajuste no se pudo hacer: ${recortar(motivo)}` });
  let ctx;
  try {
    ctx = await preparar(p, pr, deps);
    await aplicarParche(ctx.dir, previa.patch, false);
  } catch (e) {
    volver(e.message);
    throw e;
  }
  actualizarComentario(p, pr.repo, pr.numero, c.id, { estado: 'en_curso' });
  try {
    const g = await generar(p, pr, c, ctx.dir, { ...ctx, previa, indicacion });
    if (g.error) {
      volver(g.error);
      return { ok: false, motivo: g.error, costo: g.costo };
    }
    guardar(p, pr.repo, pr.numero, { ...previa, estado: 'descartada', reemplazadaPor: g.propuesta.id });
    guardar(p, pr.repo, pr.numero, g.propuesta);
    actualizarComentario(p, pr.repo, pr.numero, c.id, { estado: 'propuesta', propuestaId: g.propuesta.id, motivo: null });
    return { ok: true, costo: g.costo };
  } catch (e) {
    volver(e.message);
    throw e;
  } finally {
    await reiniciarCopia(ctx.dir, pr.headSha).catch(() => {});
  }
}

async function aplicarParche(dir, patch, index) {
  const tmp = mkdtempSync(join(tmpdir(), 'seki-prop-'));
  try {
    const archivo = join(tmp, 'cambio.diff');
    writeFileSync(archivo, patch);
    await git(dir, ['apply', '--whitespace=nowarn', ...(index ? ['--index'] : []), archivo]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const recortar = (s, n = 400) => String(s ?? '').trim().slice(0, n);
const MENSAJE_POR_DEFECTO = 'Ajuste pedido en la revisión de la PR';

// La rama solo puede haber avanzado con commits que subió el tablero desde el commit de la propuesta.
function soloCommitsDelTablero(cabeza, desde, cadena) {
  const base = new Map(cadena.map((x) => [x.commit, x.base]));
  let actual = cabeza;
  for (let i = 0; i <= cadena.length; i++) {
    if (actual === desde) return true;
    if (!base.has(actual)) return false;
    actual = base.get(actual);
  }
  return false;
}

export const aprobar = (...args) => enSerie(args[1], () => aprobarSinSerie(...args));

async function aprobarSinSerie(p, pr, propuestaId, { confirmarFallos = false } = {}) {
  const prop = leerPropuesta(p, pr.repo, pr.numero, propuestaId);
  if (prop.estado !== 'lista') return { ok: false, motivo: 'La propuesta ya no está lista para aprobar' };
  if (prop.conFallos && !confirmarFallos) return { ok: false, motivo: 'requiere_confirmacion' };
  const marcar = (estado, extra = {}) => guardar(p, pr.repo, pr.numero, { ...prop, estado, ...extra });
  const estadoRuta = join(rutaPropuestas(p.salida, pr.repo, pr.numero), 'estado.json');
  const subido = leerJson(estadoRuta, {});
  const remoto = await ghJson(['pr', 'view', String(pr.numero), '-R', `${p.owner}/${pr.repo}`, '--json', 'state,headRefName,headRefOid,isCrossRepository']);
  if (remoto.state !== 'OPEN') { marcar('conflicto', { motivo: 'La PR ya no está abierta' }); return { ok: false, motivo: 'La PR ya no está abierta' }; }
  // En una PR desde un fork, origin/<rama> es otra rama del repositorio base.
  if (remoto.isCrossRepository) {
    const motivo = 'La PR viene de un fork: el parche se aplica a mano en la rama del fork';
    marcar('rechazada', { motivo });
    return { ok: false, motivo, parche: prop.patch };
  }
  let cadena = Array.isArray(subido.cadena) ? subido.cadena : [];
  // Un push que llegó a GitHub sin que se alcanzara a guardar el resultado (proceso cortado, tiempo agotado) se
  // reconoce por su commit y se da por aprobado, en vez de volver a subirlo.
  const pendiente = subido.pendiente;
  if (pendiente && remoto.headRefOid === pendiente.commit) {
    cadena = cerrarAprobacion(p, pr, estadoRuta, remoto.headRefName, cadena, pendiente);
    if (pendiente.propuestaId === propuestaId) return { ok: true, commit: pendiente.commit, reconciliada: true };
  }
  if (!soloCommitsDelTablero(remoto.headRefOid, prop.headSha, cadena)) {
    marcar('conflicto', { motivo: 'La rama cambió desde que se generó la propuesta' });
    return { ok: false, motivo: 'La rama cambió desde que se generó la propuesta' };
  }
  const dir = await crearCopia(p, pr.repo, pr.numero, remoto.headRefOid);
  await reiniciarCopia(dir, remoto.headRefOid);
  try {
    await aplicarParche(dir, prop.patch, true);
  } catch (e) {
    await reiniciarCopia(dir, remoto.headRefOid);
    marcar('conflicto', { motivo: 'La propuesta no aplica sobre la rama actual' });
    return { ok: false, motivo: 'La propuesta no aplica sobre la rama actual' };
  }
  try {
    await git(dir, ['commit', '-q', '--no-verify', '-m', recortar(prop.resumen, 200) || MENSAJE_POR_DEFECTO]);
  } catch (e) {
    await reiniciarCopia(dir, remoto.headRefOid);
    const motivo = recortar(e.stderr || e.message);
    marcar('rechazada', { motivo });
    return { ok: false, motivo, parche: prop.patch };
  }
  const commit = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  const intento = { propuestaId, base: remoto.headRefOid, commit };
  mkdirSync(rutaPropuestas(p.salida, pr.repo, pr.numero), { recursive: true });
  escribirJson(estadoRuta, { rama: remoto.headRefName, cadena, pendiente: intento });
  try {
    await git(dir, ['push', '-q', 'origin', `HEAD:refs/heads/${remoto.headRefName}`]);
  } catch (e) {
    // Un error del push no prueba que no llegó: se mira la rama remota antes de darlo por rechazado.
    const remota = await git(dir, ['ls-remote', 'origin', `refs/heads/${remoto.headRefName}`]).catch(() => '');
    if (!remota.startsWith(commit)) {
      escribirJson(estadoRuta, { rama: remoto.headRefName, cadena });
      await reiniciarCopia(dir, remoto.headRefOid);
      const motivo = recortar(e.stderr || e.message);
      marcar('rechazada', { motivo });
      return { ok: false, motivo, parche: prop.patch };
    }
  }
  cerrarAprobacion(p, pr, estadoRuta, remoto.headRefName, cadena, intento);
  return { ok: true, commit };
}

function cerrarAprobacion(p, pr, estadoRuta, rama, cadena, { propuestaId, base, commit }) {
  const nueva = [...cadena, { base, commit }].slice(-50);
  escribirJson(estadoRuta, { rama, cadena: nueva });
  const prop = leerPropuesta(p, pr.repo, pr.numero, propuestaId);
  guardar(p, pr.repo, pr.numero, { ...prop, estado: 'aprobada', commit, aprobada: new Date().toISOString() });
  actualizarComentario(p, pr.repo, pr.numero, prop.comentarioId, { estado: 'aprobado', commit });
  return nueva;
}

export const descartar = (...args) => enSerie(args[1], () => descartarSinSerie(...args));

async function descartarSinSerie(p, pr, propuestaId) {
  const prop = leerPropuesta(p, pr.repo, pr.numero, propuestaId);
  if (prop.estado === 'aprobada') throw new Error('Una propuesta aprobada ya está en la rama: no se descarta');
  guardar(p, pr.repo, pr.numero, { ...prop, estado: 'descartada' });
  actualizarComentario(p, pr.repo, pr.numero, prop.comentarioId, { estado: 'descartado' });
  if (!leerPropuestas(p, pr.repo, pr.numero).some((x) => x.estado === 'lista')) await borrarCopia(p, pr.repo, pr.numero);
  return { ok: true };
}
