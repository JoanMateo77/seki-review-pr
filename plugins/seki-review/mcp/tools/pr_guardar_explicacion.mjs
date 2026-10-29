import { proyecto as cargarProyecto } from '../lib/config.mjs';
import { escribirJson, rutaExplicacion } from '../lib/cache.mjs';
import { ghJson } from '../lib/proceso.mjs';

const lista = { type: 'array', items: { type: 'string' } };

export default {
  name: 'pr_guardar_explicacion',
  description:
    'Guarda la explicación de una PR para el tablero, atada al commit actual de la PR (si la PR cambia, queda marcada como desactualizada). ' +
    'Redactar en español formal e impersonal, sin nombres de funciones cuando no aporten, y con las reglas de texto del contexto del proyecto (pr_detalle lo trae).',
  inputSchema: {
    type: 'object',
    required: ['repo', 'numero', 'resumen', 'que_cambia', 'por_que'],
    properties: {
      proyecto: { type: 'string', description: 'Clave del proyecto en proyectos.json; si se omite, el predeterminado' },
      repo: { type: 'string' },
      numero: { type: 'integer' },
      headSha: { type: 'string', description: 'Commit de la PR que se analizó, si el mensaje lo indica; si se omite, el commit actual en GitHub' },
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
      cobertura: {
        type: 'object',
        description: 'Qué parte del diff se revisó. completa=false si el diff vino recortado y no se leyó el resto',
        required: ['completa'],
        properties: { completa: { type: 'boolean' }, sinDiff: { ...lista, description: 'Archivos que no se revisaron' }, recortados: { ...lista, description: 'Archivos revisados solo en parte' } },
      },
      riesgo: { type: 'string', enum: ['bajo', 'medio', 'alto'] },
      esfuerzo: { type: 'integer', minimum: 1, maximum: 5, description: 'Esfuerzo de revisión: 1 = minutos, 5 = media jornada o más' },
      orden_lectura: {
        type: 'array',
        description: 'Archivos en el orden en que conviene leerlos, empezando por donde nace el cambio',
        items: {
          type: 'object',
          required: ['archivo', 'motivo'],
          properties: { archivo: { type: 'string' }, motivo: { type: 'string' } },
        },
      },
      diagrama: {
        type: 'string',
        description: 'Solo si el cambio altera un flujo entre componentes: sequenceDiagram de Mermaid con el flujo nuevo, sin nombres de funciones',
      },
    },
  },
  // La explicación se ata al commit que se leyó: si la PR avanzó mientras tanto, el tablero la marca desactualizada.
  async handler({ proyecto, repo, numero, headSha, ...campos }) {
    const p = cargarProyecto(proyecto);
    const sha = /^[0-9a-f]{40}$/i.test(headSha ?? '') ? headSha
      : (await ghJson(['pr', 'view', String(numero), '-R', `${p.owner}/${repo}`, '--json', 'headRefOid'])).headRefOid;
    const ruta = rutaExplicacion(p.salida, repo, numero);
    escribirJson(ruta, { repo, numero, headSha: sha, fecha: new Date().toISOString(), ...campos });
    return `Explicación guardada en ${ruta} (commit ${sha.slice(0, 7)}).`;
  },
};
