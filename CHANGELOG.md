# Changelog

Each version has its `seki-review-vX.Y.Z` tag on the commit that releases it.

## seki-review

### 0.27.0 (2026-11-11)
- Base template `sesion-identidad` (Sessions and identity, items S1 to S6): token verification, binding of OAuth, OIDC and SAML callbacks, CSRF on cookie-authenticated routes, account recovery and MFA changes, API key scope, and session rotation and revocation. Activated by paths whose name contains auth, login, session or sesion, token, jwt, sso, passport, password or clave, mfa, otp or apikey.
- Base template `cliente-navegador` (Browser client, C1 to C5): DOM injection sinks, postMessage origins, tokens in browser storage, redirect targets and prototype pollution. Activated by `.tsx`, `.jsx`, `.vue`, `.svelte`, `.html` and `.htm` files and scripts under `public/`, `static/` and `assets/`.
- Base template `aislamiento-datos` (Data isolation and lifecycle, D1 to D6): tenant scope of exports and reports, tenant in cache keys, search filters and object paths, invalidation of derived copies, soft-delete conditions, migration defaults and imports. Activated by paths about export, report or reporte, download or descarga, cache, search or busqueda, backup, migration or migracion, delete or eliminar, purge and retention.
- Base template `cadena-suministro` (Supply chain and release, K1 to K6): untrusted code in privileged CI workflows, event fields interpolated into scripts, secrets in the image build context, pinning of actions and base images, lockfile and registry of dependencies, and who can publish. Activated by `package.json`, lockfiles, `.npmrc`, Dockerfiles, `.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`, `bitbucket-pipelines.yml`, other CI files and publish or release scripts under `scripts/` or `bin/`.
- Base template `mensajeria-webhooks` (Webhooks, queues and RPC, M1 to M6): callback signatures, identity taken from the producer and not the body, safe decoding, replay, ordering, and what failure paths expose. Activated by paths about webhook, callback, queue or cola, consumer, subscriber, worker, kafka, sqs, rabbit, amqp, pubsub, grpc and `.proto` files.
- Base template `disponibilidad` (Resource exhaustion, R1 to R6, none blocking, topic `availability`): size limits before parsing, bounded bulk work, regular expressions and parser depth, expensive work before authentication, capped retries and overlapping scheduled runs. Activated by paths about upload or carga, import, bulk, batch or masivo, parse, cron, job, scheduler and stream.
- Base template `nube-despliegue` (Cloud and deployment, N1 to N6): literal secrets in configuration, public ports, public buckets, IAM wildcards, container privileges and identity headers trusted from the proxy. Activated by Terraform, Kubernetes, Helm, serverless, compose, CloudFormation, Bicep, Wrangler, nginx and ingress files.
- Base template `ia-llm` (AI and LLM, A1 to A6): permission checks inside model tools, model output reaching SQL, shell, paths, URLs or HTML, tenant scope of retrieval and history, secrets in prompts, confirmation of side-effecting actions and per-request limits. Activated by paths about llm, prompt, openai, anthropic, claude, gemini, agent, embedding, rag and `mcp/`.
- The eight templates are in English, exclude test files like `owasp-web`, mark as blocking only the items whose failure crosses an access, tenant, secret or execution boundary, and do not declare `cubre`: they never make Ultra skip its security lens.
- The Ultra security lens requires each finding to name the lower-trust actor, the accepted input or action, the control that should stop it and the concrete result for another principal or resource. A missing best practice, a redundant layer, self-impact or a guess about deployment is at most `baja`, never `alta`; `alta`, `media` and `baja` have explicit anchors and severity cannot exceed the result the code shows.
- The verification step tries to disprove each security claim: CONFIRMED needs the full path in the available code, a deciding control outside the repository makes it PLAUSIBLE with the missing fact, and a control already in the code or an effect only on the actor's own resources makes it REJECTED.
- The template review answers a security item `falla` only when the code shows the boundary can be crossed, `no_verificable` with the exact question when the deciding control is outside the code, and `cumple` citing the control when another one in the code already prevents the attack.
- `plantillas/NOTICE.md` records that the eight templates and these prompt principles are adapted from github.com/cloudflare/security-audit-skill at commit c1c8a8c1471069fb0e188eeaff69b8e8db6564a8, with its MIT license; a test fails if the notice loses the commit or the copyright line.

