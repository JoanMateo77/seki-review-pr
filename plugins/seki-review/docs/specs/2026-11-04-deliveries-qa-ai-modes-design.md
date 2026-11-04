# Deliveries, QA handoff and AI review modes — design

Status: approved in conversation on 2026-11-04 (proposal), this document pending review.
Scope: seki-review 0.21.0 → 0.23.0, three phases, one PR per phase to `main`.

## 1. Intent

Seki today is organized around single PRs and a manual "Refresh status" button. The owner's
real unit of work is a *delivery*: one fix that produces a PR to each testing branch and a
twin PR to each production branch, often split into backend and frontend repos that must
merge in order, sometimes repeated for two or three sister portals. After merging to
testing, a QA person tests manually and reports back; only then are the production PRs
merged.

The owner wants Seki to follow that flow by itself: notice merges, show what comes next,
produce the QA test guide, take the QA result back, and offer a cheap and a deep AI review
mode with real cost control. Today all of that happens by asking an AI in a chat and editing
spreadsheets by hand.

## 2. Goals

1. **Deliveries.** Group PRs into deliveries automatically and show them as a board by
   stage: *To merge in testing → Waiting for QA → QA approved, production pending → In
   production → Closed*, plus *QA failed*.
2. **Lifecycle.** Persist an append-only history of events per delivery (merged in testing,
   QA result, merged in production) with real timestamps; show "Since your last visit".
3. **Automatic detection.** While the dashboard is served, detect merges without a click.
4. **QA guide.** One button produces the test guide for the deliveries merged in testing
   since the last cut, as `.xlsx` (same columns and result list as the team's regression
   matrix) and `.pdf`; QA fills it and the owner imports it back.
5. **Tracker sync.** Importing a QA result updates the project's findings spreadsheet
   (status, PR links, "in testing"/"in production") through a configurable adapter.
6. **AI modes.** *Saving*, *Normal* (today) and *Ultra* (parallel lenses + verification
   pass + checks), a cost estimate before Ultra, and an enforced daily budget.
7. **Pay the debt in the path** (see §9).

## 3. Non-goals

- No merging, approving or commenting on GitHub. Approve-a-proposal stays the only write.
- No webhooks or third-party relays (smee and similar route traffic through a third party).
- No database, no npm dependencies, no build step. Node ≥ 18 standard library only.
- QA does not need to open Seki; the file is the interface (owner's call recorded on
  2026-11-04; revisit if QA later wants a browser view).
- No project-specific data in the repository: ID patterns, branch suffixes, spreadsheet
  columns and state names live in the user's `proyectos.json`.

## 4. Anti-goals (failure even if it technically works)

- Groupings the owner has to fix by hand every day (wrong deliveries are worse than none).
- AI findings without file:line evidence reaching the screen (benchmarks put precision of AI
  review tools at roughly 25–50%; noise is the main reason these tools get abandoned).
- A spreadsheet write that loses formatting, validations or other columns.
- Spend that grows without the owner noticing.

## 5. Constraints (from the codebase)

- Plugin = MCP stdio server (`mcp/server.mjs`, tools auto-registered from `mcp/tools/`) plus
  a dashboard served on 127.0.0.1 with a token and Host check (`lib/servidor-web.mjs`).
- The server lives inside one Claude Code session and hands the port over between sessions
  (`ceder`, version check). Any timer must stop when the process yields the port.
- Data files live under the project's `salida` directory (`datos/`, `explicaciones/`, ...).
- AI jobs run through `claude -p` in minimal mode with explicit tools, budget and turns
  (`lib/ia.mjs`); queue in memory with parallelism 1–2 (`lib/trabajos.mjs`).
- Twins today: Jaccard on titles ≥ 0.6 within one repo (`lib/gemelas.mjs`).
- Tests: `node --test 'test/*.test.mjs'` with doubles for `gh`, `claude` and git repos
  (`test/util/`); `node test/humo.mjs` smoke test.
- UI text in formal, impersonal English; identifiers follow the existing Spanish naming.

## 6. Design

### 6.1 Delivery grouping (`lib/entregas.mjs`, pure)

