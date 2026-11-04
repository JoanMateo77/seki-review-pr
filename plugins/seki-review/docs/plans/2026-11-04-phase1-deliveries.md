# Phase 1 (0.21.0): deliveries, lifecycle and watcher — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group PRs into deliveries, show them as a board by stage with alerts, persist an event history, and detect merges automatically while the dashboard is served.

**Architecture:** Pure modules (`entregas.mjs`, `etapas.mjs`, `eventos.mjs` derivation, `patrones.mjs`) fed by the existing snapshot; `recolectar.mjs` gains recent merged/closed PRs and a merging partial refresh; a lock module makes shared writes safe across sessions; the server owns a watcher; the dashboard template is split into parts first (pure refactor) and then gains a Deliveries view.

**Tech Stack:** Node ≥ 22 standard library only (`node:test`, `node:crypto`, `node:fs`), `gh` CLI, self-contained HTML/CSS/JS.

**Spec:** `plugins/seki-review/docs/specs/2026-11-04-deliveries-qa-ai-modes-design.md` (§6.1–6.6 and §12; §12 wins where they differ).

All paths below are relative to `plugins/seki-review/`.

## Global Constraints

- No npm dependencies, no build step; Node ≥ 22 (launcher `bin/servidor.sh` enforces it).
- Identifiers and config keys in Spanish as the codebase does; UI text, docs, commits in formal, impersonal English; no emojis.
- No project-specific data (ID patterns, branch suffixes, names) in the repo: defaults generic, real values in `~/.config/seki-review/proyectos.json`.
- Every `datos/*.json` write goes through `escribirJson` (atomic, locked) after Task 3.
- Process spawns only through `execFile` with argument arrays.
- Commits: `seki-review: <what changes>`, no AI trailers, real git identity.
- Tests: `node --test 'test/*.test.mjs'` and `node test/humo.mjs` from `plugins/seki-review` stay green after every task.
- Config defaults (spec §6.1–6.5, §12): `entregas.sufijosRama = ["-pruebas", "-testing", "-staging"]`, `entregas.patronId = null`, `entregas.ventanaDias = 30`, `entregas.alertaDias = 5`, `entregas.cerrarTrasDias = 7`, `vigia.intervaloSeg = 300` (minimum 120), dashboard-open window 10 min, watcher backoff up to 30 min, lock stale = older than 30 s and pid not alive, body scanned = first 4096 chars.

## Review Focus

1. A PR whose branch reduces to an empty or generic key (`main`, `develop`, `fix/x-pruebas` → `x`) must not glue unrelated PRs together — test: keys shorter than 3 chars or equal to a configured base branch are not used as a join signal (Task 5).
2. A config `patronId` such as `(a+)+$` or a 2 MB PR body must not hang collection — test with pathological input under 200 ms (Task 4).
3. Two sessions writing `prs.json` / `eventos.jsonl` at the same time must not corrupt or duplicate — test with two concurrent writers (Task 3, Task 7).
4. The watcher must never run while the port is being handed over or after `ceder` — test with fake clock (Task 9).
5. A PR reopened or retargeted to another base after merge-like events must not produce duplicate or contradictory events — test: same PR id with new `mergedAt` creates one new event, unchanged one creates none (Task 7).

---

### Task 1: Routing `gh` double and tests for twins and snapshot comparison

**Files:**
- Create: `test/util/gh-rutas.mjs`
- Create: `test/gemelas.test.mjs`, `test/cambios.test.mjs`

**Interfaces:**
- Produces: `falsoGhRutas(rutas: Array<{ patron: string /* regex over the joined args */, json: unknown }>) => { ruta: string, llamadas: () => string[][], fijar: (rutas) => void }`. The fake is a Node script: joins argv with spaces, returns the `json` of the first matching route (stdout), exits 1 with `no route` on stderr when none matches, appends each argv as a JSON line to a calls file. Set `process.env.SEKI_GH = ruta` in tests.

