# Auditoría de plantillas de revisión (0.25.0): valor, costo, UX/UI y animaciones

Fecha: 2026-11-09. Rama `feat/seki-plantillas` (sin publicar). Cuatro agentes de solo lectura. Lo marcado como
"verificado" se comprobó abriendo el `archivo:línea`. Lo demás es hipótesis.

## 1. Diagnóstico

1. **El valor probado es determinista.**
   - En la prueba manual, el único bloqueante (el orden de despliegue entre repos) sale de la regla `rutas-en-otros-repos`, sin IA.
   - L4 lleva `reglas` y `itemsIa` lo excluye, así que no viaja a la IA (verificado).
   - La IA aporta el barrido cerrado con cita validada y los `no_verificable` con pedido al autor. Todos son no bloqueantes.
   - Veredicto: **sí es una mejora**. Hace la revisión sistemática y auditable, y detecta lo que ocurre fuera del diff. Pero la mitad de IA se solapa con Ultra.
2. **Solape con Ultra.**
   - `owasp-web` y `pci-dss` preguntan lo mismo que la lente `ultra-seguridad`: OWASP, monto decidido por el servidor, idempotencia, logs y credenciales.
   - Correr las dos cosas sobre el mismo commit paga dos veces la seguridad.
3. **El costo no aprovecha la caché.**
   - Las N llamadas (una por plantilla) repiten el mismo diff, de hasta 60.000 caracteres (≈15k tokens).
   - El prompt pone los ítems **antes** del diff (`revision-plantillas.mjs:213`, verificado). Así las llamadas no comparten prefijo y la caché no se reutiliza entre plantillas.
   - Los trabajos de plantillas no registran `uso` (tokens y caché) en `costos.jsonl` (`:273`, verificado). El resto de trabajos sí lo registra, así que hoy no se puede medir.
   - El perfil `ahorro` deja `plantilla` en sonnet (`perfiles.mjs:17-21`, verificado).
4. **La regla determinista tiene puntas de ruido.**
   - `git grep -F` compara por subcadena: `/v2/CrearTransaccionReferencia` coincide con `.../CrearTransaccionReferenciaMicrositio` (`rutas-cruzadas.mjs:59`, verificado).
   - Cuenta como uso cualquier coincidencia en tests, mocks y documentación del otro repo.
   - Un hallazgo determinista siempre bloquea.
   - El comentario usa solo `hallazgos[0]` y deja `detalle` vacío (`comentarios-plantilla.mjs:9,25`, verificado).
   - El resultado no guarda el SHA de las ramas de los otros repos. Si esa rama avanza, el L4 guardado envejece sin aviso.
5. **UX: tres fallas reales.**
   - Copy review omite en silencio los comentarios de plantillas si el resultado es viejo, y "Copied" no dice qué se copió (`07c-revisar.js:73`, verificado).
   - Un error de carga parpadea en cada sondeo ("Loading" → error) y no tiene botón Retry (`07d-plantillas.js:158-164`, verificado).
   - El detalle se repinta cada 3 s con el modal abierto (`08-script-5.js:46`, verificado). Eso deja el retorno de foco apuntando a un botón desconectado (`07b-modos.js:92`) y recrea la región `aria-live` y la barra de progreso en cada sondeo.
6. **Animaciones: no hay de entrada ni de cambio de estado.**
   - El modal y su fondo aparecen de golpe (`02c-modos.css:7-8`, verificado). Los resultados aparecen sin transición. La confirmación de copia cambia el texto en seco y hace saltar el ancho del botón.
   - Lo que existe es correcto y respeta `prefers-reduced-motion` (`02-estilos.css:381`): giro, barra indeterminada, esqueleto y latido.

Corrección a un agente: el tablero **sí** marca el resultado viejo y Copy review lo excluye (`07c:58`, `07d:138`). Lo que falta es decirlo.

## 2. Propuesta por piezas

### A. Costo (origen: dolor "optimizar tokens", hallazgo 3, práctica oficial de prompt caching)

