# Design

Tablero de revisión de PRs (`mcp/tablero/plantilla.html`). Modo Operate: herramienta de trabajo diario. Referencias tomadas de Mobbin (27-10-2026): GitHub (lista de PRs), Linear (grupos colapsables, bandeja dividida), Graphite y GitLab (detalle de PR con secciones fijas y pila de estados), Vercel (estado como punto más palabra).

## Estructura

- Barra superior: proyecto, fecha de la foto, búsqueda (`/`), selector Autor / Revisor.
- Lateral (segunda capa neutra): vistas, portal y filtros con conteos; exportar e importar revisión; atajos.
- Cola: grupos colapsables por acción (autor) o por decisión del revisor; filas de una línea con punto de tono, id en mono, título truncado y hasta cuatro señales (hallazgos, revisión, seguridad, esfuerzo, días).
- Detalle: estado, título, rama y tamaño; acciones; pila de estados (pruebas, producción, gemela, otros portales, verificaciones, revisor); pestañas Resumen, Archivos (diff unificado estilo GitHub: índice con +/−, archivos plegables, casilla Visto, orden de lectura, hallazgos bajo su línea, Ampliar), Verificaciones, Cómo probar, Revisión.
- Lateral plegable con el botón de la barra o `[`; el estado se recuerda en el navegador.
- Comentarios en el diff: clic en el número de línea selecciona, Shift + clic extiende el rango dentro del archivo. Bajo la selección aparece una caja con tres tipos (Preguntar, Pedir cambio, Nota con código sugerido opcional). Los comentarios se muestran como hilos bajo su última línea; los que ya no coinciden con el diff van en un bloque "Comentarios sobre líneas que cambiaron" al inicio del archivo. Preguntas y pedidos de cambio son borradores hasta enviarlos desde la barra "Revisión pendiente (N)", fija al pie de la pestaña.
- Menos de 900 px: lateral como fila deslizable, cola y detalle como vistas separadas con botón "Cola".

## Color

Neutros cálidos; el color solo marca estado. Un tono por PR, el más grave: rojo bloquea (verificación bloqueante o seguridad sin salir a producción), ámbar pide mirar, verde listo para producción, violeta mergeada. Acento azul solo para la acción primaria, la selección y el foco. Claro por defecto, oscuro con `prefers-color-scheme`; los dos juegos de tokens están en `:root`.

## Tipografía

Sans del sistema. Escala de producto: 12 px (metadatos, conteos, mono), 13 px (texto y controles), 20 px (título de la PR). Mono solo para ids, ramas, rutas y código. Números tabulares.

## Componentes

- Estado: píldora con fondo tintado y texto del mismo tono.
- Check: icono, nombre y valor con una línea de evidencia debajo ("cómo se comprobó").
- Iconos: símbolos SVG propios, trazo 1.6, 14 px. Sin emojis ni glifos Unicode.

## Rechazos deliberados

Sin fichas de números grandes, sin tarjetas por fila, sin sopa de etiquetas, sin etiquetas en mayúsculas sobre los títulos, sin bordes laterales de color. La versión anterior tenía todo eso.
