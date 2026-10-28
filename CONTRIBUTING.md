# Cómo contribuir

## Ramas
- `main` tiene solo versiones publicadas. El trabajo va en una rama por tema (`feat/...`, `fix/...`) y entra por PR.
- Una PR por cambio coherente; las pruebas deben pasar antes de pedir revisión.

## Commits
- Mensaje en español, impersonal, en hechos: `<plugin|área>: qué cambia` (por ejemplo `tablero: botón para cerrar el menú lateral`).
- El commit que publica una versión empieza con `<plugin> X.Y.Z:` y resume lo que trae.
- Sin trailers ni firmas de herramientas de IA (`Co-Authored-By`, `Claude-Session` y similares).
- Cada commit con su identidad git real; no forzar un autor compartido.

## Versiones
1. Subir la versión en `plugins/<plugin>/.claude-plugin/plugin.json` y en `mcp/server.mjs`.
2. Agregar la entrada en `CHANGELOG.md`.
3. Correr las pruebas: `node --test 'test/*.test.mjs'` y `node test/humo.mjs` desde `plugins/<plugin>`. Antes de publicar,
   también la prueba real de permisos: `SEKI_PRUEBA_REAL=1 node --test test/permisos-real.test.mjs` (cuesta centavos).
4. Commit de versión, etiqueta anotada `<plugin>-vX.Y.Z` y push con `--follow-tags`.

## Datos
- Nada de secretos, archivos `.env`, tokens, datos de clientes ni salidas del tablero (`revision-prs/`) en el repo.