1. **Reordenar el prompt:** contexto de la PR (repos, archivos, diff) primero y la plantilla y sus ítems al final.
   - Las llamadas 2..N leen el prefijo cacheado a 0,1× (0,05× en Sonnet/Opus 5.5) del precio de entrada, según la doc de Anthropic.
   - La primera plantilla se espera antes de lanzar el resto, para que la caché exista.
   - Riesgo de calidad: nulo.
2. **Registrar `uso`** (entrada, caché creada y leída, salida) por paso en `costos.jsonl`, y `modelo` por muestra. Sin esto no se puede probar el ahorro.
3. **Reutilizar por huella:** por plantilla, hash de (versión de la plantilla + parches de los archivos que la activan + SHA de las ramas de otros repos).
   - Si llega un commit nuevo que no toca esos archivos, se copia el resultado de esa plantilla sin llamar a la IA.
   - Los ítems deterministas se recalculan siempre (son gratis).
4. **Estimación** por plantilla (el id ya está en `detalle[]`), con percentil 75 en lugar de mediana y escalada por tamaño del diff. Hoy una PR de 3 líneas y una de 60k caracteres muestran el mismo costo.
5. **Descartado:** recortar el diff por plantilla. Rompe el prefijo común que aprovecha la pieza 1. Se revisa solo si la medición de la pieza 2 muestra que la caché no rinde.

### B. Valor (hallazgos 1, 2 y 4)

1. **Endurecer `rutas-en-otros-repos`:**
   - Coincidencia con límite de segmento: después de la ruta no puede seguir `[\w-]`.
   - Las coincidencias en tests, mocks, `__tests__`, `*.spec.*`, `*.test.*` y docs del otro repo bajan a "no bloqueante" con su nota.
   - Detectar `router.route('/x').post(`.
   - Pruebas con la ruta-prefijo del caso real.
2. **Comentario determinista completo:** todos los hallazgos (repo, rama, archivo:línea) y `detalle` con riesgo y propuesta. Por ejemplo: "si se despliega X antes que esta PR, responde 404; fusionar y desplegar esta PR primero".
3. **SHA de las otras ramas** guardado en el resultado. Si cambia, el resultado se marca viejo con el motivo "the branch <rama> of <repo> moved".
4. **Recorte visible en lo copiado:** "N more comments not included (at most 5 per template)" al final del markdown.
5. **Solape con Ultra (decidido 2026-11-09):** si hay un resultado vigente (mismo `headSha`) de `owasp-web` o `pci-dss`, Ultra omite la lente de seguridad y lo dice en el modal y en el resultado ("Security lens skipped: covered by the template review of this commit"). La estimación de Ultra baja en consecuencia.

### C. UX/UI (dolor "interacción óptima", agente UX)

Fallas (se corrigen sí o sí):
1. Copy review dice qué copió:
   - "Copied · includes template comments";
   - "Copied · template result is outdated, not included";
   - "Copied · no template review".
   - El texto también va a una región `role=status` oculta.
2. Error de carga estable con botón "Try again". No se reintenta solo en cada sondeo.
3. Con el modal abierto no se repinta el detalle. Al cerrar, si el botón de origen ya no existe, el foco vuelve a `[data-plantillas-abrir]` del DOM actual. Arregla también Ultra, porque comparte el modal.
4. La región de progreso se crea una vez: solo cambia el texto del tiempo y la barra no se reinicia.
5. Confirmar deshabilita el botón ("Starting…"). Un 409 "ya en cola" se trata como éxito.
6. Atajos j/k, `/`, `[`, `]` y `o` inactivos con el modal abierto. El fondo pasa a `inert` mientras el modal está abierto.
7. Un solo criterio de resultado viejo, `plantillasVigentes`, en el modal y en la pestaña (hoy el modal mira solo `desactualizada`).
8. `?plantillas=1` se limpia del hash al abrir (con `replaceState`). `decodeURIComponent` va dentro de try/catch.
9. Robustez:
   - `Object.hasOwn` en `ESTADO_ITEM`;
   - `overflow-wrap:anywhere` en `.modal`;
   - `flex-wrap` en `.modal-pie`;
   - botón de copia con ancho estable y su icono intacto.
10. Estados sin cubrir:
    - sin plantillas aplicables: mensaje propio y sin botón de IA (solo reglas fijas);
    - PR cerrada: explica por qué no hay botón;
    - job fallido: "Try again" dentro del aviso.

