# Pendientes de seki-review

Defectos y mejoras detectados en uso real que quedan por corregir. Cada entrada: síntoma,
causa con `archivo:línea`, impacto y arreglo propuesto. Se borra la entrada al mergear el arreglo.

## 1. Caché de archivos de la PR sin el commit: verificaciones y estado con un diff viejo

Detectado el 2026-11-10 con core-mainback#505.

**Síntoma.** Tras empujar un commit nuevo a la PR, `pr_verificaciones` devuelve el `headSha`
nuevo pero sigue reportando hallazgos de líneas que ya no existen (4 avisos `tipo-any` que
el commit `72cf89ea` había quitado; `gh pr diff 505` ya no tenía ningún `any`).

**Causa.** `mcp/lib/estado.mjs:23-28`: `archivosPr` memoriza `pulls/<n>/files` en
`archivosMemo` con la clave `owner/repo#numero`, sin `headSha`, durante toda la vida del
proceso del servidor MCP. `headRefOid` se consulta de nuevo en cada llamada, así que el
resultado mezcla commit nuevo con diff viejo.

**Impacto.** Todo lo que lee `archivosPr` en un servidor de larga vida queda desactualizado
tras un push:
- `tools/pr_verificaciones.mjs:44-49` (hallazgos fantasma, o hallazgos nuevos que no aparecen).
- `lib/estado.mjs:69-77` `estadoFrentePruebas` (en pruebas / otra versión / no está en pruebas).
- `lib/diffs.mjs:11` (diff que ven el tablero y las explicaciones).
- El resultado se guarda con el `headSha` nuevo, de modo que el caché en disco también queda mal etiquetado.

**Arreglo propuesto.** Incluir el `headSha` en la clave del memo (`owner/repo#numero@sha`) o
invalidar la entrada cuando cambie `headRefOid`; agregar una prueba que simule dos llamadas
con distinto head y compruebe que la segunda vuelve a pedir `pulls/<n>/files`.

**Mientras tanto.** Reiniciar el servidor MCP (cerrar y abrir la sesión de Claude Code) o
contrastar con `gh pr diff <n>`.
