# Changelog

Each version has its `seki-review-vX.Y.Z` tag on the commit that releases it.

## seki-review

### 0.23.0 (2026-11-05)
- AI modes: every AI job runs under `ahorro`, `normal` or `ultra`, drawn from one profiles table (model, cost cap, turns, second pass). Precedence: `SEKI_IA_MODELO_<TIPO>` and `SEKI_IA_TOPE_<TIPO>`, then `SEKI_IA_MODELO`, then the mode of the request, then `ia.modo` of the project, then `normal`. `TOPES` and `TURNOS` stay equal to the normal row.
- Saving mode uses Haiku for answers and the filter and Sonnet for the rest (never Opus), skips the second explanation pass and does not re-analyze a PR whose explanation already covers the current commit unless completing it. The dashboard selector overrides the project mode for the session.
- Daily budget: `ia.presupuestoDiarioUsd` limits the day's spend on the machine (every project, local time zone, failed jobs included). A job that does not fit stays queued as "Blocked by the daily budget" and starts by itself when spend allows it, or once on "Run anyway" (`POST /api/trabajos/forzar`); the AI filter answers 429 with the same message and a retry flag. Reservations keep two simultaneous jobs from overshooting.
- Ultra review: confirmed, cost-estimated job on one PR with three read-only lenses, structural removal of findings that cite code that does not exist, one verification call and the project checks. Results are stored per commit (`salida/ultra/`) and marked outdated after newer commits. New endpoints `GET/POST /api/ultra`; `/api/estado` adds `presupuesto` and `modo`.
- Estimates from the median of the last 30 days of the same job and mode (the cost caps when there are fewer than three records); `ia.rutasSensibles` and security PRs suggest Ultra.
- Dashboard: mode selector, "$X of $Y today" spend line, "Ultra review" button, confirmation dialog, "Ultra review" tab, "Ultra" signal on suggested PRs, blocked jobs with "Run anyway", by-mode summary in the cost tooltip, and the link `#/pr/<repo>/<n>?ultra=1`.
- New read-only MCP tool `pr_ultra` and skill argument `ultra <repo>#<n>`; the failed AI jobs log a safe reason.
- `ia` block in `config/proyectos.ejemplo.json`.

### 0.22.0 (2026-11-04)
- QA guide: new tool `qa_guia` and "QA guide" action on the Deliveries tab generate an xlsx, html and pdf under `salida/qa/` for the deliveries waiting for QA, with signed rows, steps taken from the PR explanations or descriptions, and `desde: "ultimo-corte"` for incremental cuts. The tool never runs the AI; the dashboard can queue missing explanations.
- QA import: new tool `qa_importar` and dashboard import read the filled guide, record results per track and move deliveries to "Ready for production" or "QA failed". Paths outside the output QA folder and Downloads need `confirmar: true`.
- Optional tracker spreadsheet (`qa.rastreador`): reads finding data and writes status, PR links and dates, locating columns by header text and preserving the workbook styles; backups under `salida/respaldos/`.
- New alert `qa_bloqueada` for tracks with a blocked row.
- Dependency-free zip, xlsx (writer, strict reader, style-preserving cell editor) and pdf modules; Chrome is used for the pdf only through argument arrays.
- New endpoints `/api/qa/guia`, `/api/qa/archivo`, `/api/qa/importar` and `/api/qa/rastreador`, behind the token and Host check with capped bodies (16 KB; 7 MB for the import).
- Skill arguments `qa-guide` and `qa-import <path>` (Spanish `guia-qa`, `importar-qa`); `qa` block in `config/proyectos.ejemplo.json`.
- Hardening: zip and xlsx readers bound entries, uncompressed size, rows, columns and cell length; signatures cover the key fields and a secret created exclusively; stricter text cleaning in QA cells; safe styles, formulas and tables in the editor; safer Chrome shutdown; independent guide jobs and safer QA endpoints; release of dashboard and watcher handles.
- Behaviour rulings: row identity is (ID, Portal), and a track without IDs gets one row `E<n>`; results are tied to the track PR ids per portal, so regrouping or renaming a delivery keeps them; corrections are accepted until the production merge, and a testing merge after the guide rejects the rows; tracker updates are derived from the deliveries and written only on import or with the button; per finding ID the tracker shows the least advanced active delivery (discarded deliveries are ignored, and finished ones, in production or closed, are ignored while another delivery of that ID is active); a newer guide without results never replaces the results already imported, and an older guide is refused only once a newer one has results for the track; guide generation is serialized.
- Files saved by LibreOffice (zip data descriptors) can be imported and used as tracker; a tracker open in LibreOffice (`.~lock.<name>#`) is detected; guide ids are never reused; `qa.resultados` is checked against `qa.mapeo` and the 255-character validation limit at load; relative tracker and import paths are refused; backups are written with mode 0600; the browser receives file names, never absolute paths.
- Test-suite debt paid: no test file leaves handles that hang the runner, no assertion depends on speed, and the regex guard now measures CPU time (falling back to process CPU time on Node versions without `threadCpuUsage`) with a 500 ms wall-time cap; tests cover that fallback and the filter of unknown PR ids in explain jobs.