- [ ] **Step 1:** Write `test/gemelas.test.mjs`: `tokensTitulo` strips conventional prefix and brackets (`'fix(lotes): Fecha [pruebas]'` → `{'fecha'}`... assert exact set), `parecido` of identical titles is 1 and of disjoint titles 0, `buscarGemela` returns the best candidate ≥ 0.6 and `null` below.
- [ ] **Step 2:** Write `test/cambios.test.mjs` using `falsoGhRutas`: previous snapshot with open `r#1` and `r#2`, current with `r#2` (moved group) and `r#3`; route `api repos/o/r/pulls/1` → `{ merged_at: "2026-11-01T10:00:00Z", state: "closed" }`. Assert `mergeadas[0].id === 'r#1'` with that date, `nuevas` = `r#3`, `movidas` = `r#2`; `hayCambios` true; `compararFotos(null, x)` → `null`.
- [ ] **Step 3:** Run `node --test test/gemelas.test.mjs test/cambios.test.mjs` → FAIL (double missing).
- [ ] **Step 4:** Implement `test/util/gh-rutas.mjs`.
- [ ] **Step 5:** Run the two files → PASS; full suite → PASS.
- [ ] **Step 6:** Commit `seki-review: routing gh double and tests for twins and snapshot comparison`.

### Task 2: Split the dashboard template (pure refactor)

**Files:**
- Create: `mcp/tablero/partes/*` (ordered parts, each ≤ 400 lines; split CSS at section comments and JS at top-level function boundaries; no edits inside the parts)
- Create: `mcp/tablero/partes/orden.json` (array of part file names)
- Delete: `mcp/tablero/plantilla.html`
- Modify: `mcp/lib/tablero.mjs` (`PLANTILLA` read → `leerPlantilla()`)
- Test: `test/plantilla.test.mjs`

**Interfaces:**
- Produces: `leerPlantilla(): string` exported from `mcp/lib/tablero.mjs` — concatenation of the parts in `orden.json` order, read from disk on every call (same hot-reload behaviour as today).

- [ ] **Step 1:** Before deleting, record `sha256(plantilla.html)` of the current file as the constant `HASH_PLANTILLA_0_20` in the test. Test: `sha256(leerPlantilla()) === HASH_PLANTILLA_0_20`; and `construirHtml(p, fotoFija, null)` contains no remaining `/*DATOS*/` marker.
- [ ] **Step 2:** Run → FAIL (`leerPlantilla` missing).
- [ ] **Step 3:** Split the file into parts, add `orden.json`, implement `leerPlantilla`, switch `construirHtml` to it.
- [ ] **Step 4:** Run the test → PASS; full suite + `node test/humo.mjs` → PASS.
- [ ] **Step 5:** Commit `seki-review: dashboard template split into parts (no behaviour change)`. After this commit, update the test so it no longer pins the hash (later tasks change the parts) but asserts every name in `orden.json` exists and the assembled page starts with `<!doctype html>` and ends with `</html>\n`; commit with the next task.

### Task 3: Lock and atomic writes for shared data

**Files:**
- Create: `mcp/lib/bloqueo.mjs`
- Modify: `mcp/lib/cache.mjs` (`escribirJson`)
- Test: `test/bloqueo.test.mjs`

**Interfaces:**
- Produces:
  - `conBloqueo<T>(ruta: string, fn: () => T | Promise<T>, { esperaMs = 5000 } = {}): Promise<T>` — lock file `${ruta}.lock` created with `open(…, 'wx')` containing `{ pid, ts }`; retries every 50 ms until `esperaMs`, then throws `Error('Lock busy: <basename>')`; takes over a lock only when `ts` is older than 30 s **and** `process.kill(pid, 0)` throws `ESRCH`; always removes its own lock in `finally`.
  - `escribirAtomico(ruta: string, texto: string): void` — writes `${ruta}.<pid>.tmp` then `renameSync`.
  - `escribirJson(ruta, datos): Promise<void>` now `conBloqueo(ruta, () => escribirAtomico(ruta, json))`; callers that ignored the return keep working; update callers inside `recolectar` to `await`.
  - `anexarLinea(ruta: string, linea: string): Promise<void>` — `conBloqueo` + `appendFileSync`.

