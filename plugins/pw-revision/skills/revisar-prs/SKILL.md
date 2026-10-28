---
name: revisar-prs
description: Usar cuando se pide revisar qué PRs están pendientes de pasar a pruebas o a producción, entender o explicar una PR (qué cambia, tecnologías, por qué, alternativas, cómo probar), o abrir el tablero local de revisión de PRs de el equipo. Sin argumento abre el tablero servido. Argumentos opcionales - "pendientes", "explicar <repo>#<n>", "explicar pendientes", "verificar <repo>#<n>", "archivo".
---

# Revisar PRs (pw-revision)

Herramientas del servidor MCP `pw-revision`:

| Herramienta | Para qué |
|---|---|
| `prs_pendientes` | Foto de las PRs abiertas agrupadas por acción, con estado real frente a pruebas |
| `pr_detalle` | Descripción, commits y diff recortado de una PR, para entenderla |
| `pr_verificaciones` | Reglas fijas sobre las líneas agregadas de una PR, o de una rama local antes de abrirla (`dir` + `base`) |
| `pr_guardar_explicacion` | Guarda la explicación de una PR atada a su commit actual |
| `tablero_generar` | Escribe y abre `revision-prs/tablero.html` (archivo local, sin acciones) |
| `tablero_servir` | Sirve el tablero en 127.0.0.1 con acciones: actualizar estado y analizar con IA |

Todo queda en archivos locales. No publicar el tablero ni las explicaciones en Artifacts, Claude Docs ni ningún servicio externo.

## Flujo según el argumento

**Sin argumento o "tablero":** llamar `tablero_servir` primero (abre el navegador con el tablero servido) y responder
en una línea con el enlace. Desde el tablero, los botones lanzan la IA por su cuenta: no proponer comandos para copiar.
No llamar `prs_pendientes` salvo que la persona pida el resumen.

**"pendientes":** llamar `prs_pendientes` y resumir por grupo. Señalar primero lo que exige acción:
"En pruebas sin PR hacia producción" (código validado que nunca salió), PRs de seguridad sin
pasar a producción, verificaciones bloqueantes o altas, "sin equivalente en <portal>" cuando el arreglo aplica a los
dos portales, "otra versión en pruebas" y PRs viejas con conflicto. No repetir la lista entera si la persona solo pidió un resumen.

**"verificar <repo>#<n>"** o **"verificar <ruta> <base>"**: `pr_verificaciones`; explicar cada hallazgo bloqueante o alto
mirando la línea en contexto y decir si es real o falso positivo. Antes de abrir una PR propia, correrlo sobre la rama local.

**"explicar <repo>#<n>":** `pr_detalle` → leer descripción, commits y diff → revisar los hallazgos de `pr_verificaciones` → si el diff viene recortado y hace falta, leer el archivo en el checkout local con lectura acotada (grep + rango) → `pr_guardar_explicacion` → `tablero_servir`.

**"explicar pendientes":** tomar de `prs_pendientes` las PRs sin explicación o con explicación desactualizada, sin las de ramas inactivas. Priorizar seguridad y las que van a producción. Más de 5 PRs → repartir en subagentes con `model: "sonnet"`, cada uno con 3 a 5 PRs, y pedirles que llamen ellos mismos `pr_guardar_explicacion`. Al final, `tablero_servir`.

**Revisión por otra persona:** el tablero es un archivo local que se puede enviar. Quien revisa elige "Revisor"
arriba, deja su decisión y observaciones por PR y exporta un JSON; el autor lo importa en su tablero. Si piden leer
esas decisiones, pedir la ruta del JSON exportado y resumirlo.

**Comentarios sobre líneas:** en la pestaña Archivos se seleccionan líneas (clic en el número, Shift + clic para un
rango) y se deja una nota manual, opcionalmente con código sugerido; las notas salen en la revisión exportada y en
"Copiar resumen". Preguntar y Pedir cambio solo funcionan con el tablero servido: se acumulan en "Revisión pendiente"
y "Enviar revisión" las manda juntas (todas las preguntas de una PR en una sola llamada). El costo de cada trabajo
queda en `revision-prs/datos/costos.jsonl`. Un pedido de cambio genera una propuesta en una copia aparte de la rama (con
comprobaciones de reglas, tipos y tests). Solo el botón Aprobar la sube a la rama de la PR, y nunca hace merge.
En el Resumen, al seleccionar texto de la explicación aparece una barra para preguntar sobre ese fragmento (o
"¿Por qué?", "Dar un ejemplo", "Ampliar"); cada sección tiene "Ampliar" y al final hay una caja para preguntar sobre
toda la PR. Las preguntas se envían al momento o se agregan a "Revisión pendiente" para mandarlas juntas.
Las respuestas rápidas usan solo la explicación y el diff; "Investigar en el código" (o la casilla "Revisar el código")
lanza a la IA con Read/Grep/Glob sobre una copia de solo lectura de la PR y copias de los otros repos en la rama
equivalente (pruebas o producción, una por portal, traídas frescas de GitHub; nunca el checkout del usuario), sin
acceso a archivos de secretos (.env, llaves, claves.txt). Cada respuesta guarda qué repo, rama y commit se leyó. Las
copias de PRs cerradas o sin uso hace 7 días se borran al actualizar el estado. En Archivos, seleccionar código con el
mouse abre la misma barra (Preguntar, Pedir cambio, Nota) sobre esas líneas. Repreguntar enlaza la pregunta a la anterior y la IA recibe el
hilo completo.

