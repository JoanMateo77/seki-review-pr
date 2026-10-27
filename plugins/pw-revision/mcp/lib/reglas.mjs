// Reglas fijas que se corren sobre las líneas que agrega una PR. Cada una nace de un incidente o
// una regla del proyecto; el campo `origen` lo dice para que quien revisa entienda por qué importa.
// Una línea se excluye de una regla con el comentario `pw-revision: ignorar <id>`.
//
// Campos: id, titulo, severidad (bloqueante | alto | medio | aviso), archivos (regex sobre la ruta),
// repos (opcional), patron (regex sobre la línea agregada), excluir (opcional), cuando(linea, archivo)
// (opcional, filtro extra), mensaje, origen.

const VISTAS = /\.(ejs|html)$/;
const CODIGO = /\.(ts|js|mjs|cjs)$/;
const CODIGO_O_VISTAS = /\.(ts|js|mjs|cjs|ejs|html)$/;
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
    id: 'texto-comercio',
    titulo: '"comercio" en texto visible',
    severidad: 'alto',
    archivos: CODIGO_O_VISTAS,
    patron: /(?<![\w-])comercios?(?![\w-])/i,
    excluir: /c[áa]mara de comercio|comercio electr[óo]nico|comercio extranjero|<%#|^\s*(\/\/|\*|\/\*)|\b(console|logger)\.\w+\(|__tests__|\.spec\.|\.test\./i,
    cuando: (linea, archivo) => VISTAS.test(archivo) || /['"`][^'"`]*(?<![\w-])comercios?(?![\w-])/i.test(linea),
    mensaje: 'En texto que ve una persona se dice "cliente". Los identificadores internos se quedan.',
    origen: 'Regla del 25-09: nunca "comercio" en pantallas, mensajes, correos ni exportaciones.',
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
    origen: 'Incidente registrado en "EJS anidado en template literal".',
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
    mensaje: 'No registrar credenciales ni datos personales; ver lineamientos-de-logs.',
    origen: 'Los logs se copian a otros sistemas con menos controles.',
  },
  {
    id: 'variable-entorno-nueva',
    titulo: 'Variable de entorno nueva o leída',
    severidad: 'aviso',
    archivos: CODIGO,
    patron: /process\.env\.([A-Z][A-Z0-9_]+)/,
    excluir: PRUEBAS,
    mensaje: 'Confirmar que existe en pruebas y producción antes del despliegue (gitops).',
    origen: 'Una variable que falta en un ambiente rompe el despliegue.',
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
    mensaje: 'npm install está roto en la máquina local y los worktrees comparten node_modules; validar el build del CI.',
    origen: 'Un cambio de dependencias afecta a todo el proyecto.',
  },
  {
    id: 'test-ignorado-por-jest',
    titulo: 'Archivo de prueba que jest no recoge',
    severidad: 'medio',
    repos: ['web'],
    archivos: /__tests__\/.*(?<!\.unit|\.int)\.test\.js$/,
    porArchivo: true,
    soloAgregados: true,
    mensaje: 'En web jest solo recoge *.unit.test.js y *.int.test.js; este archivo se ignora en silencio.',
    origen: 'Configuración de jest de web.',
  },
];

export const reglasDelRepo = (repo, omitidas = []) =>
  REGLAS.filter((r) => (!r.repos || r.repos.includes(repo)) && !omitidas.includes(r.id));
