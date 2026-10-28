import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardarComentarios, leerComentarios } from '../mcp/lib/comentarios.mjs';
import { consultasDe, investigarPregunta, responderPreguntas } from '../mcp/lib/preguntas.mjs';
import { falsoClaude, llamadas } from './util/claude.mjs';

const pr = { id: 'r#1', repo: 'r', numero: 1, titulo: 'T', headSha: 'abc', adiciones: 10, eliminaciones: 0, esfuerzoTamano: 1 };
const preg = (id, texto) => ({ id, tipo: 'pregunta', estado: 'borrador', archivo: 'a.ts', lado: 'nuevo', desde: 1, hasta: 2, textoOriginal: 'x', texto, headSha: 'abc' });
const deps = { contexto: async () => 'CONTEXTO', detalle: async () => null };
const exito = (respuestas) => ({ type: 'result', is_error: false, subtype: 'success', structured_output: { respuestas }, total_cost_usd: 0.001, modelUsage: { 'claude-haiku-5-5': { inputTokens: 1, outputTokens: 1 } } });

function preparar() {
  const p = { salida: mkdtempSync(join(tmpdir(), 'seki-preg-')) };
  guardarComentarios(p, 'r', 1, [preg('c-0001', '¿Qué hace?'), preg('c-0002', '¿Por qué?')]);
  return p;
}

test('responde dos preguntas en una sola llamada', async () => {
  const p = preparar();
  process.env.SEKI_CLAUDE = falsoClaude(exito([{ id: 'c-0001', texto: 'Hace A.' }, { id: 'c-0002', texto: 'Por B.' }]));
  const r = await responderPreguntas(p, pr, ['c-0001', 'c-0002'], deps);
  assert.equal(r.ok, true);
  assert.equal(llamadas(process.env.SEKI_CLAUDE), 1);
  const cs = leerComentarios(p, 'r', 1);
  assert.deepEqual(cs.map((c) => [c.estado, c.respuesta]), [['respondido', 'Hace A.'], ['respondido', 'Por B.']]);
  assert.equal(cs[0].modelo, 'claude-haiku-5-5');
});

test('segunda vez usa la caché sin llamar a claude', async () => {
  const p = preparar();
  process.env.SEKI_CLAUDE = falsoClaude(exito([{ id: 'c-0001', texto: 'Hace A.' }, { id: 'c-0002', texto: 'Por B.' }]));
  await responderPreguntas(p, pr, ['c-0001', 'c-0002'], deps);
  guardarComentarios(p, 'r', 1, [{ ...preg('c-0003', '¿Qué hace?') }]);
  const r = await responderPreguntas(p, pr, ['c-0003'], deps);
  assert.equal(llamadas(process.env.SEKI_CLAUDE), 1);
  assert.equal(r.costo, 0);
  const c = leerComentarios(p, 'r', 1).find((x) => x.id === 'c-0003');
  assert.equal(c.estado, 'respondido');
  assert.equal(c.respuesta, 'Hace A.');
  assert.equal(c.desdeCache, true);
});

test('respuesta faltante deja solo esa pregunta en error', async () => {
  const p = preparar();
  process.env.SEKI_CLAUDE = falsoClaude(exito([{ id: 'c-0001', texto: 'Hace A.' }]));
  await responderPreguntas(p, pr, ['c-0001', 'c-0002'], deps);
  const cs = leerComentarios(p, 'r', 1);
  assert.equal(cs[0].estado, 'respondido');
  assert.equal(cs[1].estado, 'error');
  assert.match(cs[1].motivo, /no devolvió respuesta/);
});

test('tope alcanzado deja el lote en error con motivo', async () => {
  const p = preparar();
  process.env.SEKI_CLAUDE = falsoClaude({ type: 'result', is_error: true, subtype: 'error_max_budget_usd', total_cost_usd: 1 }, 1);
  const r = await responderPreguntas(p, pr, ['c-0001', 'c-0002'], deps);
  assert.equal(r.ok, false);
  for (const c of leerComentarios(p, 'r', 1)) {
    assert.equal(c.estado, 'error');
    assert.equal(c.motivo, 'Se alcanzó el tope de costo del trabajo');
  }
});

