# Diseño: validar y arreglar Checks con IA

Estado: implementado en 0.26.0.
Rutas relativas a `plugins/seki-review/`.

## 1. Diagnóstico (verificado en el código)

1. **La regla EJS es solo coincidencia de texto.** `patron: /<%-(?!\s*include\b)/` (`mcp/lib/reglas.mjs:60`) marca cualquier `<%-` salvo `include` y `JSON.stringify(...replace(/</g`. `<%- _p.anterior ? '' : 'aria-disabled="true"' %>` solo emite un literal fijo y aun así sale como `alto`.
2. **La única salida ensucia el código.** `seki-review: ignore <id>` vale solo en la misma línea agregada (`mcp/lib/verificar.mjs:4,68`); `reglas_omitidas` apaga la regla en todo el repo.
3. **Los hallazgos no tienen identidad ni estado.** Son `{regla, titulo, severidad, archivo, linea, texto, mensaje, origen}` (`verificar.mjs:95-97`). La pestaña Checks no tiene acciones por fila (`mcp/tablero/partes/05-script-2.js:35-48`).
4. **Ultra no ve los Checks.** `mcp/lib/ultra.mjs` y sus prompts no los leen; solo `explicar` los recibe (`mcp/lib/explicar.mjs:115-123`).
5. **El arreglo ya existe.** Un comentario `cambio` pasa por `/api/enviar-revision` a `proponerCambios` (`mcp/lib/propuestas.mjs`): la IA edita una copia aislada, corren reglas, tipos y pruebas, y solo Approve hace commit y push (`propuestas.mjs:267,279`).
6. **La revalidación tras un push lee un diff viejo.** `archivosPr` memoriza `pulls/<n>/files` sin el commit (`mcp/lib/estado.mjs:23-28`; `docs/pendientes.md` #1).

## 2. Decisiones del dueño

- La IA **propone** el veredicto; el descarte de un falso positivo lo **confirma una persona** con un clic. Hay "confirmar todos" solo para severidad `medio`. Un hallazgo `bloqueante` se confirma siempre uno por uno.
- En PRs ajenas ("To review") Seki **puede** subir el arreglo a la rama del autor, **siempre con Approve**. Nunca hay push sin esa acción humana, en ninguna PR.

## 3. Piezas

### A. Regla EJS: no marcar salidas que solo emiten literales

Una etiqueta `<%- expr %>` no cuenta cuando `expr` es:
- un literal de texto (`'…'`, `"…"` o `` `…` `` sin `${`), o
- un ternario `cond ? LIT : LIT` cuya `cond` no contiene otro `?` (se admiten `?.` y `??`).

La línea se marca si alguna de sus etiquetas `<%-` no cumple eso. Una etiqueta sin `%>` en la misma línea se marca (no se puede decidir). Se implementa con `cuando` en la regla `ejs-sin-escapar`; `patron` y `excluir` no cambian.

### B. Caché de archivos de la PR por commit

`archivosPr(owner, repo, numero, headSha)` usa la clave `owner/repo#numero@headSha`. Sin `headSha` no memoriza. Todos los llamadores pasan el commit que ya conocen. Al mergear se borra la entrada #1 de `docs/pendientes.md`.

### C. Identidad del hallazgo

`huella` = primeros 16 hex de sha256 de `regla \0 archivo \0 texto` con los espacios del texto colapsados. No incluye el número de línea ni el commit: sobrevive a un push mientras la línea no cambie. Dos líneas idénticas del mismo archivo comparten huella, veredicto y descarte; es aceptado.

Los hallazgos sin línea (`porArchivo`, `atribucion-ia`) tienen huella pero no admiten "Fix".

### D. Triaje con IA (`triar_checks`)

- Una llamada por PR sobre la copia de solo lectura (`-lectura`), con `Read`, `Grep`, `Glob`. Entrada: un bloque JSON con el PR (número, repo y título, que es texto del autor y por eso va dentro de los datos) y, por hallazgo, exactamente `huella`, `regla`, `titulo`, `severidad`, `mensaje`, `origen` (por qué existe la regla), `archivo`, `linea` y `texto`.
- Se trían las severidades `bloqueante`, `alto` y `medio`. Los `aviso` no.
- Salida por hallazgo: `{ huella, veredicto: real | falso_positivo | dudoso, razon, evidencia?: { archivo, linea } }`.
- Un `falso_positivo` sin `razon`, o sin `evidencia` válida (`archivo` no vacío y `linea` entera mayor o igual a 1), o con `evidencia` que no pasa `existeCita`, se guarda como `dudoso`. Una `evidencia` mal formada se descarta del veredicto guardado, sea cual sea. Los veredictos que agrega Ultra (G) no llevan esta exigencia. Un hallazgo sin veredicto queda `dudoso`. `dudoso` deja el hallazgo abierto.
- Perfil: `triar_checks: { modelo: null, topeUsd: 1, turnos: 25, segundaPasada: false }`. `modelo: null` da Sonnet, u Opus en PR de seguridad o grande; en modo ahorro, Sonnet. Nunca Haiku.
- Se guarda por commit en `<salida>/verificaciones/triaje/<repo>-<n>.json`: `{ headSha, fecha, origen: 'checks' | 'ultra', modelo, modo, costo, veredictos }`. Con commits nuevos se marca `desactualizado`, pero los veredictos de huellas que siguen presentes se siguen mostrando.
- Se lanza solo desde el tablero, con estimación y confirmación, por la cola y el presupuesto diario, igual que Ultra y plantillas.

### E. Descartes guardados por Seki

- Archivo `<salida>/verificaciones/descartes/<repo>-<n>.json`: lista de `{ huella, regla, archivo, texto, motivo, autor: 'persona', propuestoPor: 'ia' | 'persona', fecha }`.
- `motivo` es obligatorio (1 a 500 caracteres). Si viene de la IA se rellena con su `razon` y la persona puede editarlo.
- Un hallazgo descartado se muestra en una sección "Dismissed" con su motivo y un botón "Reopen". No cuenta en el resumen por severidad ni en las señales de bloqueo.
- Los descartes se aplican al servir (tablero y `pr_verificaciones`), no dentro de los cachés de hallazgos.
- El comentario `seki-review: ignore <id>` sigue funcionando; el pie de la pestaña deja de recomendarlo como primera salida.

### F. Arreglo por la tubería de propuestas

- "Fix" en la fila de un hallazgo con línea pide primero confirmación, que muestra el tope de costo del trabajo; con `confirmar: true` crea en el servidor un comentario `cambio` sobre `archivo:linea` (lado `nuevo`), con `origenCheck: { huella, regla, archivo, linea, texto }` y el texto:
  `Fix the check "<titulo>" (<regla>) on this line. <mensaje> Change only what the finding needs.` más `AI triage: <razon>` si hay veredicto.
- Un hallazgo puede enviarse de nuevo a Fix solo si su petición anterior terminó en error o su propuesta fue descartada; con una petición en curso, lista o aprobada se rechaza con 409.
- El comentario entra a `proponerCambios` sin cambios en esa función. La propuesta guarda `check: { huella, regla, resuelto }`.
- `resuelto` es verdadero cuando el parche quita la línea señalada (mismo número de línea y mismo texto, con los espacios colapsados) y las reglas sobre el parche no devuelven la misma regla en ese archivo. Si es falso, la propuesta lo dice y Approve pide confirmación como con fallos.
- El título del commit de una propuesta con `check` tiene la forma `fix(<ámbito>): <qué>` (el prompt lo pide; si la IA no lo cumple se antepone `fix: `).
- Approve no cambia de mecánica. En una PR cuyo autor no es el usuario, el botón de Approve nombra al dueño de la rama en todos sus estados. Si la PR tiene gemela, tras el push se avisa que el arreglo no está en la gemela.

### G. Ultra recibe los Checks

- El contexto de las lentes `correccion` y `seguridad` incluye los hallazgos de Checks como "patrones sin confirmar".
- El paso de verificación recibe además una ficha por hallazgo triable (`id: check-<huella>`). `CONFIRMED` → `real`, `PLAUSIBLE` → `dudoso`, `REJECTED` → `falso_positivo`. Un `REJECTED` sin razón se guarda como `dudoso`. El resultado se escribe en el archivo de triaje con `origen: 'ultra'`, y solo para las huellas que un triaje guardado del mismo commit no ha juzgado; el triaje que ya existe no se reemplaza. Las fichas de Checks no aparecen entre los hallazgos de Ultra. Sin llamada adicional.
- Si no hay hallazgos de lentes pero sí de Checks, la verificación corre igual.

### H. Chat

`pr_verificaciones` devuelve además `triaje` (guardado) y `descartados`, y el enlace `#/pr/<repo>/<n>?checks=1`. La skill, en `verify`, muestra el triaje guardado y remite al tablero; nunca lanza el triaje desde el chat.

## 4. Fases

1. A y B. Elimina el falso positivo de hoy y deja lista la revalidación.
2. C, D, E y H. Pestaña Checks con veredicto, Dismiss y Reopen.
3. F. "Fix" por fila.
4. G. Checks dentro de Ultra.

Cada fase es usable por sí sola.

## 5. Fuera de alcance, pendiente de decisión

- **Replicar el arreglo en la PR gemela.** La gemela se detecta por parecido de título (`mcp/lib/gemelas.mjs`); aplicar el mismo parche en otra rama necesita su propio diseño. Esta versión solo avisa.
- **`--no-verify` en el commit de Approve** (`propuestas.mjs:267`). Se mantiene: el commit se hace en una copia temporal sin dependencias instaladas, donde los hooks del proyecto no pueden correr.
- **Caducidad de descartes y métrica de acierto por regla.** Los datos quedan guardados (veredicto de la IA y decisión de la persona); no se construye el informe.

## 6. Riesgos

- **Descartar un hallazgo real.** Lo acotan la confirmación humana, el motivo obligatorio, `dudoso` como salida por defecto y la confirmación individual de bloqueantes.
- **Arreglo que cambia el comportamiento.** Lo acotan las comprobaciones existentes de la propuesta, `resuelto` y la revisión del parche antes de Approve.
- **Texto de la PR como instrucción.** El prompt de triaje trata el contenido de la PR y de los hallazgos como datos, igual que `ultra-verificar.md`.
- **Costo.** Una llamada por PR con tope de 1 USD; la estimación sale de la mediana de `costos.jsonl` cuando haya tres ejecuciones.