Input: the PR list of a snapshot (open + recently merged/closed, see 6.3). Output:
`Entrega[]` with a stable `clave`.

Signals, strongest first, combined with union-find:

1. **Normalized branch key.** Strip configured suffixes repeatedly and the type prefix:
   `fix/qa-x-y-pruebas` and `fix/qa-x-y` → `qa-x-y`; `feat/z-admin-pruebas`,
   `feat/z-portal-b` → `z`. Suffixes come from `entregas.sufijosRama` in the project config
   (default `["-pruebas", "-testing", "-staging"]`). PRs in different repos with the same key
   join the same delivery — this is what links backend and frontend.
2. **Finding IDs.** `entregas.patronId` (regex string, flag `g`, no default) applied to
   title, branch and body. Shared ID ⇒ same delivery. IDs are shown on the card.
3. **Title similarity.** Existing twin logic, only inside one repo and only to attach a PR
   that matched nothing above.

Manual overrides in `datos/entregas-ajustes.json` (`unir`, `separar`, `titulo`), applied
after the automatic pass so the owner can fix a bad grouping once.

Delivery title: the testing PR title without type prefix and environment marker; key and IDs
are always visible.

### 6.2 Stage and alerts (`lib/etapas.mjs`, pure, exhaustive)

Each PR has `ambiente` (`pruebas` | `prod`, from the configured lines) and `estadoPr`.
Stage of a delivery, evaluated in this order:

| Condition | Stage |
|---|---|
| every PR closed without merge | `descartada` |
| every prod PR merged | `en_produccion` (→ `cerrada` when marked closed or after `entregas.cerrarTrasDias`, default 7) |
| last QA result is *fail* | `qa_fallo` |
| last QA result is *ok* | `listo_produccion` |
| every testing PR merged | `esperando_qa` |
| otherwise | `por_mergear_pruebas` |

A delivery with no testing PR goes straight to `listo_produccion` with the alert
*no testing step*. A QA result older than the newest merge in testing is ignored (new code
needs a new QA pass).

Alerts (each one a tagged object with the PRs it concerns):
- `gemela_faltante`: a repo/line has a testing PR without the production counterpart, or the
  reverse.
- `orden`: a repo with higher `orden` (config, e.g. front = 2) merged in an environment
  before a repo with lower `orden` (back = 1) in the same delivery.
- `estancada`: in `esperando_qa` or `listo_produccion` for more than
  `entregas.alertaDias` (default 5).
- `sin_pruebas`, `qa_fallo`.

### 6.3 Collection changes (`lib/recolectar.mjs`)

- Add merged and closed PRs of the last `entregas.ventanaDias` (default 30) for every
  configured testing and production branch, author-filtered as today. One
  `gh pr list --state merged --base <b> --search "merged:>=<date>"` per branch, with the
  fields already used plus `mergedAt`, `closedAt`, `body`, `headRefName`.
- Snapshot keeps writing `prs.json` (compatibility) and adds `entregas.json` (derived).
- Snapshot comparison keeps working; merges are recorded as events (6.4) instead of only in
  "Detected changes".

### 6.4 Lifecycle store (`lib/eventos.mjs`)

- `datos/eventos.jsonl`, append-only, one JSON object per line:
  `{ id, ts, tipo, entrega, pr?, ambiente?, resultado?, origen }` with `tipo` in
  `pr_mergeada | pr_cerrada | qa_resultado | entrega_cerrada | entrega_ajustada`.
- `id` = SHA-256 of the identifying fields (e.g. `pr_mergeada|repo#n|mergedAt`), so
  re-collecting never duplicates. `ts` = GitHub `mergedAt` for merges.
- Writes go through one function that takes an exclusive lock file (`open(..., 'wx')`,
  stale after 30 s) because two Claude Code sessions may run the server code.
- Reading builds an index by delivery; the file is small (hundreds of lines per month).
- `datos/visita.json` stores the last time the board was opened per project; "Since your
  last visit" lists events after it.

### 6.5 Automatic detection (`lib/vigia.mjs`)

