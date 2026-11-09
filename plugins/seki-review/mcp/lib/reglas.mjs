// Fixed rules run on the lines a PR adds. Each one comes from an incident or a project rule;
// the `origen` field says which, so the reviewer understands why it matters.
// A line is excluded from a rule with the comment `seki-review: ignore <id>` (`ignorar` also works).
//
// Fields: id, titulo, severidad (bloqueante | alto | medio | aviso), archivos (regex on the path),
// repos (optional), patron (regex on the added line), excluir (optional), cuando(linea, archivo)
// (optional, extra filter), mensaje, origen.

import { AGOTADO, compilarPatron, probarSeguro } from './patrones.mjs';

const VISTAS = /\.(ejs|html)$/;
const CODIGO = /\.(ts|js|mjs|cjs)$/;
export const PRUEBAS = /(__tests__|\.spec\.|\.test\.)/;
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
    id: 'tipo-any',
    titulo: 'Typing with `any`',
    severidad: 'aviso',
    archivos: /\.tsx?$/,
    // `: any`, `any[]`, generic arguments (`<any>`, `Map<K, any>`), union and intersection members
    // (`string | any`, `A & any`), aliases and constraints (`type X = any`, `T extends any`).
    // The `as any` cast is left to as-any: the lookbehinds keep `as any[]` and `as any |` out, so a mixed
    // line such as `(y as any) as Map<string, any>` still reports its type-position any.
    // `||` and `&&` are not members: the lookarounds skip them.
    // Cost: no alternative starts with a repeat, so a match can only begin at a fixed token (`:`, `any`, `<`, `,`,
    // `|`, `&`, `type`, `extends`), and the `\s*`/`\s+` run right after that token (or before `any`, for the `as`
    // lookbehinds) is read once from it. The alias form has three more repeats: `\w{1,80}(?!\w)` reads the name
    // and the lookahead rejects every shorter split in one step; the lazy `[^;]{0,300}?` reads at most 300
    // characters; the `\s*` after an `=` in that window is read once per `type` whose name ends at most 300
    // characters before that `=`. So each character is read a bounded number of times and long lines stay linear.
    // The alias form is not anchored, so a trailing comment or more code (`type X = any; // why`) is still caught.
    // Its limits: the name has 1-80 word characters, and `= any` must follow within 300 characters with no `;`
    // between. `=> any` is not an alias: that `=` is followed by `>`, not `any`.
    patron: new RegExp([
      String.raw`:\s*any\b`,
      String.raw`(?<!\bas\s+)\bany\[\]`,
      String.raw`[<,]\s*any\s*[,>]`,
      String.raw`(?<!\|)\|\s*any\b`,
      String.raw`(?<!\bas\s+)\bany\s*\|(?!\|)`,
      String.raw`(?<!&)&\s*any\b`,
      String.raw`(?<!\bas\s+)\bany\s*&(?!&)`,
      String.raw`\btype\s+\w{1,80}(?!\w)[^;]{0,300}?=\s*any(?![\w$])`,
      String.raw`\bextends\s+any\b`,
    ].join('|')),
    // A line that starts as a comment (`//`, `/*`, `*`) is prose, not a type. Text inside strings is still read.
    cuando: (linea) => !/^\s*(?:\/\/|\/\*|\*)/.test(linea),
    mensaje: 'Use `unknown` and narrow it, or the real type.',
    origen: 'The standard bans `any` everywhere, tests included: it turns off type checking for every value that passes through it.',
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

// Tests a config pattern with a time limit; on timeout the rule is disabled and warned about once.
export function probarRegla(regla, re, texto) {
  if (regla.agotada) return false;
  const r = probarSeguro(re, texto);
  if (r !== AGOTADO) return r;
  regla.agotada = true;
  console.error(`[seki-review/reglas] rule ${String(regla.id ?? '(no id)').slice(0, 60)} disabled: pattern exceeded its time limit`);
  return false;
}

// Project-specific rules, under `reglas` in proyectos.json, with the expressions as strings.
// soloEnTexto: the line counts only in views or if the pattern appears inside a string literal (visible text).
export function reglasDeConfig(lista = []) {
  const reglas = [];
  for (const r of lista) {
    try {
      // g/y would make .test() stateful across lines.
      const flags = (r.flags ?? '').replace(/[gy]/g, '');
      const re = (x) => (x ? compilarPatron(x, flags) : undefined);
      const patron = re(r.patron);
      const archivos = re(r.archivos) ?? /./;
      const excluir = re(r.excluir);
      // The user source was validated above; the wrapper adds no quantifier.
      const enCadena = r.patron && new RegExp(`['"\`][^'"\`]*(?:${r.patron})`, flags);
      const regla = {
        ...r,
        deConfig: true,
        severidad: SEVERIDADES.includes(r.severidad) ? r.severidad : 'aviso',
        archivos,
        patron,
        excluir,
        ...(r.soloEnTexto ? { cuando: (linea, archivo) => VISTAS.test(archivo) || probarRegla(regla, enCadena, linea) } : {}),
        origen: r.origen ?? 'Project rule.',
      };
      reglas.push(regla);
    } catch (e) {
      const id = String(r?.id ?? '(no id)').slice(0, 60);
      console.error(`[seki-review/reglas] rule ${id} dropped: ${String(e.message).slice(0, 120)}`);
    }
  }
  return reglas;
}

export const reglasDelRepo = (repo, omitidas = [], extra = []) =>
  [...REGLAS, ...extra].filter((r) => (!r.repos || r.repos.includes(repo)) && !omitidas.includes(r.id));
