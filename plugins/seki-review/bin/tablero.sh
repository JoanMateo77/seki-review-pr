#!/bin/sh
DIR=$(cd "$(dirname "$0")/.." && pwd)
for n in "$SEKI_NODE" "$HOME"/.proto/tools/node/24.*/bin/node "$HOME"/.proto/tools/node/22.*/bin/node "$(command -v node)"; do
  [ -x "$n" ] || continue
  major=$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || continue
  [ "$major" -ge 18 ] && exec "$n" "$DIR/mcp/web.mjs" "$@"
done
echo "seki-review: no se encontró Node >= 18 (defina SEKI_NODE)" >&2
exit 1