- Runs only in the process that owns the port, only while a browser polled `/api/estado` in
  the last 10 minutes, every `vigia.intervaloSeg` (default 300, minimum 120).
- Cheap probe per repo: `gh pr list --state all --search "updated:>=<last>" --json
  number,updatedAt --limit 50`. If anything changed, run the partial collection for that
  repo (already supported) and record events.
- Single-flight with the manual refresh, exponential backoff on errors (up to 30 min),
  stops on `ceder`. Status shown in the header ("Checked 2 min ago").

### 6.6 Board (dashboard)

- New default view **Deliveries**: one column per stage, cards with title, IDs, repo/portal
  chips, a small PR matrix (repo × environment with state and link), alerts, last event.
  Actions: open PR, generate QA guide for selected, mark closed, join/split.
- Banner **Since your last visit** with merged PRs and the next action for each delivery.
- The current PR view stays as a second tab; explanations, comments and AI actions are
  unchanged.
- The 2228-line `tablero/plantilla.html` is split into `tablero/partes/` (`estilos.css`,
  `estado.js`, `vista-prs.js`, `vista-entregas.js`, `hilos.js`, ...). `lib/tablero.mjs`
  concatenates them in a fixed order into one self-contained page at serve and generate
  time — no build tool, the standalone file stays a single HTML.

### 6.7 QA guide (`lib/qa-guia.mjs`, tool `qa_guia`, `POST /api/qa/guia`)

- Input: delivery keys, or `desde: "ultimo-corte"` (deliveries that entered
  `esperando_qa` since the last generated guide).
- Per delivery, content comes from, in order: the tracker row matched by finding ID (finding,
  how to reproduce, expected), the PR explanation (`como_probar` steps), the PR description.
  If a delivery has no explanation, a Saving-mode explain job is queued; until it finishes the
  row says *Steps pending*.
- Columns follow `qa.columnas` in the project config (default: ID, Portal, Screen and access,
  Preconditions and data, Steps, Expected result, Priority, Result, QA notes, Evidence, Date,
  Tester). Result uses a data-validation list from `qa.resultados` (default `OK, Fail,
  Blocked, Pending, N/A`). A hidden sheet `_seki` holds guide id, project, delivery keys and
  a SHA-256 of the visible content per row to detect tampering of keys on import.
- Text rules: the project's `contexto` already carries wording rules; the guide never shows
  PR numbers, branches or file paths in QA-facing cells.
- Output in `salida/qa/guia-<date>-<n>.{xlsx,html,pdf}`. PDF via headless Chrome if found
  (`qa.chrome` or the standard macOS/Linux paths), invoked with an argument array, never a
  shell string; without Chrome only `.html` is produced and the UI says so.

### 6.8 Minimal OOXML (`lib/xlsx.mjs`)

- Writer: workbook with sheets, inline strings, column widths, header style, frozen header,
  data validation lists, hidden sheet. ZIP built with `zlib.deflateRawSync` and
  `zlib.crc32` (Node ≥ 22; fallback table-based CRC32 for 18–20).
- Reader: ZIP central directory parse, `inflateRawSync`, and a strict sheet parser for
  `<row>/<c>/<v>/<is>` plus shared strings. Hardening: reject `<!DOCTYPE`/`<!ENTITY`, cap
  entries (200), per-entry and total uncompressed size (20 MB), path traversal in names,
  and file size on upload (5 MB).
- Cell editor for tracker sync: rewrites only the target `<c>` elements of one sheet as
  inline strings, keeping `s` (style) attributes; other parts are copied byte for byte.

### 6.9 Import and tracker sync (`lib/qa-importar.mjs`, `lib/rastreador-xlsx.mjs`)

- `POST /api/qa/importar` (body: file as base64, ≤ 5 MB) and tool `qa_importar { ruta }`
  (path must resolve inside `salida/qa/` or a path the user passes explicitly in the chat).
- Validates the `_seki` sheet (guide id known, row hashes match), maps results through
  `qa.mapeo` (e.g. `OK → ok`, `Fail → fallo`, `Blocked → bloqueado`) and appends
  `qa_resultado` events. Rows with Pending/empty are ignored. Returns a summary per delivery.