- [ ] **Step 1:** Tests: two concurrent `conBloqueo` on the same path run sequentially (record start/end order); a stale lock of a dead pid (`pid: 999999`, `ts` 60 s ago) is taken over; a lock of the live test pid younger than 30 s is not (throws after `esperaMs: 200`); `escribirAtomico` leaves no `.tmp` behind; two concurrent `escribirJson` produce valid JSON equal to one of the inputs.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `bloqueo.mjs`, change `cache.mjs`.
- [ ] **Step 4:** Run → PASS; full suite → PASS (fix any caller that relied on synchronous write).
- [ ] **Step 5:** Commit `seki-review: locked atomic writes for shared data files`.

### Task 4: Safe patterns from config

**Files:**
- Create: `mcp/lib/patrones.mjs`
- Modify: `mcp/lib/reglas.mjs` (`reglasDeConfig` uses `compilarPatron`)
- Test: `test/patrones.test.mjs`

**Interfaces:**
- Produces:
  - `compilarPatron(fuente: string, banderas = ''): RegExp` — throws `Error('Invalid pattern: <reason>')` when `fuente.length > 300`, when it contains a quantified group that itself contains a quantifier (`/\((?:[^()\\]|\\.)*[+*}]\)[+*{]/`), or when `new RegExp` fails.
  - `coincidencias(re: RegExp, texto: string, { maxLargo = 4096, maxCoincidencias = 50 } = {}): string[]` — runs a global copy of `re` over `texto.slice(0, maxLargo)`, unique matches in order, at most `maxCoincidencias`.
- [ ] **Step 1:** Tests: `compilarPatron('(a+)+$')` and `'(.*)*'` throw; `'\\b[A-Z]-\\d+\\b'` compiles; 301-char pattern throws; `coincidencias` on a 2 MB string finishes in < 200 ms and only scans 4096 chars; duplicates collapse; a `reglas` entry with `(a+)+` makes `reglasDeConfig` throw `Invalid pattern`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS, full suite → PASS.
- [ ] **Step 5:** Commit `seki-review: guarded compilation for patterns from config`.

### Task 5: Collection — recent merged/closed PRs and merging partial refresh

**Files:**
- Modify: `mcp/lib/recolectar.mjs` (`prsDeBase`, end of `recolectar`)
- Modify: `mcp/lib/config.mjs` (defaults for `entregas` and `vigia`)
- Test: `test/recolectar.test.mjs`

**Interfaces:**
- Consumes: `falsoGhRutas` (Task 1), `escribirJson` (Task 3).
- Produces:
  - `prsDeBase` entries gain `cerrada: closed_at`; pagination continues past 3 pages while the oldest entry of the last page was created within `entregas.ventanaDias` (hard cap 10 pages).
  - Snapshot field `recientes: PrReciente[]` — own PRs (author filter as today) on every configured testing **and** production base whose `mergeada` or `cerrada` is within `ventanaDias`, not already in `prs`. `PrReciente = { id, repo, repoEtiqueta, numero, titulo, url, base, rama, portal, ambiente, estadoPr: 'MERGED' | 'CLOSED', mergeada: string | null, cerrada: string | null, descripcion: string /* first 4096 chars */ }`.
  - `recolectar({ repos })` with a subset: reads the previous `prs.json`, replaces only `prs`/`recientes` entries whose `repo` is in `repos`, keeps the rest, and still runs `compararFotos(anterior, nueva)`.
  - `proyecto(clave).entregas` and `.vigia` always present with the Global Constraints defaults merged under user values.
