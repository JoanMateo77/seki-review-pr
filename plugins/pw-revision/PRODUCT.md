# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Autor:** quien sube las PRs de un proyecto con varios repos y ramas por ambiente. Abre el tablero para decidir qué hacer hoy: qué mergear en pruebas, qué pasar a producción, qué quedó bloqueado o sin réplica.
- **Revisor:** otra persona del equipo que revisa esas PRs por separado, sin haber escrito el código. Necesita entender cada cambio (qué resuelve, por qué, cómo probarlo) y dejar su decisión.

## Product Purpose

Tablero local de revisión de PRs generado por el plugin `pw-revision`. Junta en una sola vista el estado real de cada PR frente a pruebas y producción, las verificaciones automáticas y la explicación del cambio. Éxito: el autor sabe en un minuto qué hacer hoy, y el revisor entiende y decide una PR sin abrir el diff completo.

## Positioning

A diferencia de la lista de PRs de GitHub, comprueba con git si el código ya está en pruebas o en producción, conoce las ramas hermanas de cada portal y aplica las reglas propias del proyecto, cada una con el incidente que la originó.

## Operating Context

- Archivo HTML local (`revision-prs/tablero.html`) abierto en el navegador. Nunca se publica en línea; se comparte como archivo.
- Se regenera desde Claude Code con `/pw-revision:revisar-prs`; los datos son una foto con fecha.
- Uso en oficina, en portátil, en jornada laboral; sesiones cortas y repetidas.

## Capabilities and Constraints

- HTML autocontenido, sin build ni dependencias; solo Mermaid se carga del CDN, y sin red se ve el texto.
- Lo que el revisor marca vive en su navegador; para devolverlo al autor se exporta e importa como archivo.
- Con el tablero servido, Aprobar una propuesta de cambio hace commit y push a la rama de la PR: es la única escritura hacia GitHub. Nunca hace merge ni publica comentarios.
- Textos en español formal e impersonal; "cliente", nunca "comercio"; sin emojis.

## Product Principles

1. Primero la acción: el orden de la cola dice qué hacer, no qué existe.
2. Evidencia antes que opinión: cada estado dice cómo se comprobó.
3. El revisor no necesita contexto previo para decidir una PR.
4. Nada sale de la máquina sin que alguien lo envíe a propósito.

## Mejoras futuras

- **Plugin para todo el equipo (anotado 27-10-2026, sin implementar).** Que cualquier persona del
  equipo lo instale y use en todos los proyectos, no solo uno: varias plantillas de revisión base
  (PCI DSS, OWASP web, migración SQL/DDL, pantallas y textos, integración bancaria, liviana) cargadas para todos los
  proyectos y compartidas desde un repositorio común en lugar de vivir solo en `~/.config/pw-revision/plantillas/`
  de cada máquina. Implica: configuración de proyectos sin rutas propias de una máquina, instalación del marketplace
  desde un remoto compartido, y versionado de las plantillas compartidas. Mientras tanto, las plantillas se guardan
  locales con un formato que ya sirva para compartirlas.
