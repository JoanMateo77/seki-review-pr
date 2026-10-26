import { proyecto as cargarProyecto } from '../lib/config.mjs';
import { escribirJson, rutaExplicacion } from '../lib/cache.mjs';
import { ghJson } from '../lib/proceso.mjs';

const lista = { type: 'array', items: { type: 'string' } };

export default {
  name: 'pr_guardar_explicacion',
  description:
    'Guarda la explicación de una PR para el tablero, atada al commit actual de la PR (si la PR cambia, queda marcada como desactualizada). ' +
    'Redactar en español formal e impersonal, sin nombres de funciones cuando no aporten, y decir "cliente", nunca "comercio".',
  inputSchema: {
    type: 'object',
    required: ['repo', 'numero', 'resumen', 'que_cambia', 'por_que'],
    properties: {
      proyecto: { type: 'string', default: 'demo' },
      repo: { type: 'string' },
      numero: { type: 'integer' },
      resumen: { type: 'string', description: 'Una frase: qué resuelve la PR' },
      que_cambia: { ...lista, description: 'Cambios concretos, uno por elemento' },
      por_que: { type: 'string', description: 'Problema o hallazgo que origina el cambio' },
      impacto_usuario: { type: 'string', description: 'Qué nota quien usa el portal' },
      tecnologias: {
        type: 'array',
        items: {
          type: 'object',
          required: ['nombre', 'uso'],
          properties: {
            nombre: { type: 'string' },
            uso: { type: 'string', description: 'Para qué se usa en este cambio' },
            por_que: { type: 'string', description: 'Por qué esta y no otra' },
            alternativas_descartadas: lista,
          },
        },
      },
      alternativas: { ...lista, description: 'Otras soluciones posibles y por qué no se eligieron' },
      como_probar: lista,
      riesgos: lista,
      dependencias: { ...lista, description: 'PRs, SQL o variables que deben ir antes' },
      riesgo: { type: 'string', enum: ['bajo', 'medio', 'alto'] },
    },
  },
  async handler({ proyecto, repo, numero, ...campos }) {
    const p = cargarProyecto(proyecto);
    const { headRefOid } = await ghJson(['pr', 'view', String(numero), '-R', `${p.owner}/${repo}`, '--json', 'headRefOid']);
    const ruta = rutaExplicacion(p.salida, repo, numero);
    escribirJson(ruta, { repo, numero, headSha: headRefOid, fecha: new Date().toISOString(), ...campos });
    return `Explicación guardada en ${ruta} (commit ${headRefOid.slice(0, 7)}).`;
  },
};
