# Phase 3 — AI modes, Ultra review and daily budget (0.23.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every AI job runs under a mode (`ahorro | normal | ultra`) drawn from one profiles table, no job starts when it would exceed the machine's daily budget, and the owner can launch a confirmed, cost-estimated Ultra review of a PR (three lenses + verification + project checks).

**Architecture:** A pure profiles table (`perfiles.mjs`) replaces `TOPES`/`TURNOS`/`elegirModelo`'s scattered rules; a pure budget gate (`presupuesto.mjs`) with an in-memory reservation sits in front of the queue and of the one direct call site (`filtrar`). Ultra (`ultra.mjs`) is one queue job that reuses the read-only copy, `otrasRamas`, `ejecutarClaude` and `comprobar`. Surfaces last: endpoints, board, MCP tool, skill.

**Tech Stack:** Node ≥ 22 standard library only, `node --test`.

**Spec:** `plugins/seki-review/docs/specs/2026-11-04-deliveries-qa-ai-modes-design.md` — sections 6.10, 6.11 (Ultra only; the other tools shipped in 0.21/0.22), 7, 8, 9 ("Daily spend enforced", "Failed AI jobs log a reason"), 12 ("AI modes and budget"). §12 supersedes earlier sections.

All paths below are relative to `plugins/seki-review/`.

## Global Constraints

- No npm dependencies, no build step; Node ≥ 22.
- No project data in the repository; fixtures and examples use generic names.
- UI and tool text: formal, impersonal English. Identifiers follow the existing Spanish naming.
- No shell strings: `spawn`/`execFile` with argument arrays.
- Every new endpoint behind the existing token and Host check; JSON bodies capped at 16 KB.
- The AI never gets write tools in Ultra (Read/Grep/Glob only) and never reads secrets (`reglasSecretos` over every directory it is given).
- Logs carry a tag (`[seki-review/ia]`, `[seki-review/ultra]`, `[seki-review/presupuesto]`) and a safe message; never prompts, code or secrets.
- `TOPES` and `TURNOS` stay exported, equal to the *normal* row (existing tests keep passing).
- Tests: `node --test 'test/*.test.mjs'` and `node test/humo.mjs`, with `/Users/dev/.proto/tools/node/24.15.0/bin/node`. Existing tests stay green. Use `--test-concurrency=2` when running the full suite.
- Commits: conventional prefix, no AI attribution of any kind, no `Co-Authored-By`, no session trailers. Never `git stash`.

## Rulings made while planning (spec silent or ambiguous)

