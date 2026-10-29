// Change requests: the AI works on the PR's copy, the server checks the result and saves it as a
// proposal. Only Approve takes it to the branch, and only if the branch is still where it was when it was generated.
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
import { contarHerramienta, fijarAvance, quitarAvance } from './avance.mjs';

const PENDIENTES = new Set(['borrador', 'en_cola', 'en_curso', 'error']);
const HERRAMIENTAS = ['Read', 'Grep', 'Glob', 'Edit', 'Write'];
const SCHEMA = { type: 'object', properties: { resumen: { type: 'string' }, hecho: { type: 'boolean' } }, required: ['resumen', 'hecho'] };

// Everything that touches a PR's copy runs serially: propose, adjust, approve and discard share the worktree.
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
  if (!/^p-[a-z0-9]{4,32}$/.test(id ?? '')) throw new Error('Proposal without a valid id');
  const prop = leerJson(rutaDe(p, repo, numero, id));
  if (!prop) throw Object.assign(new Error('The proposal does not exist'), { codigo: 404 });
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
  if (c.reglas.bloqueantes) partes.push(`Blocking rules:\n${c.reglas.hallazgos.filter((h) => h.severidad === 'bloqueante').map((h) => `- ${h.archivo}:${h.linea} ${h.titulo}: ${h.mensaje}`).join('\n')}`);
  if (c.tipos?.nuevosFallos.length) partes.push(`New type errors:\n${c.tipos.nuevosFallos.join('\n')}`);
  if (c.tests?.nuevosFallos.length) partes.push(`Failing tests:\n${c.tests.nuevosFallos.join('\n')}\n${c.tests.salida.slice(-1500)}`);
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
  let prompt = `Request ${c.id} on ${c.archivo} ${rango}: ${c.texto}\n\n${ctx}`;
  if (previa) prompt += `\n\nPrevious proposal (already applied to the copy):\n${previa.patch}\n\nRequested adjustment: ${indicacion}`;
  const clave = `c:${c.id}`;
  const correr = (args) => ejecutarClaude(argsClaude({ modelo, sistema, schema: SCHEMA, tools: HERRAMIENTAS, tope: tope('cambiar'), turnos: TURNOS.cambiar, persistir: true, traza: true, ...args }), { cwd: dir, alUsar: (h) => contarHerramienta(clave, h, dir) });
  fijarAvance(clave, { fase: 'editando' });
  let r = await correr({ prompt, sesion: previa?.sesion ?? undefined });
  let costo = r.costo ?? 0;
  registrarCosto(p, { tipo: 'cambiar', prId: pr.id, modelo: r.modelo ?? modelo, uso: r.uso, costo: r.costo, ok: r.ok });
  if (!r.ok) return { error: r.motivo, costo };
  let patch = await diffCopia(dir);
  if (!r.salida.hecho || !patch.trim()) return { error: r.salida.resumen || 'The AI made no changes', costo };
  fijarAvance(clave, { fase: 'comprobando' });
  let comp = await comprobar(p, pr.repo, dir, patch, pr.headSha);
  if (conFallos(comp)) {
    fijarAvance(clave, { fase: 'corrigiendo', corrigio: true });
    const segunda = await correr({ prompt: `The checks failed. Fix them without widening the scope of the request.\n\n${textoFallos(comp)}`, sesion: r.sesion });
    costo += segunda.costo ?? 0;
    registrarCosto(p, { tipo: 'cambiar', prId: pr.id, modelo: segunda.modelo ?? modelo, uso: segunda.uso, costo: segunda.costo, ok: segunda.ok, reintento: true });
    if (segunda.ok) {
      r = { ...segunda, salida: segunda.salida.hecho ? segunda.salida : r.salida };
      patch = await diffCopia(dir);
      fijarAvance(clave, { fase: 'recomprobando' });
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
  const avisos = texto || !p.lineamientos ? [] : ['Project guidelines are not available on this machine: the proposal did not take them into account.'];
  const sistema = [sistemaDe(p, 'base', 'cambiar'), ...(texto ? [`# Project guidelines\n\n${texto}`] : avisos)].join('\n\n');
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
    for (const c of lista) actualizar(c.id, { estado: 'error', motivo: 'The PR is no longer open' });
    return { ok: false, motivo: 'The PR is no longer open' };
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
      quitarAvance(`c:${c.id}`);
      await reiniciarCopia(ctx.dir, pr.headSha).catch(() => {});
    }
  }
  return { ok: algunaOk, motivo: algunaOk ? null : 'No request produced a proposal', costo };
}

