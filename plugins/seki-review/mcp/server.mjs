// Dependency-free stdio MCP server: JSON-RPC 2.0, one message per line.
// Each file in tools/ default-exports { name, description, inputSchema, handler }
// and registers itself on startup.
import { readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const DIR_TOOLS = join(dirname(fileURLToPath(import.meta.url)), 'tools');
const VERSION_PROTOCOLO = '2025-06-18';

const tools = new Map();
for (const archivo of readdirSync(DIR_TOOLS).filter((f) => f.endsWith('.mjs')).sort()) {
  const { default: tool } = await import(pathToFileURL(join(DIR_TOOLS, archivo)).href);
  tools.set(tool.name, tool);
}

const enviar = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const responder = (id, result) => enviar({ jsonrpc: '2.0', id, result });
const fallar = (id, code, message) => enviar({ jsonrpc: '2.0', id, error: { code, message } });

async function llamarTool(id, { name, arguments: args = {} }) {
  const tool = tools.get(name);
  if (!tool) return fallar(id, -32602, `Unknown tool: ${name}`);
  try {
    const salida = await tool.handler(args);
    const texto = typeof salida === 'string' ? salida : JSON.stringify(salida, null, 2);
    responder(id, { content: [{ type: 'text', text: texto }] });
  } catch (err) {
    responder(id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
  }
}

async function atender(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return responder(id, {
        protocolVersion: params?.protocolVersion ?? VERSION_PROTOCOLO,
        capabilities: { tools: {} },
        serverInfo: { name: 'seki-review', version: '0.19.4' },
      });
    case 'ping':
      return responder(id, {});
    case 'tools/list':
      return responder(id, {
        tools: [...tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case 'tools/call':
      return llamarTool(id, params);
    default:
      if (id !== undefined) fallar(id, -32601, `Unsupported method: ${method}`);
  }
}

createInterface({ input: process.stdin }).on('line', (linea) => {
  if (!linea.trim()) return;
  let msg;
  try {
    msg = JSON.parse(linea);
  } catch {
    return fallar(null, -32700, 'Invalid JSON');
  }
  atender(msg).catch((err) => msg.id !== undefined && fallar(msg.id, -32603, err.message));
});
