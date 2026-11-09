# Propuesta: método de plantillas para revisar PRs y generar comentarios en Seki Review

Estado: propuesta, pendiente de aprobación. Nada implementado. Fecha: 2026-11-09.
Rutas relativas a `plugins/seki-review/`.

## 1. Diagnóstico (verificado en el código)

1. **Seki ya revisa en dos capas, pero ninguna sigue una plantilla.**
   - Las reglas fijas (`mcp/lib/reglas.mjs:23-132` más `p.reglas`) son deterministas y citan la línea agregada.
   - Ultra corre tres revisiones fijas: corrección, seguridad y lineamientos (`mcp/lib/ultra.mjs:27`).
   - El checklist de seguridad mezcla OWASP Top 10 y datos de pago en un solo prompt, igual para toda PR (`mcp/prompts/ultra-seguridad.md:3-4`).
2. **No existe "qué se revisó".**
   - Solo hay lista de hallazgos (`ultra.mjs:32-39`). No hay ítems con estado cumple/falla/no aplica/no verificable.
   - Por eso una PR "sin hallazgos" no dice qué controles se miraron.
3. **La selección por ruta solo sugiere.**
   - `sugerirUltra` (`mcp/lib/perfiles.mjs:63-71`) compara las rutas cambiadas con `ia.rutasSensibles`.
   - No elige qué revisar ni qué checklist aplicar.
4. **La evidencia de la IA es parcial.**
   - `existeCita` comprueba que archivo y línea existan (`ultra.mjs:102-123`).
   - El schema no pide el fragmento literal, así que una línea real con un texto inventado pasa.
5. **El proceso real es pregunta libre más copia manual.**
   - Hoy se escribe "revisa si está en buenas prácticas y seguridad" y llega prosa libre (`REVAL/revision-prs/comentarios/core-mainback-482.json`). La cobertura depende de cómo se pregunte.
   - "Copy review" arma Markdown que se pega a mano en GitHub (`mcp/tablero/partes/05-script-2.js:81`).
   - Ese Markdown no usa Conventional Comments, aunque la skill `paymentsway-code-review` los exige (SKILL.md:29-44).
6. **Las plantillas ya están pensadas, no construidas.**
   - Están en `PRODUCT.md:48-60`, con las reglas de evidencia, determinismo, un solo modelo y aprobación humana.
   - También en la memoria `REVAL/memory/plugin-pw-revision.md` (27-10). No existe `~/.config/seki-review/plantillas/`.

## 2. Propuesta por piezas

**A. Formato de plantilla (Markdown con frontmatter, versionado en el plugin)**
- Ubicación: `plantillas/<id>.md` en el plugin como base. El proyecto puede sumar las suyas con `p.plantillas` (carpeta o repo).
  - Origen: PRODUCT.md, "Shared templates".
  - Se evita que vivan solo en una máquina.
- Contenido:
  ```yaml
  id: owasp-web
  version: 1
  aplicaA: ["src/Routes/**", "src/**/*Controller*.ts", "src/**/*.ejs"]
  excluir: ["**/__tests__/**"]
  reglas: [sql-interpolado, inner-html-variable, ejs-sin-escapar]   # ítems deterministas: los cubre pr_verificaciones
  items:
    - id: authz-ruta
      pregunta: "¿Toda ruta nueva o cambiada exige autenticación y autorización acordes?"
      evidencia: "middleware de montaje y verificación de permisos en el handler"
      siFalla: { severidad: alta, bloqueante: true }
  ```
- Juego inicial: `ligera` (siempre), `owasp-web`, `pci-dss` (datos de pago, 6.2.4), `integraciones` (timeouts, reintentos, idempotencia, firma de callbacks), `pantallas-textos` (copy, "recaudador", accesibilidad) y `sql-ddl`.
  - `sql-ddl` tendrá reglas deterministas al estilo squawk/strong_migrations. Hoy no hay PR abierta para probarla.

**B. Selector por rutas, con composición explícita**
- Se aplican todas las plantillas cuyo `aplicaA` coincida con algún archivo, más `ligera`. Es el modelo de Copilot `applyTo` y CodeRabbit `path_instructions`.
- El tablero muestra qué plantillas se activaron y por qué archivo, y cuáles no.
- Los globs se validan con `mcp/lib/patrones.mjs`, igual que `rutasSensibles`.