export const ajustarPropuesta = (...args) => enSerie(args[1], () => ajustarPropuestaSinSerie(...args));

async function ajustarPropuestaSinSerie(p, pr, propuestaId, indicacion, deps = {}) {
  const previa = leerPropuesta(p, pr.repo, pr.numero, propuestaId);
  if (previa.estado !== 'lista') throw new Error('Only a ready proposal can be adjusted');
  if (pr.estadoPr !== 'OPEN') throw new Error('The PR is no longer open');
  const c = leerComentarios(p, pr.repo, pr.numero).find((x) => x.id === previa.comentarioId);
  const volver = (motivo) => actualizarComentario(p, pr.repo, pr.numero, c.id, { estado: 'propuesta', motivo: `The adjustment could not be made: ${recortar(motivo)}` });
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
    quitarAvance(`c:${c.id}`);
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
const MENSAJE_POR_DEFECTO = 'Change requested in the PR review';

// The branch may only have advanced with commits the dashboard pushed since the proposal's commit.
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
  if (prop.estado !== 'lista') return { ok: false, motivo: 'The proposal is no longer ready to approve' };
  if (prop.conFallos && !confirmarFallos) return { ok: false, motivo: 'requiere_confirmacion' };
  const marcar = (estado, extra = {}) => guardar(p, pr.repo, pr.numero, { ...prop, estado, ...extra });
  const estadoRuta = join(rutaPropuestas(p.salida, pr.repo, pr.numero), 'estado.json');
  const subido = leerJson(estadoRuta, {});
  const remoto = await ghJson(['pr', 'view', String(pr.numero), '-R', `${p.owner}/${pr.repo}`, '--json', 'state,headRefName,headRefOid,isCrossRepository']);
  if (remoto.state !== 'OPEN') { marcar('conflicto', { motivo: 'The PR is no longer open' }); return { ok: false, motivo: 'The PR is no longer open' }; }
  // In a PR from a fork, origin/<branch> is a different branch of the base repository.
  if (remoto.isCrossRepository) {
    const motivo = 'The PR comes from a fork: apply the patch manually on the fork branch';
    marcar('rechazada', { motivo });
    return { ok: false, motivo, parche: prop.patch };
  }
  let cadena = Array.isArray(subido.cadena) ? subido.cadena : [];
  // A push that reached GitHub before the result could be saved (process killed, timeout) is
  // recognized by its commit and treated as approved, instead of being pushed again.
  const pendiente = subido.pendiente;
  if (pendiente && remoto.headRefOid === pendiente.commit) {
    cadena = cerrarAprobacion(p, pr, estadoRuta, remoto.headRefName, cadena, pendiente);
    if (pendiente.propuestaId === propuestaId) return { ok: true, commit: pendiente.commit, reconciliada: true };
  }
  if (!soloCommitsDelTablero(remoto.headRefOid, prop.headSha, cadena)) {
    marcar('conflicto', { motivo: 'The branch changed since the proposal was generated' });
    return { ok: false, motivo: 'The branch changed since the proposal was generated' };
  }
  const dir = await crearCopia(p, pr.repo, pr.numero, remoto.headRefOid);
  await reiniciarCopia(dir, remoto.headRefOid);
  try {
    await aplicarParche(dir, prop.patch, true);
  } catch (e) {
    await reiniciarCopia(dir, remoto.headRefOid);
    marcar('conflicto', { motivo: 'The proposal does not apply on the current branch' });
    return { ok: false, motivo: 'The proposal does not apply on the current branch' };
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
    // A push error does not prove it did not land: check the remote branch before treating it as rejected.
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
  if (prop.estado === 'aprobada') throw new Error('An approved proposal is already on the branch: it cannot be discarded');
  guardar(p, pr.repo, pr.numero, { ...prop, estado: 'descartada' });
  actualizarComentario(p, pr.repo, pr.numero, prop.comentarioId, { estado: 'descartado' });
  if (!leerPropuestas(p, pr.repo, pr.numero).some((x) => x.estado === 'lista')) await borrarCopia(p, pr.repo, pr.numero);
  return { ok: true };
}
