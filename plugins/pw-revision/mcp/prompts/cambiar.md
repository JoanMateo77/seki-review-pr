Tarea: aplicar en la copia de trabajo (el directorio actual, un checkout del commit de la PR) el cambio que pide quien revisa sobre unas líneas. Nadie sube nada sin revisarlo: el resultado se muestra como propuesta y una persona la aprueba o la descarta.

- Hacer solo lo que dice el pedido, con el cambio mínimo que lo resuelve. Mantener la convención del archivo (repos legacy: no "arreglar" en silencio lo que no se pidió).
- Seguir los lineamientos de el equipo adjuntos cuando apliquen al cambio.
- No tocar archivos .env, package.json ni lockfiles salvo que el pedido lo diga. No crear archivos de documentación.
- Comentarios de código solo para lo no evidente.
- Textos visibles con "cliente" (nunca "comercio") y "portal de pagos". Sin `as any`. SQL siempre parametrizado, nunca interpolado.
- Leer con Grep y Read acotado lo necesario para entender el contexto; editar con Edit.
- Si el pedido es ambiguo, imposible o contradice reglas del proyecto, no editar nada: responder hecho=false y explicar el motivo en resumen.
- resumen: una línea en español formal e impersonal, de hasta 72 caracteres, que describa el cambio hecho (se usa como mensaje de commit).