### 0.21.0 (2026-11-04)
- The command is now `/seki-review:review-prs` (skill `review-prs`, formerly `revisar-prs`).
- Code, dashboard, AI prompts and docs are in English; the AI answers in English.
- Deliveries: PRs of the same change across repos and environments are grouped into one delivery (by shared branch key, finding ID or cross-reference). Each delivery shows its stage (pending merge to testing, waiting for QA, QA failed, ready for production, in production, closed), the next action and alerts (stalled, merge order between repos).
- The default dashboard tab is now "Deliveries". Cards can be joined, split, renamed and closed; the adjustments are kept in the local data folder.
- "Since last visit" banner: lists the events (merges, closures, delivery adjustments) recorded since the banner was last dismissed, by the time they were recorded, so a merge first seen after the visit is still listed.
- Append-only event history (`eventos.jsonl`) with merges, closures and delivery changes; the same PR with an unchanged state does not duplicate events.
- Collection now includes recently merged and closed PRs (update-date window, `entregas.ventanaDias`); a partial refresh keeps the data of the other repos.
- New MCP tool `entregas`: deliveries by stage with the next action, and the events since the last visit with `desde: "ultima-visita"`. It reads the last refresh and makes no GitHub call.
- New endpoints `/api/entregas`, `/api/entregas/ajuste`, `/api/entregas/cerrar` and `/api/visita`.
- Merge watcher: while the dashboard tab is visible, GitHub is polled at `vigia.intervaloSeg` (default 300 s, minimum 120 s) with backoff on errors; it stops when the tab is hidden or the port is handed over.
- Shared data files are written atomically under a lock, so two sessions cannot corrupt or duplicate `prs.json` or `eventos.jsonl`.
- Regular expressions from the configuration (`patronId`, custom rules) are compiled with a guard and run with a 50 ms time limit: an invalid pattern is dropped, and a pattern that exceeds the limit is disabled for that run, each with a warning, instead of hanging collection or verification.
- Configuration values of the wrong type (for example a string where `entregas.sufijosRama` expects a list) fall back to their defaults with a warning.
- Per-project configuration: `entregas` (`sufijosRama`, `patronId`, `ventanaDias`, `alertaDias`, `cerrarTrasDias`, `maxPorSenal`), `vigia.intervaloSeg` and `orden` per repo; see `config/proyectos.ejemplo.json`.
- The launchers (`bin/servidor.sh`, `bin/tablero.sh`) now require Node 22 or newer and exit with a clear message otherwise.
- Skill arguments `deliveries` and `since-last` (Spanish `entregas`, `desde-ultima`).
- Known limits: a delivery is closed only after reaching production; the title override is keyed by the delivery key and is lost if that key changes; an ID or branch key shared by more than `entregas.maxPorSenal` PRs is not used for grouping; the watcher runs only while the dashboard tab is visible, with a minimum interval of 120 s.

### 0.20.0 (2026-10-29)
- Explanations with more diff coverage: the line budget is split by priority (schema and code first; screens, tests and documentation after; generated files left out) and per file, so one huge file no longer leaves the others unreviewed.
- Whatever does not fit in the message is kept as a patch on disk, and the AI reads it over a read-only copy of the PR, with the same secret blocks as Investigate.
- Coverage is measured from what the AI actually read (tool trace), not from what it claims. If code files remain unseen, a second pass completes them automatically.
- "Review what was missed" button in the partial coverage notice: extends the explanation with the pending files.
- The explanation is saved tied to the analyzed commit; previously it took GitHub's current commit and, if the PR advanced during the analysis, marked it as current when it was not.

### 0.19.4 (2026-10-28)
- More precise AI filter: each PR is classified as direct (its purpose is the need) or related (it touches the area for another purpose, such as fixing a login text). By default only direct ones are shown; "Show related" adds the rest with their label.
- The filter instructions no longer include a list of security topics that let any PR in the area in. Results saved with the previous instructions are discarded.

### 0.19.3 (2026-10-28)
- Handover between sessions: Claude Code sessions that do not serve the dashboard stay on standby and, if the serving one closes, one of them takes over on the same link within a few seconds.
- Only a newer version requests the port (numeric comparison): an old session no longer takes the dashboard away from a new one.
- The page reconnects on its own: without a server it shows "Offline: retrying" and polls again every 5 seconds.

### 0.19.2 (2026-10-28)
- With several Claude Code sessions open, the dashboard was served by the first one that opened it, even if it had an old version of the plugin. Now, if the open dashboard is from another version and has no jobs in progress, the new session requests the port and serves it on the same link. With jobs in progress, or if the old version cannot hand over, it explains what to do.

