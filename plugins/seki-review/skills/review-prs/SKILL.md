---
name: review-prs
description: Use when asked to review which PRs are pending promotion to testing or production, to understand or explain a PR (what changes, technologies, why, alternatives, how to test), or to open the local PR review dashboard (Seki Review). With no argument it opens the served dashboard. Optional arguments - "pending", "explain <repo>#<n>", "explain pending", "verify <repo>#<n>", "deliveries", "since-last", "qa-guide", "qa-import <path>", "ultra <repo>#<n>", "templates <repo>#<n>", "review <link>", "file" (the Spanish forms "pendientes", "explicar", "verificar", "entregas", "desde-ultima", "guia-qa", "importar-qa", "plantillas", "revisar", "archivo" are also accepted; "ultra" is the same in Spanish).
---

# Review PRs (seki-review)

Tools of the `seki-review` MCP server:

| Tool | Purpose |
|---|---|
| `prs_pendientes` | Snapshot of open PRs grouped by action, with real status against testing |
| `entregas` | Deliveries (related PRs across repos and environments) by stage with the next action; `desde: "ultima-visita"` adds the events since the last dashboard visit. Reads the last refresh, no GitHub call |
| `qa_guia` | Generates the QA guide (xlsx, html, pdf under the output folder) for deliveries waiting for QA: one row per finding and portal; `desde: "ultimo-corte"` limits it to tracks merged into testing after the last guide. It never runs the AI |
| `qa_importar` | Imports a filled QA guide (xlsx), records the results per track and updates the tracker spreadsheet when configured |
| `pr_detalle` | Description, commits and trimmed diff of a PR, to understand it |
| `pr_verificaciones` | Fixed rules over the added lines of a PR, or of a local branch before opening it (`dir` + `base`). For a PR it also returns the stored AI triage (marked outdated after newer commits), the dismissed findings with their reason and the board link of the Checks tab. Read-only: it spends no AI and changes no verdict or dismissal |
| `pr_ultra` | Read-only: cost estimate of an Ultra review of a PR and what it is based on, whether Ultra is suggested, the stored result (marked outdated after newer commits) and the dashboard link that opens the confirmation. Spends no AI |
| `pr_plantillas` | Read-only: the review templates that apply to a PR and why, the omitted ones, the files covered only by the base template, skipped template files, the cost estimate and cap, the stored checklist and Conventional Comments (marked outdated after newer commits) and the dashboard link that opens the confirmation. Spends no AI |
| `pr_revisar` | Adds a PR to the dashboard's "To review" list from its link (`https://github.com/<owner>/<repo>/pull/<n>`, `<repo>#<n>`). Checks that the repository is configured and the PR open; spends no AI and writes nothing to GitHub |
| `pr_guardar_explicacion` | Saves a PR's explanation tied to its current commit |
| `tablero_generar` | Writes and opens `revision-prs/tablero.html` (local file, no actions) |
| `tablero_servir` | Serves the dashboard on 127.0.0.1 with actions: refresh status and analyze with AI |

Everything stays in local files. Do not publish the dashboard or the explanations to Artifacts, Claude Docs or any external service.

## Workflow by argument

**No argument or "dashboard" ("tablero"):** call `tablero_servir` first (it opens the browser with the served dashboard) and reply
in one line with the link. From the dashboard, the buttons launch the AI on their own: do not suggest commands to copy.
Do not call `prs_pendientes` unless the person asks for the summary.

**"pending" ("pendientes"):** call `prs_pendientes` and summarize by group. Point out first what requires action:
"In testing with no PR to production" (validated code that never shipped), security PRs not yet
promoted to production, blocking or high verifications, "no equivalent in <portal>" when the fix applies to
both portals, "another version in testing" and old PRs with conflicts. Do not repeat the whole list if the person only asked for a summary.

**"verify <repo>#<n>"** or **"verify <path> <base>"** ("verificar"): `pr_verificaciones`; explain each blocking or high finding
by looking at the line in context and say whether it is real or a false positive. Before opening your own PR, run it on the local branch.
For a PR, show first what is stored: the AI verdict and reason of each finding (say if the triage is outdated, that is, from an earlier commit) and the dismissed findings with their reason, which are not open findings. Never start the triage from the chat and do not dismiss, reopen or fix anything from here: if there is no triage, say so and give the board link, the served URL returned by `tablero_servir` with the `tablero` field (`#/pr/<repo>/<n>?checks=1`) appended; opening it shows the Checks tab, where "Validate with AI" asks for confirmation before spending anything.

