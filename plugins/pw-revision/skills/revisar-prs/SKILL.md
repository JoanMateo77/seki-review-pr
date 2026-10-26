---
name: revisar-prs
description: Usar cuando se pide revisar qué PRs están pendientes de pasar a pruebas o a producción, entender o explicar una PR (qué cambia, tecnologías, por qué, alternativas, cómo probar), o abrir el tablero local de revisión de PRs de el equipo. Argumentos opcionales - "explicar <repo>#<n>", "explicar pendientes", "tablero".
---

# Revisar PRs (pw-revision)

Herramientas del servidor MCP `pw-revision`:

| Herramienta | Para qué |
|---|---|
| `prs_pendientes` | Foto de las PRs abiertas agrupadas por acción, con estado real frente a pruebas |
| `pr_detalle` | Descripción, commits y diff recortado de una PR, para entenderla |
| `pr_guardar_explicacion` | Guarda la explicación de una PR atada a su commit actual |
| `tablero_generar` | Escribe y abre `revision-prs/tablero.html` (archivo local) |

Todo queda en archivos locales. No publicar el tablero ni las explicaciones en Artifacts, Claude Docs ni ningún servicio externo.

## Flujo según el argumento

**Sin argumento o "pendientes":** llamar `prs_pendientes` y resumir por grupo. Señalar lo que exige acción: PRs de seguridad sin pasar a producción, "otra versión en pruebas" (hay que revisar diferencias), PRs viejas con conflicto. No repetir la lista entera si la persona solo pidió un resumen.

**"explicar <repo>#<n>":** `pr_detalle` → leer descripción, commits y diff → si el diff viene recortado y hace falta, leer el archivo en el checkout local con lectura acotada (grep + rango) → `pr_guardar_explicacion` → `tablero_generar`.

**"explicar pendientes":** tomar de `prs_pendientes` las PRs sin explicación o con explicación desactualizada, sin las de ramas inactivas. Priorizar seguridad y las que van a producción. Más de 5 PRs → repartir en subagentes con `model: "sonnet"`, cada uno con 3 a 5 PRs, y pedirles que llamen ellos mismos `pr_guardar_explicacion`. Al final, `tablero_generar`.

**"tablero":** `tablero_generar` (con `refrescar: true` si la foto tiene más de un día).

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

Reglas de texto: español formal e impersonal (nunca voseo ni tuteo), sin emojis, "cliente" y nunca "comercio" (salvo excepciones como "Cámara de Comercio"), "portal de pagos" para el portal de pagos del cliente. Sin nombres de funciones cuando no aportan a quien prueba.

## Significado de los estados

- **Ya está en pruebas:** el cambio aplicado al revés sobre la rama de pruebas entra limpio, o todos sus archivos son idénticos. Falta solo producción.
- **Otra versión en pruebas:** parte de los archivos coincide. Normalmente la PR de pruebas se ajustó después. Revisar diferencias antes de mergear a producción.
- **No está en pruebas:** el cambio entra limpio sobre pruebas (no está), o no coincide ningún archivo.
- **Gemela:** la PR equivalente contra la otra rama de la línea, detectada por título. Es una pista, no una prueba: confirmar con el estado.

La configuración de proyectos, repos y ramas está en `config/proyectos.json` del plugin. Para cambiarla sin tocar el plugin, crear `~/.config/pw-revision/proyectos.json` o definir `PW_REVISION_CONFIG`.