### 0.26.0 (2026-11-10)
- Fixed rule `ejs-sin-escapar` no longer flags a `<%- %>` tag that can only print string literals: a `'…'`, `"…"` or backtick literal without `${`, or `cond ? LIT : LIT` whose `cond` has no other `?` (`?.` and `??` are allowed). A line is flagged when any of its `<%-` tags does not qualify, and a `<%-` with no `%>` on the line is flagged.
- The list of files of a PR is cached per head commit (`owner/repo#n@headSha`) and an older commit of the same PR is dropped, so checks, diffs and templates follow a push; a failed request is not kept, and without a commit nothing is cached.
- Every finding carries a `huella` (16 hex characters of the hash of rule, file and whitespace-collapsed text; the line is not part of it, so a push that only shifts the code keeps it). A line finding also carries `hashLinea`, the hash of the whole whitespace-collapsed line, and the fingerprint uses it in place of the text cut to 200 characters, so a change after column 200 is a new finding; a finding cached before it keeps the fingerprint of its text until the checks run again.
- Dismissals are stored by Seki in `salida/verificaciones/descartes/<repo>-<n>.json`, never in the PR code: `motivo` is required (1 to 500 characters), the entry records who proposed it (`ia` or `persona`), dismissing again replaces the entry, and a dismissal can be reopened. Dismissed findings leave the open list and the summary by severity and are served under `descartados`; reads and writes of the file run under one lock, as the MCP server and the board are two processes.
- AI job `triar_checks`: one read-only call per PR gives each blocking, high or medium finding a verdict (`real`, `falso_positivo`, `dudoso`) and a reason of at most 300 characters; at most 40 findings per call, most severe first. A `falso_positivo` needs a reason and an `evidencia` (`archivo`, `linea`) that exists in the copy, otherwise it is stored as `dudoso`, as is a finding without a verdict or with an invalid one; malformed evidence is dropped. The PR title goes inside the JSON data block of the prompt. The findings of the `atribucion-ia` rule are commit-level and are not triable (no verdict, no "Fix"); a person can still dismiss them with a reason. Runs in every mode with its own profile (Sonnet or Opus; never Haiku, not even when `SEKI_IA_MODELO` or `SEKI_IA_MODELO_TRIAR_CHECKS` asks for it; cap 1 USD, 25 turns), through the queue and the daily budget.
- The triage is stored per commit in `salida/verificaciones/triaje/<repo>-<n>.json` and marked `desactualizado` after newer commits, while its verdicts keep showing for the fingerprints that remain. It is started only from the board with `confirmar: true`, never from the chat or an MCP tool; a stored triage of the current commit is returned without a job.
- New routes `GET /api/checks` (stored triage, dismissals, triable count, estimate, cap of a triage and of a fix) and `POST /api/checks/triar`, `/descartar`, `/reabrir` and `/arreglar`. Dismissing several findings at once is accepted only when all are medium with a `falso_positivo` verdict of a triage of the current commit; a blocking finding is dismissed one by one. The AI reason is offered in the dialog, and taken as the `motivo` when none is sent, only from a `falso_positivo` verdict of the current commit; otherwise a reason is required. An AI reason kept as is is stored as proposed by the AI, a reason written by a person as proposed by the person. `arreglar` needs `confirmar: true`.
- Dashboard, Checks tab: verdict and reason per finding (marked when they come from an earlier commit), "Validate with AI" with estimate and confirmation (only on an open PR with triable findings), "Dismiss" with a required reason, "Dismiss all false positives" for two or more medium ones while the triage is of the current commit (it sends the fingerprints listed in the dialog), a "Dismissed" section with "Reopen", and the link `#/pr/<repo>/<n>?checks=1`, which opens the tab and starts nothing.
- "Fix" on a finding with a line goes through the change proposals: the server creates a `cambio` comment on the flagged line (with `origenCheck`, which keeps the AI reason when the triage is of the current commit) after a confirmation that shows the cost cap, and nothing is pushed until Approve. The AI reason is not part of the request: the change job receives it as a separate line labelled as data. A finding with a request in progress, ready or approved on the current commit cannot be sent again; after an error, a discarded proposal, a cancellation of the queue (the request ends as failed with the reason `Cancelled`) or a fix approved on an earlier commit it can. A fix that cannot be queued answers 409 and leaves its request failed.
- The proposal of a fix stores `check.resuelto`, true only when the patch removes the flagged line (same line number and text, compared through `hashLinea` for a line longer than 200 characters) and the rule no longer fires in that file; when it is false the proposal says so and Approve asks for a second confirmation, as with failing checks. The commit title is `fix(<scope>): <what>` (a plain summary is prefixed with `fix: `).
- On a PR of another author the approve button names the owner of the branch in every state, and after approving a check fix on a PR with a twin the notice says the twin does not have it.
- Ultra reads the check findings of the snapshot PR when they are of the same commit (dismissals applied when the job runs; the file `pr_verificaciones` stores is read only for a PR without checks): the correctness and security lenses receive them as unverified patterns and the verification step gets a card for each of the 15 most severe triable findings (`check-<huella>`, with the flagged code); the rest keep no verdict. Its verdicts (`CONFIRMED` is `real`, `PLAUSIBLE` is `dudoso`, `REJECTED` is `falso_positivo`, and a rejection without a reason is `dudoso`) are stored as the triage with `origen: 'ultra'` and cost 0, only for fingerprints that a stored triage of the same commit has not judged or left without a verdict; check cards never appear among the Ultra findings. The verification runs when there are check findings even if no lens found anything.
- `pr_verificaciones` with `repo` and `numero` also returns `huella` on each finding, `descartados`, the stored `triaje` and the `tablero` link; they are read-only there. The skill `verify` shows them and points to the board. `prs_pendientes` and the explanation prompt leave out dismissed findings.
- The action column of the Checks tables has a hidden label, and `.sr` is the board's shared visually hidden class.
- Nothing new writes to GitHub: the push of Approve remains the only write.

