---
name: review-prs
description: Use when asked to review which PRs are pending promotion to testing or production, to understand or explain a PR (what changes, technologies, why, alternatives, how to test), or to open the local PR review dashboard (Seki Review). With no argument it opens the served dashboard. Optional arguments - "pending", "explain <repo>#<n>", "explain pending", "verify <repo>#<n>", "file" (the Spanish forms "pendientes", "explicar", "verificar", "archivo" are also accepted).
---

# Review PRs (seki-review)

Tools of the `seki-review` MCP server:

| Tool | Purpose |
|---|---|
| `prs_pendientes` | Snapshot of open PRs grouped by action, with real status against testing |
| `pr_detalle` | Description, commits and trimmed diff of a PR, to understand it |
| `pr_verificaciones` | Fixed rules over the added lines of a PR, or of a local branch before opening it (`dir` + `base`) |
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

**"explain <repo>#<n>" ("explicar"):** `pr_detalle` → read description, commits and diff → review the findings from `pr_verificaciones` → if the diff comes trimmed and it is needed, read the file in the local checkout with a bounded read (grep + range) → `pr_guardar_explicacion` → `tablero_servir`.

**"explain pending" ("explicar pendientes"):** take from `prs_pendientes` the PRs with no explanation or an outdated one, excluding those on inactive branches. Prioritize security and those going to production. More than 5 PRs → split across subagents with `model: "sonnet"`, each with 3 to 5 PRs, and ask them to call `pr_guardar_explicacion` themselves. At the end, `tablero_servir`.

**Review by another person:** the dashboard is a local file that can be sent. The reviewer chooses "Reviewer"
at the top, records their decision and observations per PR and exports a JSON; the author imports it into their dashboard. If asked to read
those decisions, ask for the path of the exported JSON and summarize it.

**Comments on lines:** in the Files tab, lines are selected (click the number, Shift + click for a
range) and a manual note can be left, optionally with suggested code; notes appear in the exported review and in
"Copy summary". Ask and Request change only work with the served dashboard: they accumulate in "Pending review"
and "Submit review" sends them together (all questions for a PR in a single call). The cost of each job
is logged in `revision-prs/datos/costos.jsonl`. A change request generates a proposal in a separate copy of the branch (with
rule, type and test checks). Only the Approve button pushes it to the PR's branch, and it never merges.

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

**"what was merged" / "what changed":** `prs_pendientes` compares with the previous snapshot and opens its output with
"Detected changes": merged (and into which branch), closed without merging, new, and those that changed group.

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
