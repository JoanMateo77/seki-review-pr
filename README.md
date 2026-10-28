# Seki Review

Revisión de PRs con IA para Claude Code: qué PRs están pendientes por ambiente, si su código ya está en pruebas o en
producción, una explicación de cada cambio pensada para quien no lo escribió, preguntas sobre líneas o sobre la
explicación, investigación de solo lectura en el código y propuestas de cambio que solo se suben con una aprobación.
Todo en un tablero local.

Es un plugin de Claude Code: un servidor MCP (herramientas que cualquier cliente MCP puede llamar) y una skill (el
flujo que sigue Claude con esas herramientas).

## Instalación

```
claude plugin marketplace add <ruta-o-repo-de-github>
claude plugin install seki-review@seki
```

Luego copiar `plugins/seki-review/config/proyectos.ejemplo.json` a `~/.config/seki-review/proyectos.json` y
completarlo con sus repos y ramas. En Claude Code: `/seki-review:revisar-prs` abre el tablero.

Después de editar el plugin: `claude plugin marketplace update seki` y reiniciar la sesión.

Requisitos: `gh` autenticado y Node >= 18 (el lanzador busca primero en `~/.proto`; `SEKI_NODE`
lo fija a mano). Sin dependencias npm.

## seki-review

| Pieza | Ruta |
|---|---|
| Servidor MCP (stdio, JSON-RPC sin SDK) | `plugins/seki-review/mcp/server.mjs` |
| Herramientas, una por archivo | `plugins/seki-review/mcp/tools/*.mjs` |
| Lógica compartida (GitHub, git, gemelas, estado frente a pruebas y producción) | `plugins/seki-review/mcp/lib/` |
| Reglas de verificación genéricas | `plugins/seki-review/mcp/lib/reglas.mjs` |
| Plantilla del tablero | `plugins/seki-review/mcp/tablero/plantilla.html` |
| Proyectos, repos, ramas, contexto y reglas propias | `~/.config/seki-review/proyectos.json` (ejemplo en `config/proyectos.ejemplo.json`) |
| Flujo para Claude | `plugins/seki-review/skills/revisar-prs/SKILL.md` |
| Servidor del tablero con acciones (127.0.0.1, token en la URL) | `plugins/seki-review/mcp/lib/servidor-web.mjs`, `bin/tablero.sh` |
| Cola de análisis con IA (`claude -p`, sonnet, solo lectura) | `plugins/seki-review/mcp/lib/trabajos.mjs` |
| Prueba de humo | `node plugins/seki-review/test/humo.mjs [herramienta] ['{"arg":1}']` |

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
suite de tests de una PR contra el baseline, plantillas de revisión por tipo de proyecto.

### Agregar un proyecto

Nueva clave en `proyectos.json` con `owner`, `autor` (`@me` o vacío para todas), `salida` y por repo
sus `lineas` (`portal`, `prod`, `pruebas`), `inactivas` y el `checkout` local opcional (con
checkout, el estado frente a pruebas se comprueba aplicando el parche; sin él, comparando archivos).
Opcionales: `contexto` (stack y reglas de texto o de código que la IA respeta en todo lo que escribe), `reglas`
(verificaciones propias con expresiones como texto: `id`, `titulo`, `severidad`, `archivos`, `patron`, `flags`,
`excluir`, `soloEnTexto`, `porArchivo`, `repos`, `mensaje`, `origen`), `lineamientos` (carpeta de una skill con
`SKILL.md` y `destilado/*.md` para los pedidos de cambio) y `copias`. Sin proyecto indicado se usa `SEKI_PROYECTO` o
el primero del archivo.

### Otros clientes MCP

El servidor no depende de Claude Code. Para Claude Desktop, Cursor u otro cliente:
`{"command": "sh", "args": ["<ruta>/plugins/seki-review/bin/servidor.sh"]}`.

### Agregar una regla de verificación

