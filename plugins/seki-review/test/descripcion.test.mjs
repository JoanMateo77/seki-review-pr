import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitsPr } from '../mcp/lib/estado.mjs';

test('commitsPr splits title and body and fetches author and date of each commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seki-gh-'));
  const pagina = [
    { sha: 'abc1234def', author: { login: 'joan' }, commit: { message: 'fix: uno\n\nDetalle del cambio.', author: { name: 'Joan C', date: '2026-10-27T10:00:00Z' } } },
    { sha: 'fff0000aaa', author: null, commit: { message: 'test: dos', author: { name: 'Sin Cuenta', date: '2026-10-27T11:00:00Z' } } },
  ];
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\ncat <<'FIN'\n${JSON.stringify([pagina])}\nFIN\n`);
  chmodSync(join(dir, 'gh'), 0o755);
  const previo = process.env.SEKI_GH;
  process.env.SEKI_GH = join(dir, 'gh');
  try {
    const commits = await commitsPr('o', 'r', 1);
    assert.deepEqual(commits, [
      { oid: 'abc1234def', messageHeadline: 'fix: uno', messageBody: 'Detalle del cambio.', autor: 'joan', fecha: '2026-10-27T10:00:00Z' },
      { oid: 'fff0000aaa', messageHeadline: 'test: dos', messageBody: '', autor: 'Sin Cuenta', fecha: '2026-10-27T11:00:00Z' },
    ]);
  } finally {
    if (previo === undefined) delete process.env.SEKI_GH; else process.env.SEKI_GH = previo;
  }
});

// The formatting functions live inside the template; they are extracted as-is to test them.
async function formato() {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../mcp/tablero/plantilla.html', import.meta.url), 'utf8');
  const esc = /^const esc = .*$/m.exec(html)[0];
  const inicio = html.indexOf('function md(texto)');
  const fin = html.indexOf('\n}\n', html.indexOf('function mdTexto')) + 3;
  return new Function(`${esc}\n${html.slice(inicio, fin)}\nreturn md;`)();
}

test('md formats headings, links and tables in the description', async () => {
  const md = await formato();
  const html = md('## Qué cambia\n- La ruta [X](https://github.com/o/r/pull/1) exige apikey\n\n| a | b |\n|---|---|');
  assert.match(html, /<h4 class="md-titulo">Qué cambia<\/h4>/);
  assert.match(html, /<a href="https:\/\/github\.com\/o\/r\/pull\/1" target="_blank" rel="noopener">X<\/a>/);
  assert.match(html, /<pre class="md-codigo">\| a \| b \|\n\|---\|---\|<\/pre>/);
});

test('md does not link a scheme other than http(s) nor let the href escape', async () => {
  const md = await formato();
  assert.doesNotMatch(md('[x](javascript:alert(1))'), /<a /);
  assert.doesNotMatch(md('[x](https://a.co/"onmouseover="alert(1))'), /href="[^"]*"onmouseover/);
  assert.doesNotMatch(md('<img src=x onerror=alert(1)>'), /<img/);
});
