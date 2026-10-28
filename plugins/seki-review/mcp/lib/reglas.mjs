// Reglas fijas que se corren sobre las líneas que agrega una PR. Cada una nace de un incidente o
// una regla del proyecto; el campo `origen` lo dice para que quien revisa entienda por qué importa.
// Una línea se excluye de una regla con el comentario `seki-review: ignorar <id>`.
//
// Campos: id, titulo, severidad (bloqueante | alto | medio | aviso), archivos (regex sobre la ruta),
// repos (opcional), patron (regex sobre la línea agregada), excluir (opcional), cuando(linea, archivo)
// (opcional, filtro extra), mensaje, origen.

const VISTAS = /\.(ejs|html)$/;
const CODIGO = /\.(ts|js|mjs|cjs)$/;
const PRUEBAS = /(__tests__|\.spec\.|\.test\.)/;
const FRAGMENTO_SQL = /^(filtro|filtros|where|condicion\w*|clausula\w*|orden|order\w*|limit\w*|offset|paginacion|sql\w*|campos?|columnas?|placeholders?|tabla|schema|esquema)$/i;

export const SEVERIDADES = ['bloqueante', 'alto', 'medio', 'aviso'];

export const REGLAS = [
  {
    id: 'sql-interpolado',
    titulo: 'SQL armado con valores pegados',
    severidad: 'bloqueante',
    archivos: CODIGO,
    patron: /(\b(where|andWhere|orWhere|having|query|innerJoin|leftJoin)\s*\(\s*`[^`]*\$\{)|(`[^`]*\b(SELECT|UPDATE|DELETE|INSERT|WHERE|AND|OR)\b[^`]*\$\{)/,
    excluir: PRUEBAS,
    // `${n}` es un marcador posicional de PostgreSQL armado con un número: no inyecta nada.
    // Un fragmento con nombre de cláusula (filtro, where, orden) baja a aviso: hay que mirar cómo se arma.
    severidadPara: (linea) => {
      const valores = [...linea.matchAll(/(\$?)\$\{\s*([^}]*)\}/g)].filter((m) => !m[1]).map((m) => m[2].trim());
      if (!valores.length) return null;
      return valores.every((v) => FRAGMENTO_SQL.test(v)) ? 'aviso' : 'bloqueante';
    },
    mensaje: 'Pasar el valor como parámetro (`:nombre`, { nombre }) en lugar de interpolarlo en el SQL.',
    origen: 'Inyección SQL: el valor interpolado viaja dentro de la consulta.',
  },
  {
    id: 'secreto-en-codigo',
    titulo: 'Posible secreto escrito en el código',
    severidad: 'bloqueante',
    archivos: /./,
    patron: /\b(api[_-]?key|secret|secreto|password|passwd|token|aws_secret_access_key|redis_password)\b\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
    excluir: PRUEBAS,
    mensaje: 'Mover el valor a variables de entorno; nunca commitearlo.',
    origen: 'Una credencial commiteada queda en el historial aunque luego se borre.',
  },
  {
    id: 'archivo-env',
    titulo: 'Archivo de entorno en la PR',
    severidad: 'bloqueante',
    archivos: /(^|\/)(\.env(\..*)?|[a-z]+\.env)$/,
    porArchivo: true,
    mensaje: 'Los archivos .env contienen secretos reales y no deben viajar en una PR.',
    origen: 'Los archivos de entorno suelen tener credenciales reales.',
  },
  {
    id: 'ejs-sin-escapar',
    titulo: 'Salida EJS sin escapar (<%-)',
    severidad: 'alto',
    archivos: /\.ejs$/,
    patron: /<%-(?!\s*include\b)/,
    // JSON embebido con < escapado es la forma segura de pasar datos a un <script type="application/json">.
    excluir: /<%-\s*JSON\.stringify\(.*\.replace\(\/<\/g/,
    mensaje: 'Usar <%= %> salvo que el valor sea HTML de confianza; confirmar que no llega de la petición.',
    origen: 'XSS: <%- inserta el valor como HTML.',
  },
  {
    id: 'ejs-comentario-en-template',
    titulo: 'Comentario EJS dentro de template literal',
    severidad: 'alto',
    archivos: /\.ejs$/,
    patron: /`[^`]*<%#|<%#[^%]*%>[^`]*`/,
    mensaje: '<%# %> dentro de un template literal de JS rompe la vista con un 500.',
    origen: 'EJS interpreta el comentario dentro del JS y la vista falla al compilar.',
  },
  {
    id: 'inner-html-variable',
    titulo: 'innerHTML con valor dinámico',
    severidad: 'medio',
    archivos: /\.(js|ejs|html)$/,
    patron: /\.(innerHTML|outerHTML)\s*[+]?=\s*(?!['"]\s*['"]\s*;?$)[^;]*(\$\{|\+\s*[a-zA-Z_])/,
    excluir: /DOMPurify|escapeHtml|esc\(/,
    mensaje: 'Escapar o sanitizar (DOMPurify) antes de insertar HTML con datos.',
    origen: 'XSS: un valor dinámico en innerHTML se interpreta como HTML.',
  },
  {
    id: 'as-any',
    titulo: 'Tipado con `as any`',
    severidad: 'medio',
    archivos: /\.ts$/,
    patron: /\bas any\b/,
    excluir: PRUEBAS,
    mensaje: 'Estrechar el tipo en lugar de silenciarlo.',
    origen: '`as any` apaga la comprobación de tipos en ese punto.',
  },
  {
    id: 'log-dato-sensible',
    titulo: 'Log con dato sensible',
    severidad: 'alto',
    archivos: CODIGO,
    patron: /\b(console\.(log|info|warn|error|debug)|logger\.\w+)\s*\(.*\b(password|contrase|apikey|api_key|token|secret|cedula|documento|tarjeta|cvv)\b/i,
    excluir: PRUEBAS,
    mensaje: 'No registrar credenciales ni datos personales.',
    origen: 'Los logs se copian a otros sistemas y personas con menos controles.',
  },
  {
    id: 'variable-entorno-nueva',
    titulo: 'Variable de entorno nueva o leída',
    severidad: 'aviso',
    archivos: CODIGO,
    patron: /process\.env\.([A-Z][A-Z0-9_]+)/,
    excluir: PRUEBAS,
    mensaje: 'Confirmar que existe en pruebas y producción antes del despliegue.',
    origen: 'Una variable que falta en un ambiente rompe el despliegue o cambia el comportamiento en silencio.',
  },
  {
    id: 'ddl',
    titulo: 'Cambio de esquema (DDL)',
    severidad: 'aviso',
    archivos: /\.(sql|ts)$/,
    patron: /\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|COLUMN|TYPE|SEQUENCE)\b|\bADD\s+COLUMN\b/i,
    excluir: PRUEBAS,
    mensaje: 'El SQL debe correr antes del despliegue y el código debe tolerar que aún no exista.',
    origen: 'Si el código sale antes que el SQL, falla contra un esquema que aún no cambió.',
  },
  {
    id: 'dependencias',
    titulo: 'Cambio de dependencias',
    severidad: 'aviso',
    archivos: /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/,
    porArchivo: true,
    mensaje: 'Validar el build y las pruebas en CI con las dependencias nuevas.',
    origen: 'Un cambio de dependencias afecta a todo el proyecto, no solo a las líneas de la PR.',
  },
];

// Reglas propias de un proyecto, en `reglas` de proyectos.json, con las expresiones como texto.
// soloEnTexto: la línea cuenta solo en vistas o si el patrón aparece dentro de una cadena (texto visible).
export function reglasDeConfig(lista = []) {
  return lista.map((r) => {
    const re = (x) => (x ? new RegExp(x, r.flags ?? '') : undefined);
    const patron = re(r.patron);
    const enCadena = r.patron && new RegExp(`['"\`][^'"\`]*(?:${r.patron})`, r.flags ?? '');
    return {
      ...r,
      severidad: SEVERIDADES.includes(r.severidad) ? r.severidad : 'aviso',
      archivos: re(r.archivos) ?? /./,
      patron,
      excluir: re(r.excluir),
      ...(r.soloEnTexto ? { cuando: (linea, archivo) => VISTAS.test(archivo) || enCadena.test(linea) } : {}),
      origen: r.origen ?? 'Regla del proyecto.',
    };
  });
}

export const reglasDelRepo = (repo, omitidas = [], extra = []) =>
  [...REGLAS, ...extra].filter((r) => (!r.repos || r.repos.includes(repo)) && !omitidas.includes(r.id));