test('ignora ids que no son preguntas o que ya están respondidos', async () => {
  const p = preparar();
  guardarComentarios(p, 'r', 1, [{ ...preg('c-0004', 'nota'), tipo: 'nota', estado: 'nota' }]);
  process.env.SEKI_CLAUDE = falsoClaude(exito([]));
  const r = await responderPreguntas(p, pr, ['c-0004'], deps);
  assert.equal(r.ok, true);
  assert.equal(llamadas(process.env.SEKI_CLAUDE), 0);
});

test('si el contexto falla las preguntas quedan en error y no en curso', async () => {
  const p = preparar();
  process.env.SEKI_CLAUDE = falsoClaude(exito([]));
  await assert.rejects(() => responderPreguntas(p, pr, ['c-0001', 'c-0002'], { ...deps, contexto: async () => { throw new Error('sin red'); } }));
  for (const c of leerComentarios(p, 'r', 1)) {
    assert.equal(c.estado, 'error');
    assert.equal(c.motivo, 'sin red');
  }
});

test('la respuesta rápida marca cuando hace falta revisar el código', async () => {
  const p = preparar();
  process.env.SEKI_CLAUDE = falsoClaude(exito([{ id: 'c-0001', texto: 'No se puede con el diff.', necesitaCodigo: true }, { id: 'c-0002', texto: 'Por B.' }]));
  await responderPreguntas(p, pr, ['c-0001', 'c-0002'], deps);
  const [a, b] = leerComentarios(p, 'r', 1);
  assert.equal(a.necesitaCodigo, true);
  assert.equal(b.necesitaCodigo, undefined);
});

test('investigar lee el repositorio en una copia de la PR, nunca el checkout del usuario, y no los secretos', async () => {
  const { repoConPr } = await import('./util/repo.mjs');
  const { mkdirSync, readFileSync } = await import('node:fs');
  const r = repoConPr({ antes: 'a\n', despues: 'b\n' });
  const otro = mkdtempSync(join(tmpdir(), 'seki-otro-'));
  const salida = mkdtempSync(join(tmpdir(), 'seki-inv-'));
  const p = { salida, copias: join(salida, 'copias'), repos: { x: { checkout: r.checkout }, y: { checkout: otro } } };
  const prx = { ...pr, id: 'x#7', repo: 'x', numero: 7, headSha: r.head, seguridad: false };
  guardarComentarios(p, 'x', 7, [{ id: 'c-0001', tipo: 'pregunta', estado: 'borrador', ambito: 'pr', texto: '¿Quién llama esta ruta?', headSha: r.head }]);
  const rastro = join(salida, 'rastro');
  process.env.SEKI_CLAUDE = falsoClaude({ ...exito([]), structured_output: { texto: 'La llama X en y/z.ts L4.' } }, 0, `pwd > "${rastro}.cwd"; git rev-parse HEAD > "${rastro}.head"; printf '%s\\n' "$@" > "${rastro}.args"`);
  const res = await investigarPregunta(p, prx, 'c-0001', deps);
  assert.equal(res.ok, true);
  const [c] = leerComentarios(p, 'x', 7);
  assert.deepEqual([c.estado, c.respuesta, c.investigado], ['respondido', 'La llama X en y/z.ts L4.', true]);
  assert.equal(readFileSync(`${rastro}.head`, 'utf8').trim(), r.head);
  assert.notEqual(readFileSync(`${rastro}.cwd`, 'utf8').trim(), r.checkout);
  const args = readFileSync(`${rastro}.args`, 'utf8').split('\n');
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.ok(!args.includes(otro));
  assert.ok(args.some((x) => x.startsWith('Read(/') && x.endsWith('/**/*.env)')));
  assert.ok(!args.includes('--json-schema') || args[args.indexOf('--json-schema') + 1].includes('texto'));
});