- Tracker adapter `tipo: "xlsx"` configured in `qa.rastreador`: `ruta`, `hoja`,
  `columnaId`, `columnas` (state, testing PR, prod PR, in testing, in prod) and `estados`
  (stage → text in that sheet). On each import and on each merge event it updates the rows
  whose ID belongs to the delivery. Before writing: copy to `salida/respaldos/` with
  timestamp; refuse if an Office lock file (`~$<name>`) exists; never touch other columns.
- If no tracker is configured, import still records events and the board advances.

### 6.10 AI modes and budget (`lib/ia.mjs`, `lib/perfiles.mjs`, `lib/ultra.mjs`)

- One table `PERFILES[modo][tipo] = { modelo, topeUsd, turnos, segundaPasada }` replaces the
  scattered constants; `SEKI_IA_*` variables still override. Project default
  `ia.modo` (`ahorro | normal | ultra`, default `normal`), per-job override from the UI.
  - *Saving*: Haiku for answer/filter, Sonnet elsewhere; no second coverage pass; reuse any
    result cached for the same `headSha`.
  - *Normal*: current behaviour.
  - *Ultra*: job `revisar_ultra` = N lenses in parallel (correctness, security —
    OWASP Top 10 and payments-sensitive data handling —, project guidelines from
    `lineamientos`), each `claude -p` with Read/Grep/Glob on the read-only PR copy plus the
    other repos at their testing/production branch; then a verification job that re-reads
    every cited `file:line` and keeps only CONFIRMED/PLAUSIBLE findings; then the project's
    `comprobar` checks (types, related tests) through the existing `calidad.mjs`.
- `ia.rutasSensibles` (regex list) marks PRs for which the board *suggests* Ultra; the owner
  always confirms.
- Cost estimate before Ultra: median cost of past jobs of the same type/mode from
  `costos.jsonl` × lenses (or the caps when there is no history), shown in the confirm.
- `ia.presupuestoDiarioUsd`: the queue does not start a job if today's spend plus its cap
  exceeds the budget; the job waits as *Blocked by budget* with a one-time "Run anyway".
- `costos.jsonl` gains `modo` so the cost panel compares modes against "Was this helpful".

### 6.11 Skill and tools

- New MCP tools: `entregas` (board summary, "since last visit"), `qa_guia`, `qa_importar`.
- `skills/review-prs/SKILL.md`: new arguments `deliveries`, `since-last`, `qa-guide`,
  `qa-import <path>`, `ultra <repo>#<n>`; the chat consults the event history before asking
  GitHub, and does not repeat analysis for an unchanged `headSha`.

## 7. Security

- Every new endpoint behind the existing token and Host check; JSON bodies capped (1 MB,
  5 MB for the QA import).
- No shell strings: `execFile` with argument arrays for `gh`, git, Chrome, `claude`.
- Paths: generated files only under `salida/`; tracker path only from the config file;
  imported paths resolved and checked against the allowed roots (no `..`, no symlink escape
  via `realpath`).
- XML/ZIP hardening as in 6.8; HTML output escapes every value; no inline event handlers.
- Regex from config compiled once at load with a length cap; invalid patterns are a config
  error, not a crash.
- No secrets or project data in logs; errors carry a tag and a safe message.

## 8. Testing

Unit tests (pure, no network) for: branch normalization and union-find grouping, overrides,
stage table and alerts (one test per row), event id idempotency and lock handling, watcher
single-flight/backoff (fake clock), xlsx round trip (write → read → equal), validation list
and hidden sheet present, hardening cases (DOCTYPE, oversize entry, traversal), tracker cell
edit keeps styles and other cells byte-identical, import mapping and hash mismatch, profiles
table, budget gate, cost estimate. Integration: smoke test extended to build a board with
deliveries from the `gh` double. Existing tests must stay green.

## 9. Debt paid in the path

- Split `plantilla.html` (6.6).
- Tests for `recolectar`, `gemelas`, `cambios` (none today).
- Daily spend becomes enforced (6.10).
- Failed AI jobs log a reason in `costos.jsonl` (today one record has `ok:false` and no
  cause).