- [ ] **Step 1:** Tests with routes for `api user`, `pr list … --state open`, `api repos/o/r/pulls?base=…&page=1`, `pulls/N/files`, `pulls/N/commits` (minimal JSON): (a) a merged PR on the prod base appears in `recientes` with `ambiente: 'prod'`; (b) a merged PR older than `ventanaDias` does not; (c) partial refresh of repo `b` keeps repo `a` entries from the previous snapshot and `cambios` is computed (not null when something changed); (d) `limpiarCopias`-style filter `estadoPr === 'OPEN'` over the new snapshot excludes `recientes`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; full suite + smoke → PASS.
- [ ] **Step 5:** Commit `seki-review: recent merged and closed PRs; partial refresh keeps other repos`.

### Task 6: Delivery grouping

**Files:**
- Create: `mcp/lib/entregas.mjs`
- Test: `test/entregas.test.mjs`

**Interfaces:**
- Consumes: `compilarPatron`, `coincidencias` (Task 4); `parecido` (gemelas).
- Produces:
  - `claveRama(rama: string, sufijos: string[]): string` — lowercase; drop `^[a-z]+/` type prefix; strip any suffix of `sufijos` repeatedly from the end; returns `''` when result has < 3 chars or equals a base branch name passed in `sufijos` context (see Review Focus 1: pass `{ bases: string[] }` as third arg).
  - `idsDe(pr, re: RegExp | null): string[]` — matches over `titulo`, `rama`, `descripcion` via `coincidencias`, uppercased.
  - `relacionadasDe(descripcion: string): string[]` — `repo#n` ids from lines `^(Relacionada|Related):\s*[\w.-]+/([\w.-]+)#(\d+)` in the first 4096 chars.
  - `agrupar(prs: Array<PrSnapshot | PrReciente>, cfg: { sufijosRama, patronId, bases }, ajustes: { unir: string[][], separar: string[], titulo: Record<string,string> }): Entrega[]`.
  - `Entrega = { clave: string, titulo: string, ids: string[], prs: string[] /* pr ids */, señales: Array<'rama' | 'id' | 'relacionada' | 'titulo' | 'manual'> }`. `clave` = sorted first branch key, else first ID, else first pr id — stable across runs for the same members.
  - Algorithm: union-find over pr ids; join by equal non-empty `claveRama`, shared ID, `relacionadasDe` reference; then title similarity ≥ 0.6 only for PRs still alone and only with a PR of the same repo on the opposite environment of the same line; then `ajustes.unir` (join), `ajustes.separar` (pr id leaves its group into a singleton).
- [ ] **Step 1:** Tests: back `fix/qa-x-y` + front `fix/qa-x-y-pruebas` → one delivery with `señales` containing `rama`; `feat/c-admin-pruebas` (front) + `feat/c-pruebas` (back) with `sufijosRama: ['-pruebas','-admin']` → one; two PRs sharing `QA-7` in titles with `patronId: '\\bQA-\\d+\\b'` → one; `Related: o/front#5` joins; `rama: 'develop'` with `bases: ['develop']` does not join anything; `separar` moves a PR out; `clave` identical when input order is shuffled.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `seki-review: delivery grouping by branch key, finding ids and references`.

### Task 7: Stages, alerts and events

**Files:**
- Create: `mcp/lib/etapas.mjs`, `mcp/lib/eventos.mjs`
- Modify: `mcp/lib/cache.mjs` (paths `rutaEventos`, `rutaEntregas`, `rutaAjustes`, `rutaVisita`)
- Modify: `mcp/lib/recolectar.mjs` (after the snapshot: derive and append events, write `entregas.json`)
- Test: `test/etapas.test.mjs`, `test/eventos.test.mjs`

