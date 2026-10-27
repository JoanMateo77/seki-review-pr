import { iniciarServidor } from '../lib/servidor-web.mjs';

export default {
  name: 'tablero_servir',
  description:
    'Abre el tablero de revisión con acciones, servido en 127.0.0.1 mientras dure esta sesión (enlace fijo por máquina; si otra sesión ya lo sirve, abre ese): botón para actualizar el estado ' +
    '(qué se mergeó, qué es nuevo, qué cambió de grupo) y botones para analizar con IA una PR o todas las pendientes ' +
    '(lanza claude -p en segundo plano con modelo sonnet y solo herramientas de lectura). Nada se publica fuera del equipo.',
  inputSchema: {
    type: 'object',
    properties: {
      proyecto: { type: 'string', default: 'demo' },
      puerto: { type: 'integer', default: 4317 },
      abrir: { type: 'boolean', default: true },
    },
  },
  async handler({ proyecto = 'demo', puerto = 4317, abrir = true }) {
    const { url, yaEstaba } = await iniciarServidor({ proyecto, puerto, abrir });
    return `${yaEstaba ? 'El tablero ya estaba servido' : 'Tablero servido'} en ${url} (solo este equipo; el enlace incluye el token de acceso).`;
  },
};