test('investigar lee los otros repos en la rama equivalente y deja registrado qué leyó', async () => {
  const { repoConPr } = await import('./util/repo.mjs');
  const { readFileSync } = await import('node:fs');
  const a = repoConPr({ antes: 'a\n', despues: 'b\n', rama: 'fix/a' });
  const b = repoConPr({ antes: 'c\n', despues: 'd\n', rama: 'b-pruebas' });
  const salida = mkdtempSync(join(tmpdir(), 'seki-inv2-'));
  const p = { salida, copias: join(salida, 'copias'), repos: {
    a: { checkout: a.checkout, lineas: [{ portal: 'A', prod: 'main', pruebas: 'a-pruebas' }] },
    b: { checkout: b.checkout, lineas: [{ portal: 'B', prod: 'b-prod', pruebas: 'b-pruebas' }] },
  } };
  const prx = { ...pr, id: 'a#7', repo: 'a', numero: 7, base: 'a-pruebas', headSha: a.head };
  guardarComentarios(p, 'a', 7, [{ id: 'c-0001', tipo: 'pregunta', estado: 'borrador', ambito: 'pr', texto: '¿Quién llama?', headSha: a.head }]);
  const rastro = join(salida, 'rastro');
  process.env.SEKI_CLAUDE = falsoClaude({ ...exito([]), structured_output: { texto: 'Nadie.' } }, 0, `printf '%s\\n' "$@" > "${rastro}.args"`);
  await investigarPregunta(p, prx, 'c-0001', deps);
  const [c] = leerComentarios(p, 'a', 7);
  assert.deepEqual(c.leido, [{ repo: 'a', rama: 'PR #7', sha: a.head }, { repo: 'b', portal: 'B', rama: 'b-pruebas', sha: b.head }]);
  const args = readFileSync(`${rastro}.args`, 'utf8').split('\n');
  assert.ok(!args.includes(b.checkout));
  assert.ok(args.some((x) => x.includes('b-pruebas')));
});

test('investigar guarda los archivos leídos, las búsquedas y lo que bloquearon los permisos', async () => {
  const { repoConPr } = await import('./util/repo.mjs');
  const r = repoConPr({ antes: 'a\n', despues: 'b\n' });
  const salida = mkdtempSync(join(tmpdir(), 'seki-inv3-'));
  const p = { salida, copias: join(salida, 'copias'), repos: { x: { checkout: r.checkout } } };
  const prx = { ...pr, id: 'x#7', repo: 'x', numero: 7, headSha: r.head, seguridad: false };
  guardarComentarios(p, 'x', 7, [{ id: 'c-0001', tipo: 'pregunta', estado: 'borrador', ambito: 'pr', texto: '¿Quién llama?', headSha: r.head }]);
  const uso = (nombre, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: nombre, input }] } });
  const script = `printf '%s\\n' '${uso('Grep', { pattern: 'llamar' })}'; printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"%s/a.ts","offset":10,"limit":20}}]}}\\n' "$PWD"`;
  process.env.SEKI_CLAUDE = falsoClaude({ ...exito([]), structured_output: { texto: 'Nadie.' }, permission_denials: [{ tool_name: 'Read', tool_input: { file_path: '/x/.env' } }] }, 0, script);
  await investigarPregunta(p, prx, 'c-0001', deps);
  const [c] = leerComentarios(p, 'x', 7);
  assert.deepEqual(c.consultado, { archivos: [{ repo: 'x', ruta: 'a.ts', desde: 10, hasta: 29 }], busquedas: [{ herramienta: 'Grep', patron: 'llamar' }] });
  assert.deepEqual(c.bloqueadas, [{ herramienta: 'Read', ruta: '/x/.env' }]);
});

test('consultasDe ubica cada ruta en su repo y deja sin repo lo que está fuera', () => {
  const res = consultasDe([
    { nombre: 'Read', entrada: { file_path: '/c/pr/src/a.ts' } },
    { nombre: 'Read', entrada: { file_path: '/c/otro/b.ts', offset: 5, limit: 3 } },
    { nombre: 'Read', entrada: { file_path: 'rel.ts' } },
    { nombre: 'Read', entrada: { file_path: '/fuera/z.ts' } },
    { nombre: 'Read', entrada: { file_path: '/c/pr/src/a.ts' } },
    { nombre: 'Glob', entrada: { pattern: '**/*.ts', path: '/c/otro' } },
  ], [{ repo: 'pr', dir: '/c/pr' }, { repo: 'otro (B)', dir: '/c/otro' }]);
  assert.deepEqual(res.archivos, [
    { repo: 'pr', ruta: 'src/a.ts' }, { repo: 'otro (B)', ruta: 'b.ts', desde: 5, hasta: 7 }, { repo: 'pr', ruta: 'rel.ts' }, { repo: null, ruta: '/fuera/z.ts' },
  ]);
  assert.deepEqual(res.busquedas, [{ herramienta: 'Glob', patron: '**/*.ts', repo: 'otro (B)', ruta: '.' }]);
});