**Interfaces:**
- Consumes: `agrupar` (Task 6), `anexarLinea`/`escribirJson` (Task 3).
- Produces:
  - `pistasDe(entrega, prsPorId, cfgRepos): Pista[]` — `Pista = { portal: string, prs: string[] }`; repos with more than one configured line define the portals; PRs of single-line repos are shared and included in every track; with no multi-line repo, one track `portal: 'main'`.
  - `etapaDePista(pista, prsPorId, qa: QaEstado | null, ahora: Date, cfg): Etapa` with `Etapa` one of `'descartada' | 'cerrada' | 'en_produccion' | 'qa_fallo' | 'listo_produccion' | 'esperando_qa' | 'por_mergear_pruebas'`, evaluated in the spec §6.2 order; a QA result older than the newest testing merge of the track is ignored; Phase 1 always passes `qa = null` except tests.
  - `alertasDePista(...)`: `Array<{ tipo: 'gemela_faltante' | 'orden' | 'estancada' | 'sin_pruebas' | 'qa_fallo', prs: string[], detalle: string }>`; `orden` uses `cfgRepos[repo].orden` (number, default 1 for single-line repos, 2 otherwise).
  - `etapaDeEntrega(pistas): Etapa` = least advanced by the order above reversed (`por_mergear_pruebas` lowest).
  - `eventosDe(foto, entregas): Evento[]` (pure) — `pr_mergeada` for every PR with `mergeada`, `pr_cerrada` for `CLOSED` with `cerrada`; `id = sha256(tipo|pr|fecha)`; `ts = fecha`.
  - `registrarEventos(p, eventos): Promise<number>` — reads ids already in `eventos.jsonl`, appends only new ones under one lock, returns count.
  - `leerEventos(p, { desde?: string }): Evento[]`.
  - `entregas.json` = `{ generado, entregas: Array<Entrega & { pistas: Array<Pista & { etapa, alertas }>, etapa, ultimoEvento: Evento | null }> }`.
- [ ] **Step 1:** Tests, one per row of the §6.2 table (6 rows + no-testing case + stale QA result ignored); `orden` alert when front merged in testing before back; `gemela_faltante` when a line has only a testing PR; two tracks (bac-admin, Multipagas) + shared back: one track in production and the other open → delivery stage = the other track's stage; `eventosDe` twice on the same snapshot → `registrarEventos` returns N then 0; concurrent `registrarEventos` from two promises → no duplicate ids in the file.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement and wire into `recolectar` (after writing `prs.json`; failures here are logged with tag `[seki-review/entregas]` and never fail the refresh). **Step 4:** Run → PASS; full suite + smoke → PASS.
- [ ] **Step 5:** Commit `seki-review: delivery stages, alerts and event history`.

### Task 8: Deliveries board, last-visit banner and MCP tool

**Files:**
- Create: `mcp/tablero/partes/<n>-entregas.js`, `mcp/tablero/partes/<n>-entregas.css` (registered in `orden.json`)
- Modify: `mcp/lib/tablero.mjs` (embed `entregas.json` and events since last visit as `/*ENTREGAS*/null`)
- Modify: `mcp/lib/servidor-web.mjs` (endpoints)
- Create: `mcp/tools/entregas.mjs`
- Test: `test/entregas-api.test.mjs`

**Interfaces:**
- Consumes: Task 7 files.
- Produces:
  - `GET /api/entregas` → `entregas.json` + `{ desdeVisita: Evento[] }`.
  - `POST /api/entregas/ajuste` body `{ tipo: 'unir', prs: string[] } | { tipo: 'separar', pr: string } | { tipo: 'titulo', clave: string, titulo: string /* ≤ 200 chars */ }` → validates ids exist in the snapshot, writes `entregas-ajustes.json`, appends `entrega_ajustada`, regroups without calling GitHub, returns the new `entregas.json`.
  - `POST /api/entregas/cerrar` `{ clave }` → event `entrega_cerrada`.
  - `POST /api/visita` → stores now in `visita.json`; the page calls it when the banner is dismissed.
  - Tool `entregas { proyecto?, desde?: 'ultima-visita' }` → text summary by stage with next action per delivery and the events since the last visit.
  - UI: default tab **Deliveries** (columns in stage order, cards: title, IDs, track chips with stage, PR matrix repo × environment with state and link, alert badges, last event, actions Join/Split/Close); tab **PRs** = current view. DOM built with `textContent`/`createElement`, no `innerHTML` with data, no inline handlers. Copy in formal, impersonal English.