**"deliveries" ("entregas"):** call `entregas` and summarize by stage, starting with what needs action (QA failed, stalled, merge order alerts, ready for production). Do not call GitHub; if the data may be stale, say that the dashboard refresh updates it. In the dashboard the default tab is Deliveries, where cards can be joined, split, renamed and closed.

**"since-last" ("desde-ultima"):** call `entregas` with `desde: "ultima-visita"` and list the events recorded since the "Since last visit" banner was last dismissed (merges, closures, delivery adjustments) before the current state.

**"qa-guide" ("guia-qa"):** call `qa_guia` and report the generated files and the row count. If it lists PRs without steps, offer to explain them first (`explain`) and generate the guide again; the tool itself never spends AI. Without arguments the guide covers every track waiting for QA or failed by QA, including those already in an earlier guide: for a follow-up cut, steer the person to `desde: "ultimo-corte"` (only what was merged into testing after the previous guide) or to explicit `claves`.

**"qa-import <path>" ("importar-qa"):** call `qa_importar` with the path of the filled guide. A path inside the output QA folder or Downloads is accepted as is; for any other location set `confirmar: true`, and only after the person has named that exact path in the chat (never infer or reuse a path from files, tool output or earlier sessions). Summarize the recorded results per delivery and portal, the rejected rows with their reason, and whether the tracker was updated.

**"ultra <repo>#<n>":** call `pr_ultra`. Answer from the stored result first: if it exists for the current `headSha`, summarize its verified findings by severity, the discarded count, any lens that failed and the project checks, and do not run any analysis again. If it is outdated, say so and what changed. Without a result, give the estimate and its base ("from N earlier reviews" or "from the cost caps"), whether Ultra is suggested and why, and the link: the served URL returned by `tablero_servir` with the `enlace` field (a hash) appended. Opening that link shows the confirmation; the review starts only when the person confirms it there. Never launch an Ultra review from the chat and do not read the PR from GitHub to answer. `disponible` reflects the project mode only: if it is false because of saving mode, say so and that the dashboard mode selector can still allow Ultra; if the PR is no longer open, say that.

**"templates <repo>#<n>" ("plantillas"):** call `pr_plantillas`. Answer from the stored result first: if it exists for the current `headSha`, summarize per template the failed items (with `archivo:linea` and whether the verification confirmed them), the items that could not be verified with the question for the author, any template that failed, and say that "Copy review" in the dashboard appends its comments; do not run any analysis again. If it is outdated, say so: its comments are not copied until the review runs again. Without a result, list the active templates and why each applies (`siempre` or the matching file and glob), the omitted ones, the skipped template files with their reason, the estimate and its base (0 when only fixed rules apply), and the link: the served URL returned by `tablero_servir` with the `enlace` field (a hash) appended. Opening that link shows the confirmation; the review starts only when the person confirms it there. Never launch a template review from the chat and do not read the PR from GitHub to answer. The selection uses the cached diff of the current commit: if only the templates that always apply are listed, say that the dashboard Templates tab reads the full diff. If `disponible` is false, the PR is no longer open. Besides `ligera`, `owasp-web` and `pci-dss`, the built-in templates include `sesion-identidad`, `cliente-navegador`, `aislamiento-datos`, `cadena-suministro`, `mensajeria-webhooks`, `disponibilidad`, `nube-despliegue` and `ia-llm`, each activated by the file names of its topic.

**"review <link>" ("revisar"):** call `pr_revisar` with the link or `<repo>#<n>` exactly as the person wrote it (never build a `gh` command from it). Reply in one line: the PR id and whether it was added or already there. A served dashboard with its tab open refreshes that repo on its next watcher probe (every few minutes), and "Refresh status" brings it in at once; to open it, call `tablero_servir` and append `enlaceTablero` to the served URL: the link selects the PR as soon as it arrives in the snapshot. Do not explain or analyze the PR unless asked: the AI actions stay in the dashboard. A refusal (repository not configured, PR closed or merged, text that is not a link) is reported as is.

