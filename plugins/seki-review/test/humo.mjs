// Smoke test: starts the server over stdio and calls a tool.
// Usage: node test/humo.mjs [tool] ['{"arg":1}']
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const srv = spawn('sh', [join(raiz, 'bin/servidor.sh')], { stdio: ['pipe', 'pipe', 'inherit'] });
const pendientes = new Map();
createInterface({ input: srv.stdout }).on('line', (l) => {
  const m = JSON.parse(l);
  pendientes.get(m.id)?.(m);
});
let id = 0;
const pedir = (method, params) => new Promise((ok) => { pendientes.set(++id, ok); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });

const init = await pedir('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'humo', version: '0' } });
console.log('server:', init.result.serverInfo);
srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const lista = await pedir('tools/list', {});
console.log('tools:', lista.result.tools.map((t) => t.name).join(', '));
const [, , tool, args] = process.argv;
if (tool) {
  const r = await pedir('tools/call', { name: tool, arguments: args ? JSON.parse(args) : {} });
  console.log(r.result?.isError ? 'ERROR' : 'OK');
  console.log(r.result?.content?.[0]?.text ?? JSON.stringify(r.error));
}
srv.kill();
