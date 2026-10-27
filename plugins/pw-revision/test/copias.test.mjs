import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { borrarCopia, crearCopia, diffCopia, reiniciarCopia } from '../mcp/lib/copias.mjs';
import { repoConPr, sh } from './util/repo.mjs';

function preparar() {
  const r = repoConPr({ antes: 'a\n', despues: 'b\n' });
  mkdirSync(join(r.checkout, 'node_modules'));
  const p = { salida: mkdtempSync(join(tmpdir(), 'pw-sal-')), repos: { x: { checkout: r.checkout } } };
  return { r, p };
}

test('crearCopia crea worktree desacoplado en el sha y excluye node_modules', async () => {
  const { r, p } = preparar();
  const dir = await crearCopia(p, 'x', 7, r.head);
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), r.head);
  assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
  assert.equal(readFileSync(join(dir, 'a.ts'), 'utf8'), 'b\n');
  assert.ok(existsSync(join(dir, 'node_modules')));
  assert.equal(sh(dir, 'status', '--porcelain'), '');
  assert.match(sh(r.checkout, 'worktree', 'list'), /\(detached HEAD\)/);
});

test('crearCopia reutiliza la copia existente', async () => {
  const { r, p } = preparar();
  const a = await crearCopia(p, 'x', 7, r.head);
  writeFileSync(join(a, 'a.ts'), 'tocado\n');
  const b = await crearCopia(p, 'x', 7, r.head);
  assert.equal(a, b);
  assert.equal(readFileSync(join(b, 'a.ts'), 'utf8'), 'tocado\n');
});

test('diffCopia incluye archivos nuevos y reiniciarCopia los quita', async () => {
  const { r, p } = preparar();
  const dir = await crearCopia(p, 'x', 7, r.head);
  writeFileSync(join(dir, 'nuevo.ts'), 'export const x = 1;\n');
  writeFileSync(join(dir, 'a.ts'), 'c\n');
  const d = await diffCopia(dir);
  assert.match(d, /\+\+\+ b\/nuevo\.ts/);
  assert.match(d, /-b\n\+c/);
  assert.doesNotMatch(d, /node_modules/);
  await reiniciarCopia(dir, r.head);
  assert.equal(await diffCopia(dir), '');
  assert.ok(existsSync(join(dir, 'node_modules')));
});

test('borrarCopia quita el worktree', async () => {
  const { r, p } = preparar();
  const dir = await crearCopia(p, 'x', 7, r.head);
  await borrarCopia(p, 'x', 7);
  assert.equal(existsSync(dir), false);
  assert.doesNotMatch(sh(r.checkout, 'worktree', 'list'), /detached/);
});
