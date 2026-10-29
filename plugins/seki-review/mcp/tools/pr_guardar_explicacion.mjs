import { proyecto as cargarProyecto } from '../lib/config.mjs';
import { escribirJson, rutaExplicacion } from '../lib/cache.mjs';
import { ghJson } from '../lib/proceso.mjs';

const lista = { type: 'array', items: { type: 'string' } };

export default {
  name: 'pr_guardar_explicacion',
  description:
    'Saves a PR explanation for the dashboard, tied to the PR\'s current commit (if the PR changes, the explanation is marked as outdated). ' +
    'Write in formal, impersonal English, without function names unless they add value, and follow the writing rules in the project context (returned by pr_detalle).',
  inputSchema: {
    type: 'object',
    required: ['repo', 'numero', 'resumen', 'que_cambia', 'por_que'],
    properties: {
      proyecto: { type: 'string', description: 'Project key in proyectos.json; defaults to the default project if omitted' },
      repo: { type: 'string' },
      numero: { type: 'integer' },
      headSha: { type: 'string', description: 'PR commit that was analyzed, if the request specifies it; if omitted, the current commit on GitHub' },
      resumen: { type: 'string', description: 'One sentence: what the PR solves' },
      que_cambia: { ...lista, description: 'Concrete changes, one per item' },
      por_que: { type: 'string', description: 'Problem or finding that motivates the change' },
      impacto_usuario: { type: 'string', description: 'What a portal user notices' },
      tecnologias: {
        type: 'array',
        items: {
          type: 'object',
          required: ['nombre', 'uso'],
          properties: {
            nombre: { type: 'string' },
            uso: { type: 'string', description: 'What it is used for in this change' },
            por_que: { type: 'string', description: 'Why this one and not another' },
            alternativas_descartadas: lista,
          },
        },
      },
      alternativas: { ...lista, description: 'Other possible solutions and why they were not chosen' },
      como_probar: lista,
      riesgos: lista,
      dependencias: { ...lista, description: 'PRs, SQL or variables that must be deployed first' },
      cobertura: {
        type: 'object',
        description: 'How much of the diff was reviewed. completa=false if the diff was truncated and the rest was not read',
        required: ['completa'],
        properties: { completa: { type: 'boolean' }, sinDiff: { ...lista, description: 'Files that were not reviewed' }, recortados: { ...lista, description: 'Files reviewed only partially' } },
      },
      riesgo: { type: 'string', enum: ['bajo', 'medio', 'alto'] },
      esfuerzo: { type: 'integer', minimum: 1, maximum: 5, description: 'Review effort: 1 = minutes, 5 = half a day or more' },
      orden_lectura: {
        type: 'array',
        description: 'Files in the recommended reading order, starting where the change originates',
        items: {
          type: 'object',
          required: ['archivo', 'motivo'],
          properties: { archivo: { type: 'string' }, motivo: { type: 'string' } },
        },
      },
      diagrama: {
        type: 'string',
        description: 'Only if the change alters a flow between components: a Mermaid sequenceDiagram of the new flow, without function names',
      },
    },
  },
  // The explanation is tied to the commit that was read: if the PR moved on in the meantime, the dashboard marks it outdated.
  async handler({ proyecto, repo, numero, headSha, ...campos }) {
    const p = cargarProyecto(proyecto);
    const sha = /^[0-9a-f]{40}$/i.test(headSha ?? '') ? headSha
      : (await ghJson(['pr', 'view', String(numero), '-R', `${p.owner}/${repo}`, '--json', 'headRefOid'])).headRefOid;
    const ruta = rutaExplicacion(p.salida, repo, numero);
    escribirJson(ruta, { repo, numero, headSha: sha, fecha: new Date().toISOString(), ...campos });
    return `Explanation saved to ${ruta} (commit ${sha.slice(0, 7)}).`;
  },
};
