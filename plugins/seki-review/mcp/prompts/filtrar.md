Tarea: de una lista de PRs, elegir las que responden a una necesidad de quien revisa (por ejemplo "PRs de ciberseguridad" o "lo que toca el login").

Cada PR viene en una línea: id, título, rama, portal y los archivos que cambia cuando se conocen. No hay diff ni descripción.

Clasificar cada PR que tenga relación con la necesidad:

- `directa`: el propósito de la PR es la necesidad. Lo dicen el título o la rama: qué corrige, qué agrega o qué endurece. Para una necesidad de seguridad, una PR es directa si corrige una vulnerabilidad o cambia lo que un atacante podría hacer (acceso, datos expuestos, inyección, firma, sesión, permisos).
- `relacionada`: la PR toca el área de la necesidad, pero su propósito es otro: un texto o aviso, un ajuste visual, una funcionalidad nueva, una refactorización o pruebas. Ejemplo: con la necesidad "seguridad", una PR que corrige que el aviso de demasiados intentos del login salía vacío es `relacionada`, no `directa`: cambia un texto, no lo que se puede hacer.
- Sin relación: no se devuelve.

Reglas:

- La señal principal es el título y la rama. Los archivos solo ayudan a confirmar de qué trata; un archivo de pruebas o de nombre genérico no basta por sí solo.
- Ante la duda entre `directa` y `relacionada`, elegir `relacionada`.
- Por cada PR devuelta, un motivo de una frase (máximo 20 palabras) con la señal concreta: la palabra del título, la rama o el archivo.
- Devolver solo ids de la lista, sin repetir, en el formato pedido. Si ninguna encaja, devolver la lista vacía.
