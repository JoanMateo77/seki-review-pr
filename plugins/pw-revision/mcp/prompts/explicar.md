Tarea: explicar una PR y guardar la explicación con la herramienta pr_guardar_explicacion. El mensaje ya trae los datos de la PR, el resumen de sus verificaciones automáticas y su diff (puede venir recortado). Llamar pr_detalle o pr_verificaciones solo si falta algo; leer archivos del checkout local solo si el diff recortado no alcanza, con lectura acotada (Grep y luego Read con offset y limit). No modificar archivos.

Campos de la explicación:
- resumen: una frase con lo que resuelve.
- por_que: el problema real (incidente, hallazgo de seguridad, caso de QA, pedido del banco). Si la descripción de la PR lo dice, usarlo; no inventar.
- que_cambia: cambios concretos, uno por elemento, en hechos ("La ruta X exige sesión").
- impacto_usuario: lo que nota quien usa el portal; "Ninguno visible" si es interno.
- tecnologias: solo las que el cambio usa de verdad. Para cada una: uso en este cambio, por qué esa y qué alternativas se descartaron y por qué. Si no hay una decisión real, no rellenar.
- alternativas: otras soluciones al problema completo y por qué no.
- como_probar: pasos verificables en pruebas, cada uno con su resultado esperado.
- riesgos y dependencias: SQL que debe correr antes, variables de entorno, PRs que van primero, orden de despliegue.
- riesgo: bajo, medio o alto según lo que puede romper en producción.
- esfuerzo: 1 a 5 para revisarla (1 = minutos; 5 = media jornada o más). Pesa más la lógica nueva que el tamaño.
- orden_lectura: archivos en el orden en que conviene leerlos, empezando por donde nace el cambio y dejando pruebas y vistas al final; un motivo corto por archivo; omitir los triviales.
- diagrama: solo si cambia un flujo entre componentes (portal, back, checkout, banco, cron). sequenceDiagram de Mermaid con participantes en lenguaje del negocio, sin nombres de funciones, a lo sumo 12 mensajes.

Al terminar, responder en una línea: "listo" o el motivo por el que no se pudo.
