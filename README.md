# Seki Review

AI-assisted PR review: which PRs are pending per environment, whether their code is already in testing or in
production, an explanation of each change written for someone who did not write it, questions about lines or about
the explanation, read-only investigation of the code, and change proposals that are pushed only after an approval.
All in a local dashboard.

It has two parts: an MCP server (tools any MCP client can call) and a skill (the guided workflow that runs on top of
those tools).

**Client support.** The MCP server is client-agnostic and works with any MCP client. The install command below is the
Claude Code plugin install. The guided workflow (the `review-prs` skill) and the dashboard's AI analysis queue
(which runs `claude -p`) currently run on Claude Code.

## Installation

```
claude plugin marketplace add <path-or-github-repo>
claude plugin install seki-review@seki
```

Then copy `plugins/seki-review/config/proyectos.ejemplo.json` to `~/.config/seki-review/proyectos.json` and
fill it in with your repos and branches. In Claude Code, `/seki-review:review-prs` opens the dashboard.

After editing the plugin: `claude plugin marketplace update seki` and restart the session.

Requirements: authenticated `gh` and Node >= 22 (the launcher looks in `~/.proto` first; `SEKI_NODE`
sets it explicitly). No npm dependencies.

## seki-review

| Component | Path |
|---|---|
| MCP server (stdio, JSON-RPC without an SDK) | `plugins/seki-review/mcp/server.mjs` |
| Tools, one per file | `plugins/seki-review/mcp/tools/*.mjs` |
| Shared logic (GitHub, git, twin PRs, status against testing and production) | `plugins/seki-review/mcp/lib/` |
| Generic verification rules | `plugins/seki-review/mcp/lib/reglas.mjs` |
| Dashboard template (parts concatenated in `orden.json` order) | `plugins/seki-review/mcp/tablero/partes/` |
| Projects, repos, branches, context and custom rules | `~/.config/seki-review/proyectos.json` (example in `config/proyectos.ejemplo.json`) |
| Workflow for the agent | `plugins/seki-review/skills/review-prs/SKILL.md` |
| Dashboard server with actions (127.0.0.1, token in the URL) | `plugins/seki-review/mcp/lib/servidor-web.mjs`, `bin/tablero.sh` |
| AI analysis queue (`claude -p`, sonnet, read-only) | `plugins/seki-review/mcp/lib/trabajos.mjs` |
| QA guide and import (xlsx writer/reader, zip, pdf, tracker editor) | `plugins/seki-review/mcp/lib/{zip,xlsx,xlsx-editar,qa-guia,qa-salida,pdf,qa-importar,rastreador-xlsx}.mjs`, tools `qa_guia` and `qa_importar` |
| Smoke test | `node plugins/seki-review/test/humo.mjs [tool] ['{"arg":1}']` |

Output (per project, `salida` field): `datos/prs.json` (latest snapshot), `datos/*-cache.json`, `verificaciones/`,
`explicaciones/<repo>-<n>.json` and `tablero.html`.

### Adding a tool

Create `mcp/tools/<name>.mjs`; the server registers it on startup:

```js
export default {
  name: 'mi_herramienta',
  description: 'What it does and when to use it (the model decides based on this text).',
  inputSchema: { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'] },
  async handler({ repo }) {
    return { ok: true }; // text or object; a throw is returned as a tool error
  },
};
```

Ideas that fit without a redesign: deployment status per environment (GitOps / Argo CD), running a PR's
test suite against the baseline, review templates per project type.

### Adding a project

New key in `proyectos.json` with `owner`, `autor` (`@me`, or empty for all), `salida` and, per repo,
its `lineas` (`portal`, `prod`, `pruebas`), `inactivas` and the optional local `checkout` (with a
checkout, the status against testing is checked by applying the patch; without one, by comparing files).
Optional: `contexto` (stack and text or code rules the AI follows in everything it writes), `reglas`
(custom verifications with expressions as strings: `id`, `titulo`, `severidad`, `archivos`, `patron`, `flags`,
`excluir`, `soloEnTexto`, `porArchivo`, `repos`, `mensaje`, `origen`), `secretos` (extra files the AI cannot read, in addition to `.env`, keys and credentials), `lineamientos` (folder of a skill with
`SKILL.md` and `destilado/*.md`, used for change requests) and `copias`. When no project is given, `SEKI_PROYECTO` or
the first one in the file is used.

`ia` (optional): `modo` (`ahorro`, `normal` or `ultra`, default `normal`), `presupuestoDiarioUsd` (positive number, or
`null` for no limit; the spend counts every project on the machine) and `rutasSensibles` (regular expressions, as
strings, matched against changed file paths to suggest an Ultra review). The patterns are trusted owner
configuration, like `reglas`: each is limited to 200 characters and an invalid one is ignored with a warning.

### Other MCP clients

The server does not depend on Claude Code. For Claude Desktop, Cursor or another client:
`{"command": "sh", "args": ["<path>/plugins/seki-review/bin/servidor.sh"]}`.

### Adding a verification rule

One more object in `REGLAS` in `mcp/lib/reglas.mjs` with `id`, `titulo`, `severidad`, `archivos` (path regex),
`patron` (regex over the added line), `mensaje` and `origen` (the incident or rule that justifies it).
Optional: `excluir`, `cuando(linea, archivo)`, `severidadPara(linea)`, `repos`, `porArchivo`. To turn off a
rule for a repo: `reglas_omitidas: ["id"]` in its entry in `proyectos.json`.