## 10. Phases

| Version | Content |
|---|---|
| 0.21.0 | 6.1–6.6, events, watcher, board, template split, collection tests |
| 0.22.0 | 6.7–6.9, QA guide xlsx/pdf, import, tracker adapter |
| 0.23.0 | 6.10–6.11, AI modes, Ultra, budget, skill update |

Each phase: branch `feat/...` from `main`, tests green, CHANGELOG entry, version bump in
`plugin.json` and `server.mjs`, PR to `main`. The owner merges and tags.

## 11. Left to the builder

Card layout details, exact copy of UI strings (formal, impersonal English), internal module
boundaries inside `tablero/partes/`, default column widths in the guide, backoff constants
within the stated ranges.

## 12. Resolved after review (supersedes earlier sections where they differ)

A builder/architecture review on 2026-11-04 checked this document against the code. Its
questions were settled as follows; items marked *(builder's call)* were decided by the author
of this document and can be revisited.

### Grouping and stages

- **Back/front linking.** Real pairs share the branch name once portal suffixes are removed
  (`fix/a-b` in both repos; `feat/c-pruebas` in the back and `feat/c-admin-pruebas` in the
  front). `entregas.sufijosRama` therefore lists environment *and* portal suffixes (project
  config). A fourth signal is added: `Relacionada: owner/repo#n` (or `Related:`) lines in the
  PR body, read from the first 4 KB.
- **Sister portals** *(builder's call)*. One delivery holds one *track* per portal line. Stage
  and alerts are computed per track; the delivery shows the least advanced track and the card
  lists every track. `gemela_faltante` and `orden` are evaluated per track.
- **Other authors.** Collection stays author-filtered (personal tool). Out of scope.

### QA rows, results and cuts

- **Row granularity** *(builder's call)*. One guide row per finding ID; a delivery without
  IDs gets one row. A track is `ok` when all its rows are OK, `qa_fallo` if any row is Fail,
  and stays `esperando_qa` while any row is Pending/empty. Blocked keeps it waiting with an
  alert.
- **Cuts.** `datos/guias.json` registers each generated guide (id, date, deliveries, row ids,
  latest testing merge per delivery). "Since the last cut" = deliveries in `esperando_qa`
  whose latest testing merge is not covered by any registered guide. A new testing merge after
  a guide requires a new guide; older results for that delivery are ignored (6.2).
- **Import conflicts** *(builder's call)*. Last import wins per row; the event stores the file
  SHA-256, the guide id and the tester column. Only deliveries listed in a registered guide
  and still in `esperando_qa`/`qa_fallo` accept results.
- **Integrity.** Row protection is an HMAC-SHA-256 with a per-install secret stored next to
  the access token (`acceso.mjs`), not a plain hash; it detects edited keys, not a malicious
  insider with the secret.

### Tracker

- **Format.** The current tracker is an openpyxl workbook: inline strings, styles, two
  data-validation lists, an auto filter, no merged cells, formulas, tables or calcChain. Once
  saved by Excel it will use shared strings, so the editor must handle `t="s"` cells
  (rewrite the target cell as inline, leave `sharedStrings.xml` untouched), create missing
  cells in column order, and keep `<dimension>`, `spans`, validations and filter valid. A
  sanitized fixture builder generates both variants for tests.
- **When it writes** *(builder's call)*. Never from the watcher. Merge events accumulate as
  pending tracker updates shown in the board; they are applied on QA import or with the
  "Update spreadsheet" button. Opt-in `qa.rastreador.escribirEnMerge` (default false) for later.
  Reading the tracker for guide content works with `escribir: false`.
- Before writing: regular file, not a symlink, no Office lock file, backup copy, write to a
  temp file in the same directory and rename.

### Collection, events and watcher

- **Partial refresh fix first.** `recolectar({repos})` currently writes the subset as the
  whole `prs.json` and skips the comparison. Phase 1 makes partial refresh merge into the
  previous snapshot (replace only the touched repos) and diff against it, with a test, before
  the watcher uses it.
- **One fetch path.** No new `gh pr list --state merged`; extend `prsDeBase` with `mergedAt`,
  `closedAt`, `body`, `headRefName` and paginate until `ventanaDias` is covered (today it
  stops at 300 PRs by creation date).
- **One detection owner.** Events come from merged/closed data already in the snapshot
  (pure, idempotent by id). `cambios.mjs` keeps only the open-list diff; no second per-PR
  lookup.
- **`limpiarCopias`** keeps filtering on `estadoPr === 'OPEN'` now that `prs.json` carries
  merged PRs; all `prs.json` consumers are checked for merged entries.
- **Watcher lifecycle.** The watcher belongs to the per-project server record, counts as busy
  for `ceder` (refuse while a cycle runs), and its timer is cleared on `ceder`/close.
  "Dashboard open" is detected with a dedicated marker sent by the browser (header on
  `/api/estado`), not by standby sessions' probes.
- **Shared writes.** New `lib/bloqueo.mjs`: exclusive lock file with pid and time, stale only
  if older than 30 s *and* the pid is not alive. All shared `datos/*.json` writes (not only
  events) go through write-to-temp + rename under the lock.

### AI modes and budget

- **Ultra in the queue.** `revisar_ultra` is one queue job with internal concurrency bounded
  by the queue's `PARALELO`; lenses that fail are reported in the result; lens and
  verification costs are summed into one `costos.jsonl` record with a `detalle` breakdown. No
  second scheduler. Three fixed lenses in code for 0.23 (correctness, security, guidelines).
- **Budget gate.** Machine-wide (all projects), day in the machine's local time zone. The gate
  keeps an in-memory reservation (sum of caps of running jobs) to avoid two jobs passing at
  once, counts failed jobs, and covers every `claude -p` call site: `ia.mjs`, `filtrar.mjs`
  and the AI steps around `calidad.mjs` (the checks themselves cost nothing).
- **Precedence.** environment variables > job override > project `ia.modo` > defaults.
  `TOPES`/`TURNOS` stay exported as the *normal* row so existing tests keep passing.

### Hardening

- **ZIP/XLSX reader.** Inflate with `maxOutputLength` (declared sizes are untrusted); reject
  encrypted entries, ZIP64, duplicate names, unsupported data descriptors and size mismatches;
  read only known part names resolved through the relationships, never write archive names to
  disk; require UTF-8 (reject BOM-declared UTF-16) and reject `<!DOCTYPE`/`<!ENTITY`
  case-insensitively; cap rows (5 000), columns (100) and cell length (32 767). Tests: zip
  bomb, overlapping entries, mismatched sizes, DOCTYPE, UTF-16.
- **`qa_importar { ruta }`.** `realpath`, `.xlsx` extension, regular file, size checked with
  `stat` before reading (≤ 5 MB), inside `salida/qa/` or `~/Downloads`; anything else needs
  `confirmar: true` in the call, which the skill only sets after the user names the path.
- **Regex from config.** Applied only to bounded inputs (title, branch, first 4 KB of body,
  file paths), match count capped, nested-quantifier shapes such as `(a+)+` or `(.*)*`
  rejected at load, test with a pathological input. The same guard is added to the existing
  `reglasDeConfig` (same-PR debt).
- **Chrome.** Kept (the owner asked for a PDF). Throwaway `--user-data-dir` deleted after,
  `--headless`, never `--no-sandbox` or `--allow-file-access-from-files`, timeout with kill
  (same pattern as `correr` in `calidad.mjs`), serialized with `enTurno`. The HTML is built
  only from escaped values, no remote resources, and carries
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`.
- **Node.** The launcher requires Node ≥ 22 (`zlib.crc32`); the CRC32 fallback is dropped.

### Delivery order inside phase 1

1. Routing `gh` double (arg pattern → JSON, records calls) and per-call `claude` double;
   tests for `gemelas`, `cambios`, `recolectar`.
2. Template split as a pure refactor, with a test that the generated page is byte-identical to
   the previous one for a fixed snapshot.
3. Partial-refresh fix and `bloqueo.mjs`.
4. Grouping, stages, events, board.
5. Watcher (last, possibly its own PR).
