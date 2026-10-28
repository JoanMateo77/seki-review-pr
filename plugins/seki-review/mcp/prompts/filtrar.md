Tarea: de una lista de PRs, elegir las que responden a una necesidad de quien revisa (por ejemplo "PRs de ciberseguridad" o "lo que toca el login").

Cada PR viene en una línea: id, título, rama, portal y los archivos que cambia cuando se conocen. No hay diff ni descripción.

- Incluir una PR si el título, la rama o los archivos muestran que trata de la necesidad, aunque no use las mismas palabras. Para seguridad cuentan, entre otros: inyección, XSS y escape de valores, autenticación, sesión, MFA, contraseñas, permisos y roles, control de acceso por URL, firma de enlaces, secretos, validación de archivos subidos, CSP.
- La señal principal es el título y la rama: dicen de qué trata la PR. Los archivos suman solo si muestran que el cambio central es de la necesidad.
- Un archivo de pruebas no basta por sí solo: que una suite se llame parecido a la necesidad no hace que la PR trate de ella.
- No incluir una PR solo porque podría tener relación. Si la única señal es débil (un archivo de nombre genérico o de pruebas), dejarla fuera.
- Por cada PR incluida, un motivo de una frase (máximo 20 palabras) con la señal concreta: la palabra del título, la rama o el archivo.
- Devolver solo ids de la lista, sin repetir, en el formato pedido. Si ninguna encaja, devolver la lista vacía.