1. **What `ultra` means for regular jobs.** The `ultra` row for `responder`, `explicar`, `cambiar`, `investigar`, `filtrar` equals the `normal` row. Ultra's own behaviour is the `revisar_ultra` job, which is always an explicit, confirmed action on one PR; a project default of `ultra` never launches it automatically (owner always confirms, §6.10). The board then only pre-selects "Ultra" in the mode selector.
2. **Profile shape.** `PERFILES[modo][tipo] = { modelo, topeUsd, turnos, segundaPasada }`. `modelo: null` means "the existing difficulty rule" (`elegirModelo` today). Types: `responder, explicar, cambiar, investigar, filtrar, ultra_lente, ultra_verificar`. *ahorro*: `responder` and `filtrar` → `haiku`; every other type → `sonnet` (never opus); `segundaPasada: false` for `explicar`; caps and turns equal to *normal*. *normal*: `modelo: null` everywhere except `filtrar: 'sonnet'` (today's behaviour), `segundaPasada: true` for `explicar`. `ultra_lente`: `sonnet`, $1.50, 25 turns; `ultra_verificar`: `sonnet`, $1, 30 turns (same in every mode, only reachable from `revisar_ultra`). `cambiar` never runs on haiku whatever the source (existing rule kept).
3. **Precedence** (§12): `SEKI_IA_MODELO_<TIPO>` > `SEKI_IA_MODELO` > job override `modo` > project `ia.modo` > `normal`, for the model; `SEKI_IA_TOPE_<TIPO>` overrides the cap the same way. Implemented once in `perfil({ tipo, modo, pr, lineasSeleccionadas })` returning `{ modelo, topeUsd, turnos, segundaPasada, modo }`; every call site uses it.
4. **Budget scope.** Spend = sum of today's records (local time zone of the machine, `fecha` converted with `new Date(fecha)` and compared by local `YYYY-MM-DD`) across the `costos.jsonl` of **every** project in `proyectos.json`, failed jobs included, `valoracion` excluded. The limit is `ia.presupuestoDiarioUsd` of the project being served (`null` = no limit). Spend is re-read from disk at most every 30 s plus the in-process reservation.
5. **Job caps for the gate.** Each queued job declares `topeUsd` = sum of the caps of the calls it may make: `explicar` = cap × (1 + segundaPasada), `cambiar` = cap × 2 (retry), `responder` = cap × number of questions, `investigar` = cap, `revisar_ultra` = 3 × lens cap + verification cap. The reservation is released with the real cost when the job ends.
6. **Blocked by budget.** A job that does not fit stays in the queue with `estado: 'bloqueado_presupuesto'` and the message "Blocked by the daily budget ($X of $Y spent)". `POST /api/trabajos/forzar { id }` marks that one job `forzado` and re-queues it; it is not remembered for later jobs. `filtrar` (synchronous) answers 429 with the same message and a `forzar: true` body flag to retry once.
7. **Saving reuse.** In *ahorro*, `/api/analizar` does not enqueue a PR whose explanation already exists for the same `headSha` (unless `completar`), and `revisar_ultra` is not offered. Answers already reuse their cache in every mode.
8. **Ultra result cache.** Stored at `salida/ultra/<repo>-<n>.json` with `headSha`; a request for the same `headSha` returns the stored result without spending unless `repetir: true`. A newer `headSha` marks the stored result `desactualizada` on read.
9. **Verification.** Before the verification call, code drops findings whose cited file does not exist in the copy or whose line is beyond the file's length (`descartadas` with reason). One verification call receives the remaining findings and returns a verdict per finding id (`CONFIRMED | PLAUSIBLE | REJECTED`, plus a one-line reason); only the first two are kept. A failed verification keeps nothing and reports the error (no unverified findings shown).
10. **Checks in Ultra.** `comprobar(p, repo, dir, patch, headSha)` on the read-only copy with the PR patch; `patch` is the joined `patch` of the cached diff. Repos without `comprobar` config report rules only.
11. **Chat side.** No MCP tool spends AI. New read-only tool `pr_ultra { repo, numero }` returns the estimate, whether Ultra is suggested and the stored result (if any). The skill's `ultra <repo>#<n>` shows them and gives the dashboard link `#/pr/<repo>/<n>?ultra=1`, which opens the confirmation on the board.
12. **Sensitive paths.** `ia.rutasSensibles`: list of regex strings, each ≤ 200 chars, compiled at config load; an invalid one is dropped with a warning. A PR is *suggested for Ultra* when any changed file path matches, or when `pr.seguridad` is already true.

## Configuration (`ia` section of a project in `proyectos.json`)

```json
"ia": { "modo": "normal", "presupuestoDiarioUsd": null, "rutasSensibles": [] }
```

`modo` outside the three values → `normal` with a warning; `presupuestoDiarioUsd` must be a positive number or `null`.

## Review Focus

1. **Two jobs reach the gate at once with room for only one** → the second is blocked; when the first finishes with a lower real cost, the second starts by itself. Test in Task 2 (fake clock, fake spend).
2. **The day changes at local midnight while the server runs** → yesterday's spend no longer counts. Test in Task 2 with a fixed TZ offset.
3. **An Ultra lens fails or times out** → the others still produce findings, the failure is listed in the result, the cost record still sums every call. Test in Task 4.
4. **A lens cites a file/line that does not exist or the verifier rejects it** → it never reaches the board. Test in Task 4.
5. **Environment variables set** (`SEKI_IA_MODELO=opus`) **with a job in *ahorro*** → the variable wins, as today. Test in Task 1.

---

### Task 1: Profiles table, precedence and `ia` config (`mcp/lib/perfiles.mjs`, `ia.mjs`, `config.mjs`, call sites)

**Files:**
- Create: `mcp/lib/perfiles.mjs`, `test/perfiles.test.mjs`
- Modify: `mcp/lib/ia.mjs`, `mcp/lib/config.mjs`, `mcp/lib/explicar.mjs`, `mcp/lib/preguntas.mjs`, `mcp/lib/propuestas.mjs`, `mcp/lib/filtrar.mjs`, `config/proyectos.ejemplo.json`, `test/ia.test.mjs`, `test/config.test.mjs`

**Interfaces:**
- Produces: `MODOS = ['ahorro','normal','ultra']`, `PERFILES`, `perfil({ tipo, modo, pr, lineasSeleccionadas }) => { modo, modelo, topeUsd, turnos, segundaPasada }` (Ruling 2, 3). `modoDe(p, override) => modo` (override if valid, else `p.ia.modo`, else `normal`).
- `ia.mjs`: `TOPES`/`TURNOS` derived from `PERFILES.normal`; `elegirModelo` kept (used by `perfil` as the `modelo: null` rule); `tope(tipo)` kept for compatibility.
- `registrarCosto` records gain `modo`; when `ok === false` they carry `motivo` (first 200 chars of the safe reason already returned by `ejecutarClaude`, never prompt text). `costosDelDia(p, dia)` uses the local day (Ruling 4).
- Each call site takes `{ modo }` in its options and reads model/cap/turns from `perfil`; `explicarConIa` skips the second pass when `segundaPasada` is false.
- `config.mjs`: `IA_DEFECTO = { modo: 'normal', presupuestoDiarioUsd: null, rutasSensibles: [] }`, validated as in "Configuration"; `proyecto()` returns `ia` with `rutasSensibles` compiled to `RegExp[]` in `ia.patronesSensibles`.

- [ ] **Step 1: Write the failing tests** — one per profile cell that differs from normal; precedence chain (env > override > project > default); `cambiar` never haiku; `TOPES`/`TURNOS` unchanged; `segundaPasada` false in ahorro skips the second `explicar` pass (fake `ejecutarClaude` via the existing test doubles); cost record has `modo` and `motivo` on failure; local-day boundary (`TZ=America/Bogota`, a record at 03:00Z belongs to the previous local day); config validation cases.
- [ ] **Step 2: Run** the new/changed test files — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them and the full suite — expect PASS.
- [ ] **Step 5: Commit** `feat(seki-review): add AI mode profiles and ia config`

### Task 2: Daily budget gate (`mcp/lib/presupuesto.mjs`, `trabajos.mjs`, `filtrar.mjs`)

**Files:**
- Create: `mcp/lib/presupuesto.mjs`, `test/presupuesto.test.mjs`
- Modify: `mcp/lib/trabajos.mjs`, `mcp/lib/ia.mjs` (machine-wide spend), `mcp/lib/filtrar.mjs`, `test/trabajos.test.mjs`, `test/filtrar.test.mjs`

**Interfaces:**
- Produces: `gastoMaquina({ proyectos, dia, ahora }) => number` (Ruling 4; unreadable lines skipped).
- Produces: `crearPresupuesto({ limite: () => number|null, gasto: () => number, ahora = Date.now }) => { cabe(topeUsd) => boolean, reservar(topeUsd) => { liberar(costoReal) }, estado() => { limite, gastado, reservado } }`. `gasto` is cached 30 s; `liberar` adds the real cost to the cached spend until the next disk read.
- `crearCola({ alTerminar, presupuesto })`: items accept `topeUsd` and `forzado`; a job that does not fit becomes `bloqueado_presupuesto` (skipped by `siguiente`, not failed); `forzar(id)` re-queues it once with `forzado: true`; every finished job releases its reservation; `siguiente()` re-checks blocked jobs after each release. `vaciar()` also cancels blocked jobs.
- `filtrarPrs(p, prs, consulta, { modo, presupuesto, forzar })`: throws an error with `codigo: 429` and the budget message when it does not fit and `forzar` is not set; cached results never touch the gate.

- [ ] **Step 1: Write the failing tests** — Review Focus 1 and 2; forced job runs once, the next one is blocked again; failed jobs count; no limit → never blocks; `vaciar` cancels blocked jobs; filtrar 429 and `forzar`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the files and the full suite — expect PASS.
- [ ] **Step 5: Commit** `feat(seki-review): enforce the daily AI budget`

### Task 3: Cost estimate, sensitive paths and cost summary by mode (`mcp/lib/perfiles.mjs`, `ia.mjs`)

**Files:**
- Modify: `mcp/lib/perfiles.mjs`, `mcp/lib/ia.mjs`, `test/perfiles.test.mjs`, `test/ia.test.mjs`

**Interfaces:**
- Produces: `estimarCosto(registros, { tipo, modo, multiplicador = 1, topeUsd }) => { usd, base: 'historial'|'topes', muestras }` — median of `costo` of records with the same `tipo` and `modo` over the last 30 days (at least 3 records, else `topeUsd`), times `multiplicador`. For Ultra: one estimate over `revisar_ultra` records, falling back to the job cap (Ruling 5).
- Produces: `sugerirUltra(p, pr, archivos) => { sugerida: boolean, motivos: string[] }` (Ruling 12; reasons name the matched pattern, not the file).
- `resumenCostos` adds `modos: { <modo>: { trabajos, fallidos, costo, utiles, noUtiles, costoPorUtil } }` (records without `modo` count as `normal`); `valoracion` records carry the `modo` of the rated answer when known.

- [ ] **Step 1–5** as above. Commit `feat(seki-review): estimate AI cost per mode and flag sensitive PRs`

### Task 4: Ultra review job (`mcp/lib/ultra.mjs`, `mcp/prompts/ultra-*.md`)

**Files:**
- Create: `mcp/lib/ultra.mjs`, `mcp/prompts/ultra-correccion.md`, `mcp/prompts/ultra-seguridad.md`, `mcp/prompts/ultra-lineamientos.md`, `mcp/prompts/ultra-verificar.md`, `test/ultra.test.mjs`
- Modify: `mcp/lib/preguntas.mjs` (export `otrasRamas`), `mcp/lib/propuestas.mjs` (export `lineamientos`), `mcp/lib/cache.mjs` (`rutaUltra`)

**Interfaces:**
- Produces: `revisarUltra(p, pr, { repetir = false, paralelo, ejecutar = ejecutarClaude, comprobarFn = comprobar }) => { ok, motivo, costo, modelo, resultado }`. Steps: cache (Ruling 8) → read-only copy (`crearCopia … '-lectura'`) + `otrasRamas` → three lenses with concurrency `paralelo` (the queue's `PARALELO`), each `claude -p` with Read/Grep/Glob, schema `{ hallazgos: [{ archivo, linea, severidad: 'alta'|'media'|'baja', titulo, detalle }] }`, `dirs` = other repos + guidelines dir for the guidelines lens → structural drop (Ruling 9) → one verification call → `comprobarFn` (Ruling 10) → store `{ headSha, fecha, lentes: [{ nombre, ok, motivo, costo, hallazgos }], hallazgos: [{ id, lente, archivo, linea, severidad, titulo, detalle, veredicto, razon }], descartadas, comprobacion }`.
- Security lens prompt: OWASP Top 10 and payment-sensitive data handling (card data, credentials, personal data in logs, amounts and idempotency). Guidelines lens: the text of `lineamientos(p)`; when unavailable the lens is skipped and reported, not failed.
- One `registrarCosto` record `{ tipo: 'revisar_ultra', modo: 'ultra', prId, costo: sum, ok, motivo?, detalle: [{ paso, modelo, costo, ok }] }`.
- Lens ids are stable (`<lente>-<n>`); finding text is capped (titulo 200, detalle 2 000 chars); at most 30 findings per lens.

- [ ] **Step 1: Write the failing tests** with a fake `ejecutar` and a temp copy directory — Review Focus 3 and 4; cache hit spends nothing; `repetir` spends; newer headSha → `desactualizada`; guidelines missing → lens skipped; cost record sums lenses + verification; verification failure keeps no findings.
- [ ] **Step 2–4** as above.
- [ ] **Step 5: Commit** `feat(seki-review): add the Ultra review job`

### Task 5: Endpoints and board (`servidor-web.mjs`, `tablero/partes/`)

**Files:**
- Modify: `mcp/lib/servidor-web.mjs`, `mcp/tablero/partes/*` (new `08c-modos.js` + `02c-modos.css` registered in `orden.json` if cleaner), `test/plantilla.test.mjs`, `test/trabajos.test.mjs` or a new `test/ultra-api.test.mjs`

**Interfaces:**
- Every AI endpoint (`/api/analizar`, comment/answer/change/investigate submissions, `/api/filtrar`) accepts optional `modo` (validated with `modoDe`) and passes it and `topeUsd` (Ruling 5) to the queue.
- `GET /api/ultra?repo&numero` → `{ estimacion, sugerida, motivos, resultado }`; `POST /api/ultra { repo, numero, repetir? }` → 202 with the job id (refused with 409 in *ahorro* override or when the PR is unknown).
- `POST /api/trabajos/forzar { id }` → 200/404.
- `/api/estado` adds `presupuesto: { limite, gastado, reservado }` and `modo` (project default).
- Board: mode selector in the action bar (default = project `ia.modo`, kept in `sessionStorage`); "Ultra review" button in the PR detail with a confirmation dialog showing the estimate and its base ("from N earlier reviews" / "from the cost caps"); "Ultra suggested" badge on cards; Ultra results section (findings grouped by severity with verdict, discarded count, lens failures, checks); jobs list shows "Blocked by budget" with a "Run anyway" button; spend line shows "$X of $Y today"; cost panel adds the per-mode table. The `#/pr/<repo>/<n>?ultra=1` link opens the confirmation (never launches by itself).

- [ ] **Step 1: Write the failing tests** — endpoint validation and 409 cases with the existing server test helpers; template compiles with the new parts; budget fields in `/api/estado`.
- [ ] **Step 2–4** as above; then open the board locally against the `gh` double (`node test/humo.mjs`) and check the selector, the confirm and the blocked state.
- [ ] **Step 5: Commit** `feat(seki-review): choose AI mode and run Ultra from the dashboard`

### Task 6: MCP tool, skill, smoke test and release 0.23.0

**Files:**
- Create: `mcp/tools/pr_ultra.mjs`
- Modify: `mcp/server.mjs` (register tool, version 0.23.0), `.claude-plugin/plugin.json` (0.23.0), `skills/review-prs/SKILL.md`, `test/humo.mjs`, `CHANGELOG.md` (repo root), `PRODUCT.md`/`DESIGN.md` only where they describe AI modes or costs

**Interfaces:**
- `pr_ultra { repo, numero }` → read-only (Ruling 11).
- Skill: argument `ultra <repo>#<n>` (Spanish `ultra` as well) in the description and workflow; the chat consults `entregas`/stored results before asking GitHub and does not repeat analysis for an unchanged `headSha`; mentions the modes and the budget in one short paragraph.
- Smoke test: board built with `ia.modo` and a budget; `/api/estado` exposes `presupuesto`; an Ultra request with a fake runner produces a stored result.

- [ ] **Step 1–4** tests first, then implementation, full suite + smoke.
- [ ] **Step 5: Commit** `feat(seki-review): release 0.23.0 with AI modes and Ultra review`