Un objeto más en `REGLAS` de `mcp/lib/reglas.mjs` con `id`, `titulo`, `severidad`, `archivos` (regex de ruta),
`patron` (regex sobre la línea agregada), `mensaje` y `origen` (el incidente o la regla que la justifica).
Opcionales: `excluir`, `cuando(linea, archivo)`, `severidadPara(linea)`, `repos`, `porArchivo`. Para apagar una
regla en un repo: `reglas_omitidas: ["id"]` en su entrada de `proyectos.json`.

### Tablero con acciones

`tablero_servir` (o `sh plugins/seki-review/bin/tablero.sh`) sirve el tablero en `127.0.0.1:4317` con un token en la URL.
"Actualizar estado" vuelve a consultar GitHub y git y muestra qué se mergeó, se cerró, es nuevo o cambió de grupo.
"Analizar con IA" y las preguntas sobre líneas lanzan `claude -p` en modo mínimo: sin CLAUDE.md, memoria, skills ni
MCP de otros plugins, con un prompt de sistema propio (`mcp/prompts/`). Solo aplica a lo que lanza el tablero; las
sesiones normales de Claude Code no cambian. Medido el 27-10-2026: la explicación de una PR mediana bajó de
USD 0,20 a 0,058, y dos preguntas con Haiku costaron USD 0,0023.

| Trabajo | Modelo por defecto | Tope por defecto |
|---|---|---|
| Pregunta sobre hasta 40 líneas en PR de esfuerzo 1-2 | Haiku | USD 0,50 por pregunta |
| Otras preguntas, explicaciones | Sonnet | USD 0,50 / 2 |
| Pedido de cambio | Sonnet (nunca Haiku) | USD 1,50 |
| Explicación o pedido en PR de seguridad o de más de 1.500 líneas | Opus | igual que su tipo |

Variables: `SEKI_IA_MODELO` (todo) o `SEKI_IA_MODELO_RESPONDER`, `SEKI_IA_MODELO_EXPLICAR`, `SEKI_IA_MODELO_CAMBIAR`;
`SEKI_IA_TOPE_<TIPO>` en dólares; `SEKI_IA_PARALELO` (1 o 2); `SEKI_CLAUDE` para otro ejecutable. Cada trabajo queda en
`revision-prs/datos/costos.jsonl` y el tablero muestra el gasto del día. Las respuestas se guardan por commit, archivo,
líneas y texto, y no se vuelven a pedir.

**Pedidos de cambio.** La IA trabaja en una copia aparte: un worktree desacoplado en el commit de la PR, ubicado en
`copias` de `proyectos.json` (por defecto `~/.cache/seki-review/copias/<proyecto>`, fuera del workspace para no heredar
su CLAUDE.md). Solo tiene Read, Grep, Glob, Edit y Write, sin Bash, y solo puede escribir dentro de la copia
(`--permission-mode acceptEdits`; no carga settings ni hooks del repo). Carga los lineamientos de `lineamientos`
del proyecto. El servidor comprueba cada propuesta sin IA, con las reglas, `tsc` y los tests
relacionados según `comprobar` de cada repo; si algo falla, la IA tiene un intento de corrección. Los fallos que ya
existían en el commit de la PR no cuentan. **Aprobar** confirma con `gh` que la PR sigue abierta, que no viene de un fork y que la rama solo avanzó con commits que subió el
tablero,
aplica el parche, hace un commit con la identidad git de la máquina (sin trailers) y hace `git push` a la rama de la
PR. Si GitHub rechaza la subida, la propuesta queda como parche para copiar. Medido el 27-10-2026: un cambio chico en
un back en TypeScript costó USD 0,11 con Sonnet y tardó 72 s, comprobaciones incluidas.

## Licencia

MIT. Ver [LICENSE](LICENSE). Historial de versiones en [CHANGELOG.md](CHANGELOG.md) y forma de trabajo en [CONTRIBUTING.md](CONTRIBUTING.md).