### 0.25.0 (2026-11-09)
- Review templates: JSON checklists in `plugins/seki-review/plantillas/` (`ligera`, `owasp-web`, `pci-dss`) selected by the files a PR changes (`siempre` or the `aplicaA` globs minus `excluir`); the light baseline always applies. Each item has a question, the evidence it needs, the fixed rules that decide it (`reglas`) and what a failure means (`siFalla`: Conventional Comments label, blocking or not, topic). Invalid template files are skipped with a warning.
- Fixed rules: `tipo-any` (`any` in type positions: annotations, generic arguments, unions, aliases; lines that start as a comment are skipped) and `rutas-en-otros-repos`, which finds the routes a PR adds or removes in the other configured repositories. Only Express declarations count (`app`, `router`, `*Router`, `routes`, `rutas*` before `.get/.post/.put/.patch/.delete/.all(`, also across lines with blank or comment lines in between); client calls and `.use(` prefixes are not routes, and a hit in the other repository that declares the same route is not counted as a call.
- Cross-repo route rule: a route matches only at a segment boundary, so `/v2/orders` is not a use of `/v2/ordersBulk`, `/v2/orders/${id}` or `/v2/orders/:id`.
- Cross-repo route rule: hits in tests, mocks, e2e, docs, `*.spec.*`, `*.test.*`, `.md`, `.mdx` and `.txt` files are flagged (`soloPruebas`) and taken after real hits when the cap of 3 per repository applies; an item whose findings are all of that kind fails but never blocks, and its comment says "Only in tests or docs.".
- Cross-repo route rule: `<receiver>.route('/x')` declares the route whatever verb is chained, also across lines.
- Template comments from fixed rules list every other finding of the item as a bullet (distinct messages with `file:line`, at most 10, then `- and N more`).
- When comments were cut by the cap of 5 per template, the Markdown ends with a note that says how many were left out, in the language of the first template.
- Template review job `revisar_plantillas`: explicit, confirmed, one read-only AI call per active template with a per-item state (`cumple`, `falla`, `no_aplica`, `no_verificable`); a state of `cumple` or `falla` needs a quote that exists in the cited file and line, otherwise the item becomes `no_verificable`. Items with fixed rules are decided without AI (a selection with no AI items runs at cap 0). One verification call judges the failures (`CONFIRMED`, `PLAUSIBLE`, `REJECTED`); a rejected failure becomes a question for the author. Runs in every AI mode with its own profile and cap, and respects the daily budget.
- Conventional Comments are built from the results (at most 5 per template; only confirmed or fixed-rule failures marked as blocking can block; `nitpick` never blocks) and stored per commit in `salida/plantillas/<repo>-<n>.json`, marked outdated after newer commits. The "Not verifiable from the diff" block lists only items with a question for the author; the rest show on the board only.
- New endpoints `GET /api/plantillas?repo=&numero=` (selection, estimate and stored result; the estimate is the median cost per AI template of past runs times the templates that need AI) and `POST /api/plantillas` (`confirmar: true`, `repetir`; a stored result for the commit is returned without a job).
- Dashboard: "Templates" tab with the selection and why each template applies, confirmation with the estimate, job status, checklist and comments preview; "Copy review" appends the template comments of the current commit.
- New read-only MCP tool `pr_plantillas` and skill argument `templates <repo>#<n>` (Spanish `plantillas`).
- Config: `plantillas` per project is a folder of your own templates (a file with the same `id` replaces the built-in one); an invalid value is ignored with a warning, and a folder that does not exist is reported with the invalid templates. Shown in `config/proyectos.ejemplo.json`.
- Fix: every copy button shares one feedback helper, so the "Copied" label no longer stays stuck; "Copy review" works inside the click gesture and has fallbacks when the clipboard is refused.
- Template runs share the cached prefix: each call starts with the same context (PR, repositories, changed files, diff) and ends with its items, and the first call is awaited alone so the rest read the prompt cache.
- Template runs unchanged since the stored result are reused: a template whose version, items and activating patches (`huella`) did not change keeps its answers (`reutilizada`, cost 0) as long as every quote it holds is still in the code of the new commit, and only new failures are verified; `repetir` calls everything, and a run where all templates are reused makes no AI call and no cost record.
- The cost record and each step of `revisar_plantillas` carry the token usage (`uso`); the estimate is the sum of the median cost of each AI template over past steps, then the per-template run median, then the cap.
- The result stores the other branches it read (`ramas`; a reused answer keeps the commit it was given at); `GET /api/plantillas` and `pr_plantillas` report `ramasMovidas` when the local copy of one of them is at another commit (no fetch).
- Ultra review skips the security lens when the template review of the same commit covers it: templates declare `cubre` (optional list of lens names, validated; `owasp-web` and `pci-dss` declare `seguridad`), the skipped lens is recorded with the reason "Covered by the template review of this commit" and makes no call, `GET /api/ultra` and `pr_ultra` return `lentesCubiertas`, and the cap (`topeRevisarUltra(n)`), the estimate (history median times n/3) and the confirmation dialog count the lenses that will run.
- Nothing is published to GitHub: comments are only copied by hand.