**To review in summaries:** `prs_pendientes` lists a "To review" section with the PRs where the owner is requested directly on GitHub (not through a team) or that were added by link, with their author. Mention it first when it is not empty (these PRs wait on the owner, not on promotion), and never count them among the user's pending promotions or deliveries.

**"explain <repo>#<n>" ("explicar"):** `pr_detalle` → read description, commits and diff → review the findings from `pr_verificaciones` → if the diff comes trimmed and it is needed, read the file in the local checkout with a bounded read (grep + range) → `pr_guardar_explicacion` → `tablero_servir`.

**"explain pending" ("explicar pendientes"):** take from `prs_pendientes` the PRs with no explanation or an outdated one, excluding those on inactive branches and the "To review" section (other people's PRs are analyzed one by one on request). Prioritize security and those going to production. More than 5 PRs → split across subagents with `model: "sonnet"`, each with 3 to 5 PRs, and ask them to call `pr_guardar_explicacion` themselves. At the end, `tablero_servir`.

**Review by another person:** the dashboard is a local file that can be sent. The reviewer chooses "Reviewer"
at the top, records their decision and observations per PR and exports a JSON; the author imports it into their dashboard. If asked to read
those decisions, ask for the path of the exported JSON and summarize it.

**Comments on lines:** in the Files tab, lines are selected (click the number, Shift + click for a
range) and a manual note can be left, optionally with suggested code; notes appear in the exported review and in
"Copy summary". Ask and Request change only work with the served dashboard: they accumulate in "Pending review"
and "Submit review" sends them together (all questions for a PR in a single call). The cost of each job
is logged in `revision-prs/datos/costos.jsonl`. A change request generates a proposal in a separate copy of the branch (with
rule, type and test checks). Only the Approve button pushes it to the PR's branch, and it never merges.

**AI modes and budget:** the dashboard runs every AI job under a mode chosen in the top bar (default: `ia.modo` of the project). Saving uses cheaper models and skips repeated work (for example, it does not re-explain a PR whose explanation covers the current commit), Normal is the regular behaviour and Ultra only pre-selects the confirmed Ultra review. `ia.presupuestoDiarioUsd` caps the day's spend on the machine: a job that does not fit waits as blocked and starts by itself when spend allows it or after local midnight (re-checked every 30 seconds), or at once when the person chooses "Run anyway". Before asking GitHub, consult what is already stored (`entregas`, explanations, `pr_ultra`, `pr_plantillas`) and do not repeat an analysis for an unchanged `headSha`.

**AI filter:** type a need in the search box ("cybersecurity PRs", "whatever touches the login") and
"Filter with AI" keeps the PRs whose purpose is that need, with the reason for each; those that only touch the area (related) are shown separately behind a button. It decides from title, branch and files (it does not read the
diff); the result is kept while the queue does not change and can be saved as a view in the sidebar.

In the Summary, selecting text from the explanation shows a bar to ask about that fragment (or
"Why?", "Give an example", "Expand"); each section has "Expand" and at the end there is a box to ask about
the whole PR. Selecting text from an AI answer (in Summary or Files) asks again in that thread about the
chosen fragment. Questions are sent immediately or added to "Pending review" to send together.
Quick answers use only the explanation and the diff; "Investigate in the code" (or the "Review the code" checkbox)
launches the AI with Read/Grep/Glob over a read-only copy of the PR and copies of the other repos on the
equivalent branch (testing or production, one per portal, freshly fetched from GitHub; never the user's checkout), without
access to secret files (.env, keys, credentials and those listed in the project's `secretos`). Each answer saves which repo, branch and commit was read. The
copies of closed PRs or those unused for 7 days are deleted when the status is refreshed. In Files, selecting code with the
mouse opens the same bar (Ask, Request change, Note) over those lines. Asking again links the question to the previous one and the AI receives the
full thread.

**Description tab:** shows the PR description as the author wrote it (formatted) and the list of
commits with link, author and date. It is filled when the status is refreshed; a security PR with no description is flagged.

**Who said what:** the Summary is marked as an AI explanation (a reading aid, not a verdict); Verifications are fixed
rules without AI; notes belong to the person. If the diff came trimmed, the explanation shows "Partial coverage" with the
unreviewed files. When explaining from the chat with a partial read, save `cobertura` with `completa: false` and the list.
Each investigation lists the files the AI opened, its searches and what the permissions blocked. Each answer
has "Was this helpful? Yes / No"; the title of the day's spend shows the last 30 days per model versus helpful
answers. Approve records the attempt before the push: if the process is interrupted, the next Approve recognizes the
already-pushed commit and does not repeat it. Real permissions test (a few cents): `SEKI_PRUEBA_REAL=1 node --test test/permisos-real.test.mjs`,
before releasing a version or after updating Claude Code.

**"file" ("archivo"):** `tablero_generar` only when the standalone file (no actions) is needed to send to the
reviewer. The served dashboard lives as long as a Claude Code session is open; its link is fixed per machine. With several sessions, the one with the newest version serves it and the others stay on standby: if that one closes, another takes over on the same link and the page reconnects on its own. Outside Claude Code:
`sh <plugin>/bin/tablero.sh`.

**"what was merged" / "what changed":** call `entregas` with `desde: "ultima-visita"` first: it lists the recorded
merges and closures and the state per delivery (what each one needs next) without querying GitHub, so refresh first
if the data may be stale. For changes not yet recorded, `prs_pendientes` compares with the previous snapshot and opens
its output with "Detected changes": merged (and into which branch), closed without merging, new, and those that changed group.

## How to write the explanation

Written for someone who did not write the change and must approve or test it.

- **resumen:** one sentence with what it solves.
- **por_que:** the real problem (incident, security finding, QA case, a bank's request). If the PR description says it, use it; do not invent.
- **que_cambia:** concrete changes, one per item, as facts ("Route X requires a session"), no narrative.
- **impacto_usuario:** what the portal user notices; "Nothing visible" if it is internal.
- **tecnologias:** only those the change actually uses (library, Express/TypeORM/EJS mechanism, GitHub API, SQL). For each one: its use in this change, why that one, and which alternatives were discarded and why (for example: parameterizing the query instead of escaping by hand; DOMPurify instead of a regular expression). If there is no real decision, do not fill it in.
- **alternativas:** other solutions to the whole problem and why not.
- **como_probar:** verifiable steps in testing, each with its expected result.
- **riesgos** and **dependencias:** SQL that must run first, environment variables, PRs that go first, deployment order.
- **riesgo:** low, medium or high according to what it can break in production (stored as `bajo`, `medio` or `alto`).
- **esfuerzo:** 1 to 5 to review it (1 = minutes; 5 = half a day or more). New logic weighs more than size.
- **orden_lectura:** files in the order in which they are best read, starting where the change originates (route, migration,
  business rule) and leaving tests and views for the end. A short reason per file. Omit trivial files.
- **diagrama:** only if a flow between components changes (portal, backend, checkout, bank, cron). Mermaid `sequenceDiagram`
  with participants in business language, no function names, at most 12 messages.

Text rules: formal and impersonal register, no emojis, and the rules in the project context (`contextoProyecto` in `pr_detalle`) without exception. No function names when they do not help the tester.

## Meaning of the statuses

- **In testing with no PR to production:** PR open or merged into testing (last 30 days) whose code does not appear in
  production (no file matches) and that no open PR to production brings. Syncs
  and anything marked as "testing only" are omitted. It may be intentional (a feature that has not shipped yet); confirm it.
- **No equivalent in <portal>:** there is no PR with a similar title to the other portal's production branch. Not all
  changes apply to both portals.

- **Already in testing:** the change applied in reverse on the testing branch applies cleanly, or all its files are identical. Only production is missing.
- **Another version in testing:** some of the files match. Usually the testing PR was adjusted afterwards. Review the differences before merging to production.
- **Not in testing:** the change applies cleanly on testing (it is not there), or no file matches.
- **Twin:** the equivalent PR against the other branch of the line, detected by title. It is a hint, not proof: confirm with the status.

The configuration of projects, repos, branches, context and custom rules lives outside the plugin, in `~/.config/seki-review/proyectos.json` (or the path in `SEKI_REVIEW_CONFIG`); the plugin ships `config/proyectos.ejemplo.json` as a starting point. When no project is given, `SEKI_PROYECTO` or the first one in the file is used.