**Pestaña Descripción:** muestra la descripción de la PR tal como la escribió el autor (con formato) y la lista de
commits con enlace, autor y fecha. Se llena al actualizar el estado; una PR de seguridad sin descripción se avisa.

**"archivo":** `tablero_generar` solo cuando se necesita el archivo suelto (sin acciones) para enviarlo a quien
revisa. El tablero servido vive mientras dure la sesión de Claude Code; su enlace es fijo por máquina. Fuera de Claude Code:
`sh <plugin>/bin/tablero.sh`.

**"qué se mergeó" / "qué cambió":** `prs_pendientes` compara con la foto anterior y abre su salida con
"Cambios detectados": mergeadas (y en qué rama), cerradas sin mergear, nuevas y las que cambiaron de grupo.

## Cómo redactar la explicación

Pensada para alguien que no escribió el cambio y debe aprobarlo o probarlo.

- **resumen:** una frase con lo que resuelve.
- **por_que:** el problema real (incidente, hallazgo de seguridad, caso de QA, pedido del banco). Si la descripción de la PR lo dice, usarlo; no inventar.
- **que_cambia:** cambios concretos, uno por elemento, en hechos ("La ruta X exige sesión"), sin narrativa.
- **impacto_usuario:** lo que nota quien usa el portal; "Ninguno visible" si es interno.
- **tecnologias:** solo las que el cambio usa de verdad (librería, mecanismo de Express/TypeORM/EJS, API de GitHub, SQL). Para cada una: uso en este cambio, por qué esa, y qué alternativas se descartaron y por qué (por ejemplo: parametrizar la consulta en vez de escapar a mano; DOMPurify en vez de una expresión regular). Si no hay una decisión real, no rellenar.
- **alternativas:** otras soluciones al problema completo y por qué no.
- **como_probar:** pasos verificables en pruebas, cada uno con su resultado esperado.
- **riesgos** y **dependencias:** SQL que debe correr antes, variables de entorno, PRs que van primero, orden de despliegue.
- **riesgo:** bajo, medio o alto según lo que puede romper en producción.
- **esfuerzo:** 1 a 5 para revisarla (1 = minutos; 5 = media jornada o más). Pesa más la lógica nueva que el tamaño.
- **orden_lectura:** archivos en el orden en que conviene leerlos, empezando por donde nace el cambio (ruta, migración,
  regla de negocio) y dejando pruebas y vistas al final. Un motivo corto por archivo. Omitir archivos triviales.
- **diagrama:** solo si cambia un flujo entre componentes (portal, back, checkout, banco, cron). `sequenceDiagram` de
  Mermaid con participantes en lenguaje del negocio, sin nombres de funciones, a lo sumo 12 mensajes.

Reglas de texto: español formal e impersonal (nunca voseo ni tuteo), sin emojis, "cliente" y nunca "comercio" (salvo excepciones como "Cámara de Comercio"), "portal de pagos" para el portal de pagos del cliente. Sin nombres de funciones cuando no aportan a quien prueba.

## Significado de los estados

- **En pruebas sin PR hacia producción:** PR abierta o mergeada en pruebas (últimos 30 días) cuyo código no aparece en
  producción (ningún archivo coincide) y que ninguna PR abierta hacia producción trae. Se omiten las sincronizaciones
  y lo marcado como "solo pruebas". Puede ser intencional (una funcionalidad que aún no sale); confirmarlo.
- **Sin equivalente en <portal>:** no hay PR con título parecido hacia la rama de producción del otro portal. No todos
  los cambios aplican a ambos portales.

- **Ya está en pruebas:** el cambio aplicado al revés sobre la rama de pruebas entra limpio, o todos sus archivos son idénticos. Falta solo producción.
- **Otra versión en pruebas:** parte de los archivos coincide. Normalmente la PR de pruebas se ajustó después. Revisar diferencias antes de mergear a producción.
- **No está en pruebas:** el cambio entra limpio sobre pruebas (no está), o no coincide ningún archivo.
- **Gemela:** la PR equivalente contra la otra rama de la línea, detectada por título. Es una pista, no una prueba: confirmar con el estado.

La configuración de proyectos, repos y ramas está en `config/proyectos.json` del plugin. Para cambiarla sin tocar el plugin, crear `~/.config/pw-revision/proyectos.json` o definir `PW_REVISION_CONFIG`.