- [ ] **Step 1:** API tests against the served server (existing pattern in `acceso.test.mjs`/`ceder.test.mjs`): token required (401 without), unknown PR id in `unir` → 400, `titulo` over 200 chars → 400, valid `separar` returns a delivery set with one more element, `cerrar` makes the delivery `cerrada`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement endpoints, tool and view. **Step 4:** Run → PASS; full suite + smoke → PASS; open the served dashboard against the real REVAL config and check by eye that QA fixes merged on 2026-11-03 appear grouped (back + front + both environments) — record the result in the PR description.
- [ ] **Step 5:** Commit `seki-review: deliveries board, last-visit banner and entregas tool`.

### Task 9: Merge watcher

**Files:**
- Create: `mcp/lib/vigia.mjs`
- Modify: `mcp/lib/servidor-web.mjs` (start on serve, include in busy check of `/api/ceder`, stop on `ceder`/close; header marker)
- Modify: the dashboard part that polls `/api/estado` (send header `X-Seki-Tablero: 1`)
- Test: `test/vigia.test.mjs`

**Interfaces:**
- Produces: `crearVigia({ intervaloMs, sondear: () => Promise<string[] /* repos changed */>, refrescar: (repos: string[]) => Promise<void>, tableroAbierto: () => boolean, reloj = { ahora: Date.now, programar: setTimeout, cancelar: clearTimeout } }) => { iniciar(), detener(), ocupado: () => boolean, estado: () => { ultimo: string | null, error: string | null, siguienteMs: number } }`.
  - Single-flight; skips a cycle when `tableroAbierto()` is false; on error doubles the delay up to 30 min, resets on success; `detener` cancels the pending timer and makes later callbacks no-ops.
  - `sondear` in the server: per repo `gh pr list -R owner/repo --state all --search "updated:>=<ISO of last successful probe>" --json number,updatedAt --limit 50`; non-empty → repo changed. `refrescar` = partial `recolectar({ repos })` through the existing `refrescar` single-flight.
  - `tableroAbierto()` = a request with `X-Seki-Tablero: 1` hit `/api/estado` in the last 10 min.
  - `/api/estado` adds `vigia: estado()`; header shows "Checked N min ago".
- [ ] **Step 1:** Tests with a fake clock: no `refrescar` while the board is closed; changed repos passed through; error → next delay doubled, capped at 30 min; `detener` during an in-flight cycle → no further scheduling; `ocupado()` true during a cycle; server test: `/api/ceder` returns 409 while the watcher is busy.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement and wire. **Step 4:** Run → PASS; full suite + smoke → PASS.
- [ ] **Step 5:** Commit `seki-review: merge watcher while the dashboard is open`.

### Task 10: Release 0.21.0

**Files:**
- Modify: `.claude-plugin/plugin.json`, `mcp/server.mjs` (version `0.21.0`), `bin/servidor.sh` (Node ≥ 22), `../../CHANGELOG.md`, `skills/review-prs/SKILL.md` (arguments `deliveries`, `since-last`; consult the event history before GitHub), `config/proyectos.ejemplo.json` (`entregas`, `vigia`, `orden` examples, generic), `PRODUCT.md` (capabilities)
- [ ] **Step 1:** Run `node --test 'test/*.test.mjs'` and `node test/humo.mjs` → all PASS.
- [ ] **Step 2:** Commit `seki-review 0.21.0: deliveries board, event history and merge watcher`; push branch, open PR to `main` with the by-eye check result; do not merge or tag (the owner does).
