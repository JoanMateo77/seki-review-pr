# Cambios

Cada versión tiene su etiqueta `pw-revision-vX.Y.Z` en el commit que la publica.

## pw-revision

### 0.16.0 (2026-10-28)
- Cada afirmación dice su origen: explicación de IA, reglas fijas (Verificaciones) o nota de la persona.
- La explicación registra la cobertura del diff y muestra "Cobertura parcial" con los archivos no revisados.
- Investigar guarda los archivos que la IA abrió, sus búsquedas y los intentos que bloquearon los permisos.
- "¿Sirvió? Sí / No" en cada respuesta; costo de 30 días por modelo frente a respuestas útiles.
- Aprobar registra el intento antes del push y, si el proceso se corta, reconoce el commit ya subido en vez de repetirlo.
- Prompts contra respuestas complacientes; prueba real de permisos opcional (`PW_PRUEBA_REAL=1`).
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
