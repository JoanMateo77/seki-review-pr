import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { htmlAPdf, rutaChrome } from '../mcp/lib/pdf.mjs';
import { chromeFalso, limpiarChrome, llamadasChrome } from './util/chrome.mjs';

after(limpiarChrome);
const dir = mkdtempSync(join(tmpdir(), 'seki-pdf-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const html = join(dir, 'a.html');
writeFileSync(html, '<p>x</p>');

test('ok mode writes the PDF and passes safe flags', async () => {
  const chrome = chromeFalso({ modo: 'ok' });
  const pdf = join(dir, 'ok.pdf');
  const r = await htmlAPdf(chrome, html, pdf);
  assert.deepEqual(r, { ok: true });
  assert.equal(readFileSync(pdf, 'utf8').startsWith('%PDF'), true);
  const [args] = llamadasChrome(chrome);
  assert.ok(args.includes('--headless'));
  assert.ok(args.includes(`--print-to-pdf=${pdf}`));
  assert.ok(!args.includes('--no-sandbox'));
  assert.ok(!args.some((a) => a.includes('allow-file-access')));
  assert.ok(args.at(-1).startsWith('file://'));
});

test('failing Chrome reports not ok and removes its profile', async () => {
  const chrome = chromeFalso({ modo: 'falla' });
  const r = await htmlAPdf(chrome, html, join(dir, 'f.pdf'));
  assert.equal(r.ok, false);
  assert.equal(existsSync(r.perfil), false);
});

test('a hanging Chrome is killed at the limit and its profile removed', async () => {
  const chrome = chromeFalso({ modo: 'cuelga' });
  const r = await htmlAPdf(chrome, html, join(dir, 'c.pdf'), { limiteMs: 300 });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /in time/);
  assert.ok(r.pid);
  assert.throws(() => process.kill(r.pid, 0), (e) => e.code === 'ESRCH');
  assert.equal(existsSync(r.perfil), false);
});

test('a missing binary is reported, not thrown', async () => {
  const r = await htmlAPdf(join(dir, 'no-existe'), html, join(dir, 'n.pdf'));
  assert.equal(r.ok, false);
});

test('rutaChrome prefers the configured regular file and ignores a missing one', () => {
  const chrome = chromeFalso({ modo: 'ok' });
  assert.equal(rutaChrome({ qa: { chrome } }), chrome);
  const otro = rutaChrome({ qa: { chrome: join(dir, 'no-existe') } });
  assert.notEqual(otro, join(dir, 'no-existe'));
});
