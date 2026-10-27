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

test('borrarCopia no poda worktrees ajenos cuyo directorio falta', async () => {
  const { r, p } = preparar();
  const ajeno = join(r.raiz, 'ajeno');
  sh(r.checkout, 'worktree', 'add', '-q', '--detach', ajeno);
  const { rmSync } = await import('node:fs');
  rmSync(ajeno, { recursive: true, force: true });
  await crearCopia(p, 'x', 7, r.head);
  await borrarCopia(p, 'x', 7);
  assert.match(sh(r.checkout, 'worktree', 'list', '--porcelain'), /ajeno/);
});

test('reiniciarCopia se niega a operar fuera de la raíz de un worktree', async () => {
  const { r } = preparar();
  const sub = join(r.checkout, 'sub');
  mkdirSync(sub);
  writeFileSync(join(r.checkout, 'sin-guardar.txt'), 'x');
  await assert.rejects(() => reiniciarCopia(sub, r.head), /raíz/);
  assert.ok(existsSync(join(r.checkout, 'sin-guardar.txt')));
});

test('ramasEquivalentes: una PR a pruebas lee los otros repos en sus ramas de pruebas, cada portal del front', async () => {
  const { ramasEquivalentes } = await import('../mcp/lib/copias.mjs');
  const p = { repos: {
    back: { lineas: [{ portal: 'Back', prod: 'demo', pruebas: 'develop' }] },
    front: { lineas: [{ portal: 'Admin', prod: 'ba', pruebas: 'ba-pruebas' }, { portal: 'Tienda', prod: 'mp', pruebas: 'mp-pruebas' }] },
  } };
  assert.deepEqual(ramasEquivalentes(p, { repo: 'back', base: 'develop' }), { ambiente: 'pruebas', ramas: [{ repo: 'front', portal: 'Admin', rama: 'ba-pruebas' }, { repo: 'front', portal: 'Tienda', rama: 'mp-pruebas' }] });
  assert.equal(ramasEquivalentes(p, { repo: 'front', base: 'mp' }).ramas[0].rama, 'demo');
});

test('copiaDeRama trae la rama fresca del remoto sin tocar ramas ni refs del checkout', async () => {
  const { copiaDeRama } = await import('../mcp/lib/copias.mjs');
  const { r, p } = preparar();
  const antes = sh(r.checkout, 'for-each-ref', '--format=%(refname)');
  const ramaActual = sh(r.checkout, 'branch', '--show-current');
  const c = await copiaDeRama(p, 'x', r.rama);
  assert.equal(c.sha, r.head);
  assert.equal(sh(c.dir, 'rev-parse', 'HEAD'), r.head);
  assert.equal(sh(r.checkout, 'for-each-ref', '--format=%(refname)'), antes);
  assert.equal(sh(r.checkout, 'branch', '--show-current'), ramaActual);
  const otra = await copiaDeRama(p, 'x', r.rama);
  assert.equal(otra.dir, c.dir);
});

test('limpiarCopias borra las de PRs cerradas y las viejas, y no toca worktrees ajenos', async () => {
  const { copiaDeRama, limpiarCopias } = await import('../mcp/lib/copias.mjs');
  const { r, p } = preparar();
  const abierta = await crearCopia(p, 'x', 7, r.head);
  const cerrada = await crearCopia(p, 'x', 8, r.head, { sufijo: '-lectura' });
  const vieja = await copiaDeRama(p, 'x', r.rama);
  const ajeno = join(r.raiz, 'ajeno');
  sh(r.checkout, 'worktree', 'add', '-q', '--detach', ajeno);
  const hace8 = Date.now() - 8 * 24 * 3600 * 1000;
  const borradas = await limpiarCopias(p, { abiertas: new Set(['x#7']), ahora: Date.now(), usos: { [vieja.dir]: hace8 } });
  assert.deepEqual(borradas.sort(), [cerrada, vieja.dir].sort());
  assert.ok(existsSync(abierta));
  assert.ok(existsSync(ajeno));
  assert.ok(!existsSync(cerrada));
});
