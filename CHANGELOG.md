# Cambios

Cada versión tiene su etiqueta `seki-review-vX.Y.Z` en el commit que la publica.

## seki-review

### 0.19.3 (2026-10-28)
- Relevo entre sesiones: las sesiones de Claude Code que no sirven el tablero quedan de reserva y, si la que lo sirve se cierra, una de ellas lo toma en el mismo enlace a los pocos segundos.
- Solo una versión más nueva pide el puerto (comparación numérica): una sesión vieja ya no le quita el tablero a una nueva.
- La página se reconecta sola: sin servidor muestra "Sin conexión: reintentando" y vuelve a consultar cada 5 segundos.

### 0.19.2 (2026-10-28)
- Con varias sesiones de Claude Code abiertas, el tablero lo servía la primera que lo abrió, aunque tuviera una versión vieja del plugin. Ahora, si el tablero abierto es de otra versión y no tiene trabajos en curso, la sesión nueva le pide el puerto y lo sirve en el mismo enlace. Con trabajos en curso, o si la versión vieja no sabe ceder, se avisa qué hacer.

### 0.19.1 (2026-10-28)
- Si el plugin se actualiza con el tablero abierto, la página (que se lee del disco) es más nueva que el servidor (que sigue en memoria): el tablero lo avisa con ambas versiones y pide reiniciar Claude Code, en vez de responder "No existe" al usar una función nueva.

### 0.19.0 (2026-10-28)
- Filtro con IA: se escribe una necesidad en el buscador ("PRs de ciberseguridad") y "Filtrar con IA" (o Ctrl + Enter) deja en la cola solo las PRs que encajan, cada una con su motivo. La IA decide con título, rama y archivos, sin leer el diff (unos segundos, centavos por consulta).
- El resultado se guarda por necesidad y estado de la cola: repetirlo no cuesta mientras ninguna PR cambie; si la cola cambia, el aviso ofrece volver a filtrar.
- "Guardar como vista" deja la necesidad en "Vistas con IA" de la barra lateral.
- El buscador conserva un ancho mínimo y el texto de gasto se recorta en pantallas medianas.

### 0.18.0 (2026-10-28)
- Seleccionar texto en la respuesta de la IA de un hilo (Resumen o Archivos) abre la barra para repreguntar sobre ese fragmento: la pregunta queda en el mismo hilo, cita el fragmento y lo resalta en la respuesta. La IA recibe el fragmento como parte de la respuesta anterior, no de la explicación. La caja de pregunta sobre toda la PR se mantiene.
- Avance real mientras la IA trabaja: etapas (copias, lectura, cambio, comprobaciones, corrección) y cuántos archivos leyó y buscó, con el último archivo abierto; también en el análisis de la PR.
- Aviso cuando un trabajo tarda más de lo habitual, con el límite de 10 minutos.
- La barra y el ícono de progreso ya no se reinician con cada actualización del tablero (cada 3 s).
- El reloj de los trabajos en curso no se anuncia cada segundo en lectores de pantalla.
- El pie de las respuestas pasa a otra línea en lugar de cortar las palabras.

### 0.17.1 (2026-10-28)
- Mientras la IA trabaja en una pregunta o un cambio, el hilo muestra qué está haciendo, el tiempo transcurrido, una barra en movimiento y cuánto suele tardar; la respuesta anterior queda atenuada. El estado late en lugar de quedarse quieto.
- El tablero se titula Seki Review.

### 0.17.0 (2026-10-28)
- Nuevo nombre: Seki Review (`seki-review`, antes `pw-revision`). Comando `/seki-review:revisar-prs`; variables de entorno `SEKI_*`.
- Herramienta general: la configuración de proyectos, su contexto (stack y reglas de texto) y sus reglas propias viven en `~/.config/seki-review/proyectos.json`; el plugin trae solo un ejemplo.
- Sin proyecto indicado se usa `SEKI_PROYECTO` o el primero de la configuración.
- Las reglas genéricas explican su motivo sin referirse a incidentes de un proyecto.

### 0.16.0 (2026-10-28)
- Cada afirmación dice su origen: explicación de IA, reglas fijas (Verificaciones) o nota de la persona.
- La explicación registra la cobertura del diff y muestra "Cobertura parcial" con los archivos no revisados.
- Investigar guarda los archivos que la IA abrió, sus búsquedas y los intentos que bloquearon los permisos.
- "¿Sirvió? Sí / No" en cada respuesta; costo de 30 días por modelo frente a respuestas útiles.
- Aprobar registra el intento antes del push y, si el proceso se corta, reconoce el commit ya subido en vez de repetirlo.
- Prompts contra respuestas complacientes; prueba real de permisos opcional (`SEKI_PRUEBA_REAL=1`).
- Corrige la prueba inestable: el repositorio de prueba no detectaba un cambio de igual tamaño hecho en el mismo instante.

### 0.15.0 (2026-10-28)
- Pestaña Descripción con la descripción de la PR y sus commits.

### 0.14.0 (2026-10-27)
- Investigar lee los otros repos en su rama equivalente de pruebas o producción, guarda qué leyó y limpia las copias viejas.
- Preguntar sobre código seleccionado en Archivos.

### 0.13.0 (2026-10-27)
- Investigar en el código (solo lectura, sin secretos), hilos completos al repreguntar y respuestas con formato.

### 0.12.0 (2026-10-27)
- Preguntar sobre texto seleccionado del resumen, con cita resaltada y envío en lote.

### 0.11.0 (2026-10-27)
- Cola más angosta y ocultable; preguntar y ampliar secciones del resumen.

### 0.10.1 (2026-10-27)
- Animación de trabajo en curso.

### 0.10.0 (2026-10-27)
- La skill abre el tablero servido; enlace fijo por máquina.

### 0.9.0 (2026-10-27)
- Correcciones de la revisión final: permisos de edición, comentarios colgados, XSS, cadena de aprobaciones y forks.

### 0.8.0 (2026-10-27)
- Pedidos de cambio con propuesta comprobada, ajuste y aprobación que sube a la rama.

### 0.7.0 (2026-10-27)
- Preguntas a la IA sobre líneas, agrupadas por PR, con caché y costo visible.

### 0.6.0 (2026-10-27)
- Menú lateral plegable, selección de líneas y notas manuales con código sugerido.

### 0.5.0 (2026-10-27)
- Pestaña Archivos con diff estilo GitHub.

### 0.4.0 (2026-10-27)
- Tablero servido con acciones (actualizar estado, analizar con IA).

### 0.3.0 (2026-10-27)
- Tablero como bandeja de revisión; vista de revisor con exportar e importar.

### 0.2.0 (2026-10-26)
- Verificaciones fijas, PRs de pruebas sin producción, gemelas entre portales, esfuerzo, orden de lectura y diagrama.

### 0.1.0 (2026-10-26)
- Servidor MCP, skill revisar-prs y tablero local de PRs.
