# Herramientas de Claude para el equipo

Marketplace local de plugins de Claude Code. Cada plugin agrupa un servidor MCP (herramientas que
cualquier cliente MCP puede llamar) y skills (el flujo que sigue Claude con esas herramientas).

## Instalación

```
claude plugin marketplace add ~/herramientas-claude
claude plugin install pw-revision@seki
```

Después de editar un plugin: `claude plugin marketplace update seki` y
reiniciar la sesión.

Requisitos: `gh` autenticado y Node >= 18 (el lanzador busca primero en `~/.proto`; `PW_NODE`
lo fija a mano). Sin dependencias npm.

## pw-revision

| Pieza | Ruta |
|---|---|
| Servidor MCP (stdio, JSON-RPC sin SDK) | `plugins/pw-revision/mcp/server.mjs` |
| Herramientas, una por archivo | `plugins/pw-revision/mcp/tools/*.mjs` |
| Lógica compartida (GitHub, git, gemelas, estado frente a pruebas y producción) | `plugins/pw-revision/mcp/lib/` |
| Reglas de verificación (una por incidente o regla del proyecto) | `plugins/pw-revision/mcp/lib/reglas.mjs` |
| Plantilla del tablero | `plugins/pw-revision/mcp/tablero/plantilla.html` |
| Proyectos, repos y ramas por ambiente | `plugins/pw-revision/config/proyectos.json` |
| Flujo para Claude | `plugins/pw-revision/skills/revisar-prs/SKILL.md` |
| Prueba de humo | `node plugins/pw-revision/test/humo.mjs [herramienta] ['{"arg":1}']` |

Salida (por proyecto, campo `salida`): `datos/prs.json` (última foto), `datos/*-cache.json`, `verificaciones/`,
`explicaciones/<repo>-<n>.json` y `tablero.html`.

### Agregar una herramienta

Crear `mcp/tools/<nombre>.mjs`; el servidor la registra al arrancar:

```js
export default {
  name: 'mi_herramienta',
  description: 'Qué hace y cuándo usarla (Claude decide con este texto).',
  inputSchema: { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'] },
  async handler({ repo }) {
    return { ok: true }; // texto u objeto; un throw se devuelve como error de la herramienta
  },
};
```

Ideas que encajan sin rediseño: estado de despliegue por ambiente (gitops / Argo CD), correr la
suite de tests de una PR contra el baseline, revisión con `revision-de-codigo`, matriz de
regresión, registro de actividades en un sistema de tareas.

### Agregar un proyecto

Nueva clave en `proyectos.json` con `owner`, `autor` (`@me` o vacío para todas), `salida` y por repo
sus `lineas` (`portal`, `prod`, `pruebas`), `inactivas` y el `checkout` local opcional (con
checkout, el estado frente a pruebas se comprueba aplicando el parche; sin él, comparando archivos).

### Otros clientes MCP

El servidor no depende de Claude Code. Para Claude Desktop, Cursor u otro cliente:
`{"command": "sh", "args": ["<ruta>/plugins/pw-revision/bin/servidor.sh"]}`.

### Agregar una regla de verificación

Un objeto más en `REGLAS` de `mcp/lib/reglas.mjs` con `id`, `titulo`, `severidad`, `archivos` (regex de ruta),
`patron` (regex sobre la línea agregada), `mensaje` y `origen` (el incidente o la regla que la justifica).
Opcionales: `excluir`, `cuando(linea, archivo)`, `severidadPara(linea)`, `repos`, `porArchivo`. Para apagar una
regla en un repo: `reglas_omitidas: ["id"]` en su entrada de `proyectos.json`.