### 0.24.0 (2026-11-06)
- Review intake: the open PRs where the owner is requested directly as reviewer (`user-review-requested:<login>`; team requests are not included) reach the snapshot on every refresh and are remembered in `salida/datos/revisar.json`, so they stay after the owner reviews them on GitHub until they are merged, closed or removed. Items carry `paraRevisar` (`solicitada` or `enlace`); those that are not the owner's own also carry `soloRevision` and stay out of deliveries, merge and new-PR events, the QA guide and the orphan and recent lists.
- A PR can be added by link without spending AI and without writing to GitHub: `https://github.com/<owner>/<repo>/pull/<n>` with any suffix, `<owner>/<repo>#<n>`, `<repo>#<n>` or `<repo> <n>`. The link is parsed and validated against the project (owner, configured repo, number, 500 characters) before any `gh` call; a closed or merged PR is refused.
- New endpoints `POST /api/revisar` and `POST /api/revisar/quitar` (token, Host check, strict JSON, 16 KB); each change refreshes its repo through the single-flight path. Removing a requested PR hides it while GitHub still requests the review; the hidden entry leaves the list once GitHub stops requesting it.
- Dashboard: "To review" section first in both views, split into "Needs my review", "Waiting on the author" and "Approved by me" from the local decision, with the "Requested" or "Added by link" badge and the author; "Review a PR" field in the top bar; "Remove from To review"; an unknown `#<repo>#<n>` route is explained; "Copy review" in the Review tab copies the decision, comments and notes as Markdown.
- The bulk "Analyze those without an explanation" action skips these PRs: they are analyzed one by one from their detail. A corrupt `revisar.json` is copied to `revisar.json.corrupt-<timestamp>` (and logged) before a new list starts.
- New MCP tool `pr_revisar { enlace }`; `prs_pendientes` lists a "To review" section apart from the groups; skill argument `review <link>` (Spanish `revisar <link>`).

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
