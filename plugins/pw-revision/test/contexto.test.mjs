import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archivoEnSha, contextoPreguntas, fragmento } from '../mcp/lib/contexto.mjs';
import { repoConPr } from './util/repo.mjs';

const lineas = (n, f = (i) => `linea ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';

test('fragmento recorta con margen y numera', () => {
  const f = fragmento(lineas(200), 100, 101, 2);
  assert.equal(f.desde, 98);
  assert.equal(f.hasta, 103);
  assert.equal(f.texto.split('\n')[0], '   98│ linea 98');
  assert.equal(f.texto.split('\n').length, 6);
});

test('fragmento no se sale del archivo', () => {
  const f = fragmento(lineas(5), 1, 2, 40);
  assert.equal(f.desde, 1);
  assert.equal(f.hasta, 5);
});

test('archivoEnSha trae la versión de la PR aunque el checkout no tenga el commit', async () => {
  const r = repoConPr({ antes: 'a\n', despues: 'b\n' });
  const p = { repos: { x: { checkout: r.checkout } } };
  assert.equal(await archivoEnSha(p, 'x', 7, r.head, 'a.ts'), 'b\n');
});

test('contextoPreguntas incluye el hunk y el fragmento de cada comentario', async () => {
  const antes = lineas(600);
  const despues = lineas(600, (i) => (i === 60 ? 'linea 60 cambiada' : `linea ${i}`));
  const r = repoConPr({ antes, despues });
  const p = { repos: { x: { checkout: r.checkout } } };
  const pr = { id: 'x#7', repo: 'x', numero: 7, titulo: 'Cambio', headSha: r.head, explicacion: { resumen: 'Cambia la línea 60.' } };
  const archivos = [{ filename: 'a.ts', patch: '@@ -57,7 +57,7 @@\n linea 57\n linea 58\n linea 59\n-linea 60\n+linea 60 cambiada\n linea 61\n linea 62\n linea 63' }];
  const t = await contextoPreguntas(p, pr, [{ id: 'c-0001', tipo: 'pregunta', archivo: 'a.ts', lado: 'nuevo', desde: 60, hasta: 60, texto: '¿Por qué?' }], { archivos });
  assert.match(t, /c-0001/);
  assert.match(t, /\+linea 60 cambiada/);
  assert.match(t, / {3}60│ linea 60 cambiada/);
  assert.match(t, / {3}20│ linea 20/);
  assert.doesNotMatch(t, / {3}19│/);
  assert.match(t, /Cambia la línea 60\./);
});

test('contextoPreguntas manda el archivo completo si es corto', async () => {
  const r = repoConPr({ antes: lineas(300), despues: lineas(300, (i) => (i === 200 ? 'nueva' : `linea ${i}`)) });
  const p = { repos: { x: { checkout: r.checkout } } };
  const pr = { id: 'x#7', repo: 'x', numero: 7, titulo: 'Cambio', headSha: r.head };
  const t = await contextoPreguntas(p, pr, [{ id: 'c-0001', tipo: 'pregunta', archivo: 'a.ts', lado: 'nuevo', desde: 200, hasta: 200, texto: '¿?' }], { archivos: [{ filename: 'a.ts', patch: '@@ -200 +200 @@\n-linea 200\n+nueva' }] });
  assert.match(t, / {4}1│ linea 1\n/);
  assert.match(t, /300│ linea 300/);
});

test('contextoPreguntas respeta el tope de 60000 caracteres', async () => {
  const enorme = lineas(3000, (i) => `${'x'.repeat(80)} ${i}`);
  const r = repoConPr({ antes: 'a\n', despues: enorme });
  const p = { repos: { x: { checkout: r.checkout } } };
  const pr = { id: 'x#7', repo: 'x', numero: 7, titulo: 'Cambio', headSha: r.head, cuerpo: 'y'.repeat(50000) };
  const patch = '@@ -1 +1,3000 @@\n-a\n' + enorme.trimEnd().split('\n').map((l) => `+${l}`).join('\n');
  const coms = Array.from({ length: 6 }, (_, i) => ({ id: `c-000${i}`, tipo: 'pregunta', archivo: 'a.ts', lado: 'nuevo', desde: 1 + i * 400, hasta: 300 + i * 400, texto: '¿Qué hace?' }));
  const t = await contextoPreguntas(p, pr, coms, { archivos: [{ filename: 'a.ts', patch }] });
  assert.ok(t.length <= 60000, String(t.length));
  for (const c of coms) assert.match(t, new RegExp(c.id));
});
