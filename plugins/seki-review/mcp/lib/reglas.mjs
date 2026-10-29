// Fixed rules run on the lines a PR adds. Each one comes from an incident or a project rule;
// the `origen` field says which, so the reviewer understands why it matters.
// A line is excluded from a rule with the comment `seki-review: ignore <id>` (`ignorar` also works).
//
// Fields: id, titulo, severidad (bloqueante | alto | medio | aviso), archivos (regex on the path),
// repos (optional), patron (regex on the added line), excluir (optional), cuando(linea, archivo)
// (optional, extra filter), mensaje, origen.

const VISTAS = /\.(ejs|html)$/;
const CODIGO = /\.(ts|js|mjs|cjs)$/;
const PRUEBAS = /(__tests__|\.spec\.|\.test\.)/;
const FRAGMENTO_SQL = /^(filtro|filtros|where|condicion\w*|clausula\w*|orden|order\w*|limit\w*|offset|paginacion|sql\w*|campos?|columnas?|placeholders?|tabla|schema|esquema)$/i;

export const SEVERIDADES = ['bloqueante', 'alto', 'medio', 'aviso'];

export const REGLAS = [
  {
    id: 'sql-interpolado',
    titulo: 'SQL built with inlined values',
    severidad: 'bloqueante',
    archivos: CODIGO,
    patron: /(\b(where|andWhere|orWhere|having|query|innerJoin|leftJoin)\s*\(\s*`[^`]*\$\{)|(`[^`]*\b(SELECT|UPDATE|DELETE|INSERT|WHERE|AND|OR)\b[^`]*\$\{)/,
    excluir: PRUEBAS,
    // `${n}` is a PostgreSQL positional placeholder built from a number: it injects nothing.
    // A fragment named like a clause (filtro, where, orden) drops to aviso: check how it is built.
    severidadPara: (linea) => {
      const valores = [...linea.matchAll(/(\$?)\$\{\s*([^}]*)\}/g)].filter((m) => !m[1]).map((m) => m[2].trim());
      if (!valores.length) return null;
      return valores.every((v) => FRAGMENTO_SQL.test(v)) ? 'aviso' : 'bloqueante';
    },
    mensaje: 'Pass the value as a parameter (`:nombre`, { nombre }) instead of interpolating it into the SQL.',
    origen: 'SQL injection: the interpolated value travels inside the query.',
  },
  {
    id: 'secreto-en-codigo',
    titulo: 'Possible secret hardcoded in the code',
    severidad: 'bloqueante',
    archivos: /./,
    patron: /\b(api[_-]?key|secret|secreto|password|passwd|token|aws_secret_access_key|redis_password)\b\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
    excluir: PRUEBAS,
    mensaje: 'Move the value to environment variables; never commit it.',
    origen: 'A committed credential stays in the history even if it is deleted later.',
  },
  {
    id: 'archivo-env',
    titulo: 'Environment file in the PR',
    severidad: 'bloqueante',
    archivos: /(^|\/)(\.env(\..*)?|[a-z]+\.env)$/,
    porArchivo: true,
    mensaje: '.env files contain real secrets and must not travel in a PR.',
    origen: 'Environment files usually hold real credentials.',
  },
  {
    id: 'ejs-sin-escapar',
    titulo: 'Unescaped EJS output (<%-)',
    severidad: 'alto',
    archivos: /\.ejs$/,
    patron: /<%-(?!\s*include\b)/,
    // Embedded JSON with < escaped is the safe way to pass data to a <script type="application/json">.
    excluir: /<%-\s*JSON\.stringify\(.*\.replace\(\/<\/g/,
    mensaje: 'Use <%= %> unless the value is trusted HTML; confirm it does not come from the request.',
    origen: 'XSS: <%- inserts the value as HTML.',
  },
  {
    id: 'ejs-comentario-en-template',
    titulo: 'EJS comment inside a template literal',
    severidad: 'alto',
    archivos: /\.ejs$/,
    patron: /`[^`]*<%#|<%#[^%]*%>[^`]*`/,
    mensaje: '<%# %> inside a JS template literal breaks the view with a 500.',
    origen: 'EJS parses the comment inside the JS and the view fails to compile.',
  },
  {
    id: 'inner-html-variable',
    titulo: 'innerHTML with a dynamic value',
    severidad: 'medio',
    archivos: /\.(js|ejs|html)$/,
    patron: /\.(innerHTML|outerHTML)\s*[+]?=\s*(?!['"]\s*['"]\s*;?$)[^;]*(\$\{|\+\s*[a-zA-Z_])/,
    excluir: /DOMPurify|escapeHtml|esc\(/,
    mensaje: 'Escape or sanitize (DOMPurify) before inserting HTML with data.',
    origen: 'XSS: a dynamic value in innerHTML is interpreted as HTML.',
  },
  {
    id: 'as-any',
    titulo: 'Typing with `as any`',
    severidad: 'medio',
    archivos: /\.ts$/,
    patron: /\bas any\b/,
    excluir: PRUEBAS,
    mensaje: 'Narrow the type instead of silencing it.',
    origen: '`as any` turns off type checking at that point.',
  },
  {
    id: 'log-dato-sensible',
    titulo: 'Log with sensitive data',
    severidad: 'alto',
    archivos: CODIGO,
    patron: /\b(console\.(log|info|warn|error|debug)|logger\.\w+)\s*\(.*\b(password|contrase|apikey|api_key|token|secret|cedula|documento|tarjeta|cvv)\b/i,
    excluir: PRUEBAS,
    mensaje: 'Do not log credentials or personal data.',
    origen: 'Logs are copied to other systems and people with fewer controls.',
  },
  {
    id: 'variable-entorno-nueva',
    titulo: 'New or newly read environment variable',
    severidad: 'aviso',
    archivos: CODIGO,
    patron: /process\.env\.([A-Z][A-Z0-9_]+)/,
    excluir: PRUEBAS,
    mensaje: 'Confirm it exists in testing and production before deploying.',
    origen: 'A variable missing from an environment breaks the deployment or silently changes behavior.',
  },
  {
    id: 'ddl',
    titulo: 'Schema change (DDL)',
    severidad: 'aviso',
    archivos: /\.(sql|ts)$/,
    patron: /\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|COLUMN|TYPE|SEQUENCE)\b|\bADD\s+COLUMN\b/i,
    excluir: PRUEBAS,
    mensaje: 'The SQL must run before the deployment and the code must tolerate it not existing yet.',
    origen: 'If the code ships before the SQL, it fails against a schema that has not changed yet.',
  },
  {
    id: 'dependencias',
    titulo: 'Dependency change',
    severidad: 'aviso',
    archivos: /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/,
    porArchivo: true,
    mensaje: 'Validate the build and tests in CI with the new dependencies.',
    origen: 'A dependency change affects the whole project, not just the PR\'s lines.',
  },
];

// Project-specific rules, under `reglas` in proyectos.json, with the expressions as strings.
// soloEnTexto: the line counts only in views or if the pattern appears inside a string literal (visible text).
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
      origen: r.origen ?? 'Project rule.',
    };
  });
}

export const reglasDelRepo = (repo, omitidas = [], extra = []) =>
  [...REGLAS, ...extra].filter((r) => (!r.repos || r.repos.includes(repo)) && !omitidas.includes(r.id));
