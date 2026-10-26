#!/bin/sh
# El node del PATH puede ser el que pina un .nvmrc viejo; el servidor necesita >= 18.
DIR=$(cd "$(dirname "$0")/.." && pwd)
for n in "$PW_NODE" "$HOME"/.proto/tools/node/24.*/bin/node "$HOME"/.proto/tools/node/22.*/bin/node "$(command -v node)"; do
  [ -x "$n" ] || continue
  major=$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || continue
  [ "$major" -ge 18 ] && exec "$n" "$DIR/mcp/server.mjs"
done
echo "pw-revision: no se encontró Node >= 18 (defina PW_NODE)" >&2
exit 1