### 0.19.1 (2026-10-28)
- If the plugin is updated with the dashboard open, the page (read from disk) is newer than the server (still in memory): the dashboard reports both versions and asks to restart Claude Code, instead of answering "Does not exist" when a new feature is used.

### 0.19.0 (2026-10-28)
- AI filter: type a need in the search box ("cybersecurity PRs") and "Filter with AI" (or Ctrl + Enter) leaves in the queue only the PRs that match, each with its reason. The AI decides from title, branch and files, without reading the diff (a few seconds, cents per query).
- The result is saved per need and queue state: repeating it costs nothing while no PR changes; if the queue changes, the notice offers to filter again.
- "Save as view" keeps the need under "AI views" in the sidebar.
- The search box keeps a minimum width and the spend text is truncated on medium screens.

### 0.18.0 (2026-10-28)
- Selecting text in the AI's answer in a thread (Summary or Files) opens the bar to ask again about that fragment: the question stays in the same thread, quotes the fragment and highlights it in the answer. The AI receives the fragment as part of the previous answer, not of the explanation. The question box for the whole PR remains.
- Real progress while the AI works: stages (copies, reading, change, checks, correction) and how many files it read and searched, with the last file opened; also in the PR analysis.
- Notice when a job takes longer than usual, with the 10-minute limit.
- The progress bar and icon no longer restart with every dashboard refresh (every 3 s).
- The clock of jobs in progress is no longer announced every second by screen readers.
- The answer footer wraps to another line instead of breaking words.

### 0.17.1 (2026-10-28)
- While the AI works on a question or a change, the thread shows what it is doing, the elapsed time, a moving bar and how long it usually takes; the previous answer is dimmed. The status pulses instead of staying still.
- The dashboard is titled Seki Review.

### 0.17.0 (2026-10-28)
- New name: Seki Review (`seki-review`, formerly `pw-revision`). Command `/seki-review:revisar-prs`; environment variables `SEKI_*`.
- General-purpose tool: the project configuration, its context (stack and text rules) and its custom rules live in `~/.config/seki-review/proyectos.json`; the plugin ships only an example.
- When no project is given, `SEKI_PROYECTO` or the first one in the configuration is used.
- Generic rules explain their reason without referring to a specific project's incidents.

### 0.16.0 (2026-10-28)
- Every statement states its source: AI explanation, fixed rules (Verifications) or the person's note.
- The explanation records diff coverage and shows "Partial coverage" with the unreviewed files.
- Investigate saves the files the AI opened, its searches and the attempts blocked by permissions.
- "Was this helpful? Yes / No" on each answer; 30-day cost per model versus helpful answers.
- Approve records the attempt before the push and, if the process is interrupted, recognizes the already-pushed commit instead of repeating it.
- Prompts against sycophantic answers; optional real permissions test (`SEKI_PRUEBA_REAL=1`).
- Fixes the flaky test: the test repository did not detect a same-size change made at the same instant.

### 0.15.0 (2026-10-28)
- Description tab with the PR description and its commits.

### 0.14.0 (2026-10-27)
- Investigate reads the other repos on their equivalent testing or production branch, saves what it read and cleans up old copies.
- Ask about selected code in Files.

### 0.13.0 (2026-10-27)
- Investigate in the code (read-only, no secrets), full threads when asking again and formatted answers.

### 0.12.0 (2026-10-27)
- Ask about selected text in the summary, with highlighted quote and batch sending.

### 0.11.0 (2026-10-27)
- Narrower, hideable queue; ask about and expand summary sections.

### 0.10.1 (2026-10-27)
- Work-in-progress animation.

### 0.10.0 (2026-10-27)
- The skill opens the served dashboard; fixed link per machine.

### 0.9.0 (2026-10-27)
- Fixes from the final review: edit permissions, orphaned comments, XSS, approval chain and forks.

### 0.8.0 (2026-10-27)
- Change requests with a checked proposal, adjustment and approval that pushes to the branch.

### 0.7.0 (2026-10-27)
- Questions to the AI about lines, grouped by PR, with cache and visible cost.

### 0.6.0 (2026-10-27)
- Collapsible sidebar, line selection and manual notes with suggested code.

### 0.5.0 (2026-10-27)
- Files tab with GitHub-style diff.

### 0.4.0 (2026-10-27)
- Served dashboard with actions (refresh status, analyze with AI).

### 0.3.0 (2026-10-27)
- Dashboard as a review inbox; reviewer view with export and import.

### 0.2.0 (2026-10-26)
- Fixed verifications, testing PRs not in production, twin PRs across portals, effort, reading order and diagram.

### 0.1.0 (2026-10-26)
- MCP server, revisar-prs skill and local PR dashboard.