**C. Ejecución: una revisión de Ultra por plantilla activa, con estado por ítem**
- Se generaliza `LENTES` (`ultra.mjs:27`): `seguridad` se reemplaza por las plantillas activas. Así OWASP y PCI se activan por ruta.
- Schema por ítem: `{item, estado: cumple|falla|no_aplica|no_verificable, archivo, linea, cita, detalle}`.
- `cumple` y `falla` exigen `cita` literal. `existeCita` pasa a comprobar también que el fragmento esté en esa línea (±2). Sin cita, el ítem queda en `no_verificable`.
- Los ítems listados en `reglas:` toman su estado de `pr_verificaciones` y se marcan "determinista". El modelo no los evalúa (PRODUCT.md:51).
- Un solo modelo por plantilla, más la verificación CONFIRMED/PLAUSIBLE/REJECTED que ya existe. No se busca consenso entre modelos.

**D. Generación de comentarios (Conventional Comments, en español)**
- Cada `falla` confirmada produce un comentario así:
  `issue (blocking, seguridad): <asunto>`, luego `archivo:línea`, cita, por qué y la etiqueta `[owasp-web/authz-ruta]`.
- `blocking` solo se usa en ítems marcados así y confirmados. Lo demás va como `suggestion (non-blocking)` o `nitpick`.
- Los `no_verificable` se agrupan en un solo bloque, "Qué no se pudo verificar desde el diff". Ahí va el pedido concreto al autor.
- Lleva un `praise` tomado de un ítem `cumple` con cita, como exige la skill.
- Hay un tope de comentarios por plantilla, para controlar el ruido por diseño. No se usa la confianza autoinformada del modelo, que según Greptile está mal calibrada.
- Todo sale por "Copy review" y se pega a mano. Seki sigue sin publicar nada (principio 4). Esto encaja con PCI 6.2.3.1: aprueba un humano distinto del autor.

**E. Trazabilidad**
- Se guarda `<salida>/plantillas/<repo>-<n>.json` con: plantilla, versión, `headSha`, estado por ítem, verificaciones usadas y fecha.
- Si la PR avanza, el resultado queda desactualizado, como las explicaciones.

## 3. Descartado

- **Correr la misma plantilla con varios modelos y votar.** Los modelos comparten errores, así que el acuerdo no los descarta (PRODUCT.md:52).
- **Filtrar por puntaje de confianza del modelo.** Mal calibrado. Fuente: Greptile, vía https://www.zenml.io/llmops-database/improving-ai-code-review-bot-comment-quality-through-vector-embeddings
- **Publicar comentarios en GitHub desde Seki.** Rompe el principio 4. Se deja como decisión del usuario.

## 4. Fases (cada una usable sola)

1. **Prueba en seco, sin código, sobre una PR real.**
   - Se escriben `ligera`, `owasp-web` y `pci-dss` como archivos Markdown.
   - Se aplican a mano en esta sesión y se entrega la tabla de ítems con estado y cita, más el borrador de comentarios.
   - Sirve para validar el formato antes de construir.
2. **Plantillas en Seki:** formato, cargador y selector (A, B), revisión por plantilla y schema por ítem con cita literal (C), guardado (E) y pruebas.
3. **Comentarios:** "Copy review" genera Conventional Comments desde los ítems (D). El tablero muestra la checklist por PR.
4. **Plantilla `sql-ddl` y métricas.** Las reglas deterministas de migraciones entran en `p.reglas`. Se registra la tasa de comentarios atendidos por ítem para afinar o retirar ítems ruidosos.

## 5. Deuda que se paga en el camino (dentro del alcance)

- `SCHEMA_LENTE` sin fragmento citado (`ultra.mjs:32-39`): se agrega `cita` y su validación.
- `ultra-seguridad.md` mezcla OWASP y PCI: se separa en dos plantillas.
- `sugerirUltra` solo mira rutas sensibles: pasa a usar el mismo selector de plantillas.

## 6. Pendiente de decisión del usuario

- PR de prueba para la fase 1 (ver pregunta).
- Si alguna vez se publica en GitHub desde Seki. Se recomienda que no.

## 7. Riesgos y costos

- **Costo:** cada plantilla activa es una llamada más de IA por PR. Se mitiga con el tope por job que ya existe (`topeRevisarUltra`, `perfiles.mjs:44`) y con `ligera` como mínimo.
- **Ruido:** un estudio de 31.073 comentarios de CodeRabbit reporta 36,4 % aceptados. Es una cifra de segunda mano, no verificada en el paper. Por eso: tope por plantilla, `no_verificable` agrupado y cita obligatoria.
- **Presupuesto de Ultra:** `MAX_HALLAZGOS` 30 y `MAX_PARCHE` 60000 (`ultra.mjs:19-22`) se reparten entre plantillas. Habrá que decidir el tope por plantilla en la fase 2.
- **Fuentes no verificadas:** el texto oficial del PCI SSC (se usaron fuentes secundarias para 6.2.3 y 6.2.4), OWASP ASVS v5 y la cifra del 10 % de Google.