### Dashboard with actions

`tablero_servir` (or `sh plugins/seki-review/bin/tablero.sh`) serves the dashboard on `127.0.0.1:4317` with a token in the URL.
"Refresh status" queries GitHub and git again and shows what was merged, closed, is new or changed group.
"Analyze with AI" and questions about lines launch `claude -p` in minimal mode: no CLAUDE.md, memory, skills or
MCP servers from other plugins, with its own system prompt (`mcp/prompts/`). This applies only to what the dashboard
launches; regular Claude Code sessions are unchanged. Measured on 2026-10-27: the explanation of a medium-sized PR went
down from USD 0.20 to 0.058, and two questions with Haiku cost USD 0.0023.

| Job | Default model | Default cap |
|---|---|---|
| Question about up to 40 lines in a PR with effort 1-2 | Haiku | USD 0.50 per question |
| Other questions, explanations | Sonnet | USD 0.50 / 2 |
| Change request | Sonnet (never Haiku) | USD 1.50 |
| Explanation or request on a security PR or one over 1,500 lines | Opus | same as its type |

Variables: `SEKI_IA_MODELO` (everything) or `SEKI_IA_MODELO_RESPONDER`, `SEKI_IA_MODELO_EXPLICAR`, `SEKI_IA_MODELO_CAMBIAR`;
`SEKI_IA_TOPE_<TIPO>` in dollars; `SEKI_IA_PARALELO` (1 or 2); `SEKI_CLAUDE` for a different executable. Each job is logged in
`revision-prs/datos/costos.jsonl` and the dashboard shows the day's spend. Answers are cached by commit, file,
lines and text, and are not requested again.

**Change requests.** The AI works in a separate copy: a detached worktree at the PR's commit, located in
`copias` from `proyectos.json` (by default `~/.cache/seki-review/copias/<proyecto>`, outside the workspace so it does not
inherit its CLAUDE.md). It only has Read, Grep, Glob, Edit and Write, no Bash, and can only write inside the copy
(`--permission-mode acceptEdits`; it does not load the repo's settings or hooks). It loads the guidelines from the
project's `lineamientos`. The server checks each proposal without AI, using the rules, `tsc` and the related
tests according to each repo's `comprobar`; if something fails, the AI gets one correction attempt. Failures that
already existed at the PR's commit do not count. **Approve** confirms with `gh` that the PR is still open, that it does
not come from a fork and that the branch only advanced with commits pushed by the dashboard,
applies the patch, makes a commit with the machine's git identity (no trailers) and runs `git push` to the PR's
branch. If GitHub rejects the push, the proposal is kept as a patch to copy. Measured on 2026-10-27: a small change in
a TypeScript backend cost USD 0.11 with Sonnet and took 72 s, checks included.

### QA guide and import

From the Deliveries tab (or the `qa_guia` and `qa_importar` tools) the plugin generates a QA guide for the deliveries waiting for QA and imports it back once filled in.

- **Guide.** One xlsx, html and pdf per run under `salida/qa/`, with one row per finding ID and portal (a track without IDs gets one row labelled `E<n>`). Rows are signed (HMAC) over their key fields; the Result, notes, evidence, date and tester columns can be edited freely. Steps come from the PR explanations or descriptions; PRs without steps show `Steps pending`. The MCP tool never runs the AI; the dashboard can queue the explanations that are missing. Generation is serialized: only one guide is produced at a time. QA-facing cells never show PR numbers, branch names or file paths.
- **Import.** Rows are matched by (ID, Portal) against the signed sheet inside the file, so sorting, filtering or deleting rows is fine; edited keys and results from an outdated guide are rejected, as are rows of a track merged into testing again after the guide. Results are stored per track PR ids, so regrouping or renaming a delivery does not lose them. A track is `ok` when every row is OK or N/A, `fail` when any row failed, and still waiting otherwise; a blocked row raises a `qa_bloqueada` alert. Corrections are accepted until the track is merged into production. Import limits: 5 MB file, 200 zip entries, 20 MB uncompressed, 5,000 rows, 100 columns.
- **Tracker spreadsheet (optional).** With `qa.rastreador` configured, the plugin reads finding data from an existing xlsx and writes status, PR links and dates back, locating columns by header text. Updates are derived from the deliveries and written only on import or with the "Update spreadsheet" button, never by the watcher. A backup is saved under `salida/respaldos/` before each write.
- **Tool and file safety.** `qa_importar` accepts files inside the output QA folder or Downloads; any other path requires `confirmar: true`. Generated files are written only under `salida/qa/`.

The `qa` block of a project (columns, result texts, mapping to internal results, Chrome path for the PDF, tracker) is shown in `config/proyectos.ejemplo.json`: the `demo` project uses the defaults, and `demo-tracker` adds a tracker with generic header names. `columnas` must keep `ID`, `Portal` and `Result`, otherwise the defaults are used with a warning. A `null` entry under `lectura` or `columnas` skips that field. The guide shows the finding text from the tracker (`lectura.hallazgo`) only when `Finding` is listed in `qa.columnas`, as `demo-tracker` does; `qa.resultados` must have an entry in `qa.mapeo` for each text and contain no commas or quotes, otherwise both defaults are used with a warning; `qa.rastreador.ruta` must be an absolute path (or start with `~/`).

## License

MIT. See [LICENSE](LICENSE). Version history in [CHANGELOG.md](CHANGELOG.md) and workflow in [CONTRIBUTING.md](CONTRIBUTING.md).