Jerarquía (mejora):

11. Resumen arriba: "2 failing · 3 questions for the author · 12 pass". Después, las fallas ordenadas (bloqueantes primero) y los pedidos al autor.
12. `cumple` y `no_aplica` van plegados en `<details>` por plantilla.
13. Los comentarios para pegar suben, justo después del resumen.
14. El contador de la pestaña suma fallas y pedidos.
15. Contraste: `--texto-3` de #80848b a ≈#6b6f76 (3,76:1 → ≈5:1 en claro). Es un token global, así que mejora todo el tablero. Hay que verificarlo en oscuro.

### D. Animaciones (dolor "animaciones de calidad alta")

Criterio: 150-250 ms, ease-out, solo `transform` y `opacity`. Con `prefers-reduced-motion: reduce`, solo un fundido corto, sin desplazamiento. Fuentes: Kowalski, Material 3 y MDN.

1. **Modal:**
   - entrada: fondo con opacidad de 0 a 1 en 160 ms ease-out. La caja con opacidad de 0 a 1, `translateY(8px)` a 0 y `scale(.98)` a 1, en 200 ms con `cubic-bezier(.16,1,.3,1)`;
   - salida: 120 ms ease-in, con la clase `.saliendo` y luego `remove()`.
2. **Revelado del resultado:**
   - al pasar de "corriendo" a "resultado", los ítems entran escalonados: opacidad y `translateY(4px)`, 220 ms, retraso de `min(i·30, 240)` ms;
   - solo la primera vez por commit (marca en el estado), nunca en cada sondeo.
3. **Fin del progreso:** la barra completa `scaleX(1)` en 200 ms y se desvanece en 150 ms, en lugar de desaparecer.
4. **Copia:**
   - éxito: el botón hace `scale(.96)` a 1 en 140 ms con `cubic-bezier(.34,1.56,.64,1)`, y el borde se pone `--verde` durante 1,4 s;
   - fallo: dos sacudidas de ±2 px en 160 ms;
   - con movimiento reducido, solo el color.
5. **Plegado** de `cumple`/`no_aplica` y del aviso de resultado viejo: `grid-template-rows` de 0fr a 1fr en 200 ms.
6. Todas las clases nuevas entran en la regla de movimiento reducido de `02-estilos.css:381`.

## 3. Fases (cada una usable por sí sola)

1. **Correcciones y medición:** C1-C10, A1, A2, B1-B4. Sin decisiones pendientes. Pruebas en `node:vm` y en las suites existentes.
2. **Jerarquía y animaciones:** C11-C15 y D1-D6, con capturas de antes y después a 360, 768 y 1280 px, en claro y oscuro.
3. **Ahorro por reutilización:** A3 y A4.
4. **Solape con Ultra:** B5.

Todo entra en la misma rama, antes de publicar 0.25.0, que aún no se ha publicado. La versión no cambia.

## 4. Deuda que se paga en el camino

Retorno de foco del modal compartido con Ultra; contraste de `--texto-3`; registro de `uso` ausente en plantillas.

## 5. Pendiente de decisión del usuario

- Decidido 2026-11-09: Ultra omite la lente de seguridad si hay plantillas de seguridad vigentes (B5). Las plantillas siguen en sonnet en todos los perfiles; el ahorro viene de A1-A3.
- **Redacción de los ítems vagos** (L1, L3, L5, P3, P6) y si L1, W7 y P4 deben seguir siendo bloqueantes. Es contenido de las plantillas, o sea producto.
- **Selector por contenido del diff** (por ejemplo `apikey`, `Transacc`) además de los globs. Requiere definir qué palabras se usan.

## 6. Riesgos y costos

- La caché del CLI con `--system-prompt` propio no está verificada en la práctica. A2 la mide antes de dar por hecho el ahorro.
- Las cifras de caching vienen de la doc oficial de Anthropic. El ahorro real por PR no está medido.
- Bajar el nivel de los hallazgos en tests del otro repo puede ocultar un caso real (un e2e que llama a la ruta). Por eso baja a no bloqueante, no se descarta.
- No se probó en navegador real ni con lector de pantalla. La fase 2 incluye capturas y un recorrido solo con teclado.
