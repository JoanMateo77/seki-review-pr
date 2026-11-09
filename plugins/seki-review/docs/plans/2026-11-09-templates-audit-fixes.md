# Review templates: audit fixes (0.25.0, before release) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the audit of the template review: fewer false blockers from the cross-repo route rule, cheaper AI runs (shared cached prefix, reuse per template), no duplicated security review with Ultra, a Templates tab / dialog / Copy review without the found defects, and entrance and state-change motion.

**Architecture:** Same pieces as 0.25.0. Server libraries in `mcp/lib/`, board parts in `mcp/tablero/partes/` (plain JS/CSS concatenated by `orden.json`), tests in `test/` with `node --test` (board functions evaluated in `node:vm`). The version stays 0.25.0 (not released yet); the `0.25.0` entry of the root `CHANGELOG.md` is extended.

**Tech Stack:** Node ≥ 22 standard library, `git`, `node --test`. No npm dependencies, no build step.

**Spec:** `docs/specs/2026-11-09-plantillas-auditoria.md` (piece ids A1…D6 below refer to it).

All paths are relative to `plugins/seki-review/`.

## Global Constraints

- No npm dependencies, no build step. No writes to GitHub.
- No project data in the repository: fixtures use generic owners, repos and routes (`/v2/orders`, `acme/api`).
- UI and tool text: formal, impersonal English. Identifiers follow the existing Spanish naming. Comments say why.
- All dynamic text in the board goes through `esc()` or `textContent`.
- Motion: only `transform` and `opacity` (plus `grid-template-rows` for the fold), 120–250 ms, ease-out curves; every new animated class is added to the `prefers-reduced-motion: reduce` rule of `02-estilos.css` (opacity-only fade ≤ 80 ms or none).
- Tests: `/Users/dev/.proto/tools/node/24.15.0/bin/node --test --test-concurrency=2 'test/*.test.mjs'` and `/Users/dev/.proto/tools/node/24.15.0/bin/node test/humo.mjs` (from `plugins/seki-review`). Existing tests stay green; output without warnings. No unit test reaches real gh/git/claude.
- Commits: `seki-review: <what changes>` in English, facts only (what and why). No AI attribution, no trailers, no process notes. Never `git stash`. No push, no tag.

## Rulings

1. **Segment boundary (B1).** A grep hit counts as a use of route `R` only when some occurrence of `R` in the hit text is not followed by `[\w-]` nor by `/` + one of `[\w$:{]`. `/v2/orders` does not match `/v2/ordersBulk` nor `/v2/orders/${id}`; it matches `/v2/orders'`, `/v2/orders?x=1`, `/v2/orders/` + quote.
2. **Hits in tests and docs (B1).** A hit whose file matches `(^|/)(__tests__|__mocks__|tests?|mocks?|e2e|docs?)/`, `\.(spec|test)\.[cm]?[jt]sx?$` or `\.(md|mdx|txt)$` carries `soloPruebas: true`. Real hits are taken before these when capping at 3 per repo. An item whose findings are all `soloPruebas` fails but never blocks, and its comment says "only in tests or docs".
3. **`.route()` (B1).** `<receiver>.route('<literal>')` declares the route, whatever verb is chained.
4. **Deterministic comment (B2).** The subject stays the first finding's `mensaje`; `detalle` lists the other findings (unique `mensaje`, with `archivo:linea`) as `- ` bullets, at most 10, then `- and N more`.
5. **Trimmed note (B4).** When comments were trimmed, the markdown ends with one line: EN `N more comments were left out (at most 5 per template).`, ES `Quedaron fuera N comentarios más (máximo 5 por plantilla).`, by the language of the first template.
6. **Prompt order (A1).** Template prompt = `<contexto>` first (PR line, repositories, changed files, diff), then `Template: … Language: …`, then `Items:`. The first AI template is awaited alone; the rest run with the existing `enParalelo(limite)`.
7. **Usage (A2).** Each step of `detalle` in `costos.jsonl` gains `uso` (the `{ entrada, cacheCreada, cacheLeida, salida }` object `ejecutarClaude` already returns as `r.uso`); the record gains the summed `uso`.
8. **Reuse per template (A3).** `huella` per AI template = sha256 of `JSON.stringify([id, version, itemsIa(t), patches])`, where `patches` = `[filename, patch]` of the changed files that activate the template (all files for a `siempre` template), sorted by filename. Stored in each `plantillas[]` entry of the result. On a run without `repetir`, a template whose `huella` equals the stored one (stored entry `ok !== false`) reuses its stored AI items (state, quote, verdict) with `reutilizada: true` and cost 0; `existeCita`/`citaValida` are not re-run on them. Deterministic items are always recomputed. Verification runs only over new failing AI items. `repetir: true` reuses nothing. A run where everything is reused makes no AI call and writes no cost record.
9. **Other branches (B3).** The result stores `ramas: [{ repo, rama, sha }]` of the other repositories read. `datosPlantillas` accepts an injectable `shaRama(p, repo, rama)` (default: local ref of the existing copy, no fetch, `null` on any failure) and returns `resultado.ramasMovidas: [{ repo, rama }]` for those whose current sha differs. A result with `ramasMovidas` is not "current" for Copy review.
10. **Estimate (A4).** The estimate is the sum, over the active AI templates, of the median cost of that template id in past `detalle` steps (`ok` steps, 30-day window like `estimarCosto`), falling back to the existing per-template median, then to the cap. Scaling by diff size is not built: it needs the `uso` data that Ruling 7 starts to collect.
11. **Ultra (B5).** Templates may declare `"cubre": ["seguridad"]` (optional array, values from Ultra's lens names; validated). `owasp-web` and `pci-dss` declare it. `revisarUltra` skips a lens when the stored template result has the same `headSha` and a template with `ok !== false` that covers it: the lens is recorded as `{ omitida: true, motivo: 'Covered by the template review of this commit' }`. `datosUltra` returns `lentesCubiertas: ['seguridad']`, and the cap and estimate use the lenses that will run (`topeRevisarUltra(n = 3)`; a history-based estimate is multiplied by `n / 3`). The Ultra dialog and the Ultra result say it. `repetir` does not change this.
12. **One "current" criterion (C7).** `plantillasVigentes(pr, r)` = result exists, not `desactualizada`, `headSha` equal, no `ramasMovidas`. Used by the dialog, the tab and Copy review.
13. **Copy feedback (C1).** `marcarCopia(boton, ok, texto?)` accepts the label; Copy review shows `Copied · template comments included`, `Copied · template result is outdated, not included`, or `Copied` (no template review). The label is also written to a visually hidden `role="status"` region created once.
14. **Shared dialog (C3, C6, D1).** While `#modalIa` exists: the poll does not repaint the detail, `#app` (the board root) is `inert`, and the keyboard shortcuts of `08-script-5.js` return early. `cerrarModal` plays the exit (class `saliendo`, 120 ms; immediate under reduced motion or when called to replace the dialog), then removes it and focuses the opener, or, if the opener is disconnected, the first matching `[data-plantillas-abrir], [data-ultra-abrir]` (existing attribute names) of the current detail.
15. **Progress region (C4).** The detail is not repainted when the rendered HTML of the tab is identical except for the elapsed text: the in-progress banner keeps a stable node and only the `<span>` text with the elapsed time changes (`data-transcurrido="<inicio>"` updated by the existing poll tick). `aria-live` announces the start and the end, not each tick (`aria-live="off"` on the elapsed span).
16. **Result order (C11–C14).** Result = stale notices, summary line (`2 failing · 3 questions for the author · 12 pass`, omitting zero counts), `Comments` (the markdown), then per template: failing items (blocking first) and not-verifiable items open, passing and not-applicable items inside `<details class="plegado">` (`Passing and not applicable (n)`). The tab counter counts failing + not-verifiable-with-`pedido` items.
17. **Contrast (C15).** `--texto-3` light value becomes `#6b6f76`; the dark value is changed only if it is below 4.5:1 against the dark `--bg`, to the nearest value that reaches it.
18. **First reveal (D2).** The staggered entrance plays once per PR and `headSha` + `fecha` of the result (kept in `estado`), never on later repaints.

## Review Focus

1. A route that is a prefix of another (`/v2/orders` vs `/v2/ordersBulk`, `/v2/orders/${id}`) → no finding (Task 1).
2. The only use of a removed route is in the other repo's spec file → the item fails, the comment is non-blocking (Task 1).
3. A new commit that does not touch the files of `pci-dss` → that template makes no AI call and keeps its verdicts; `repetir` still calls (Task 2).
4. Closing the dialog after the poll repainted the detail → focus lands on the current open button, never on `body` (Task 4).
5. Copy review with an outdated template result → the label says it was not included (Task 4).

---

### Task 1: Cross-repo route rule and deterministic comments (B1, B2, B4)

**Files:** modify `mcp/lib/rutas-cruzadas.mjs`, `mcp/lib/comentarios-plantilla.mjs`, `mcp/lib/revision-plantillas.mjs` (only `itemDeterminista` if needed), `test/rutas-cruzadas.test.mjs`, `test/comentarios-plantilla.test.mjs`, `test/revision-plantillas.test.mjs`, root `CHANGELOG.md`.

**Interfaces:**
- Produces: findings of `buscarRutas` may carry `soloPruebas: true`; `comentariosDePlantillas` unchanged signature `-> { comentarios, markdown, recortados }`.

- [ ] Tests first (`rutas-cruzadas`): Ruling 1 cases (`/v2/ordersBulk`, `/v2/orders/${id}`, `/v2/orders/:id` → no finding; quote, `?`, trailing `/'` → finding); Ruling 2 (spec/doc hit flagged, real hits preferred within the cap of 3); Ruling 3 (`router.route('/v2/orders').post(h)` added → route detected; multi-line form).
- [ ] Tests first (`comentarios-plantilla`): Ruling 4 (3 findings → subject + 2 bullets; 13 findings → 10 bullets + `- and 2 more`); all findings `soloPruebas` → `bloqueante: false`, decoration `non-blocking`, detail starts with `Only in tests or docs.`; Ruling 5 in EN and ES; no note when nothing was trimmed.
- [ ] Run the two files, see them fail; implement; run the files and the full suite.
- [ ] `CHANGELOG.md` 0.25.0: one line per behaviour. Commit `seki-review: cross-repo route rule matches whole segments and reports every use`.

### Task 2: Cost of the template run (A1–A4, B3)

**Files:** modify `mcp/lib/revision-plantillas.mjs`, `mcp/lib/plantillas.mjs` (export `archivosDePlantilla(t, rutas) -> string[]`, reusing the glob logic of `seleccionarPlantillas`), `mcp/lib/servidor-web.mjs` (only if `datosPlantillas` needs the new argument wired), `mcp/tools/pr_plantillas.mjs` (same), `test/revision-plantillas.test.mjs`, `test/plantillas.test.mjs`, `test/plantillas-api.test.mjs`, `README.md` ("Review templates": cost paragraph), root `CHANGELOG.md`.

**Interfaces:**
- Consumes: `r.uso` from `ejecutarClaude`; `contextoDeDiff` (unchanged).
- Produces: result fields `ramas`, `plantillas[].huella`, items with `reutilizada: true`; `datosPlantillas(p, pr, rutas, { shaRama } = {})` returning `resultado.ramasMovidas` (array, absent when empty) and the per-template estimate; cost record with `uso` and `detalle[].uso`.

- [ ] Tests first: Ruling 6 (the prompt of every template call starts with the same context string and ends with its items; with 3 AI templates and `paralelo: 2` the first call has finished before the second starts); Ruling 7 (record and steps carry `uso`); Ruling 8 (same `huella` → no call for that template, items copied with `reutilizada`, verdicts kept, verification only over new failures; changed patch of an activating file → call; `repetir` → call; everything reused → no cost record, result rewritten with the new `headSha`); Ruling 9 (`ramas` stored; `shaRama` differing → `ramasMovidas`; `shaRama` throwing or returning null → not moved); Ruling 10 (per-id median, fallback chain).
- [ ] Implement; run the files and the full suite + `humo.mjs`.
- [ ] README and CHANGELOG. Commit `seki-review: template runs share the cached diff and reuse unchanged templates`.

### Task 3: Ultra skips the security lens covered by templates (B5)

**Files:** modify `mcp/lib/plantillas.mjs` (`cubre` validation), `plantillas/owasp-web.json`, `plantillas/pci-dss.json`, `mcp/lib/ultra.mjs`, `mcp/lib/perfiles.mjs` (`topeRevisarUltra(n = 3)`), `mcp/lib/servidor-web.mjs` (cap of the Ultra job from `datosUltra`), `mcp/tablero/partes/07b-modos.js` (dialog note and result line for a skipped lens), `mcp/tools/pr_ultra.mjs` if it prints the estimate, `test/plantillas.test.mjs`, `test/ultra.test.mjs`, `test/ultra-api.test.mjs`, `test/perfiles.test.mjs`, `README.md`, root `CHANGELOG.md`.

**Interfaces:**
- Consumes: `leerPlantillasPr(p, repo, numero)` (stored result with `headSha` and `plantillas[].id/ok`), `plantillasDe(p)`.
- Produces: `datosUltra(...).lentesCubiertas: string[]`; lens entries `{ nombre: 'seguridad', omitida: true, motivo }`.

- [ ] Tests first: `cubre` accepted only as an array of known lens names; Ruling 11 (same-`headSha` template result with `owasp-web` ok → no call for `seguridad`, lens recorded as skipped with the motive, other lenses run; template result of another commit or with `ok: false` → lens runs; cap = 2 lenses + verification; history estimate × 2/3); dialog text `Security lens skipped: covered by the template review of this commit` rendered from `lentesCubiertas` (vm test like the existing Ultra renderer tests).
- [ ] Implement; full suite + `humo.mjs`. README, CHANGELOG. Commit `seki-review: Ultra skips the security lens when the template review of the commit covers it`.

### Task 4: Templates tab, dialog and Copy review (C1–C15, and the board side of Tasks 2–3)

**Files:** modify `mcp/tablero/partes/07d-plantillas.js`, `07c-revisar.js`, `07b-modos.js` (`abrirModal`/`cerrarModal`, focus trap), `04-script-1.js` (`marcarCopia`), `08-script-5.js` (poll repaint guard, shortcuts), `07-script-4.js` (tab counter), `02-estilos.css`, `02c-modos.css`, `02d-revisar.css`, `test/tablero-plantillas.test.mjs`, `test/sondeo-tablero.test.mjs`, `test/plantilla.test.mjs` where it pins markup, root `CHANGELOG.md`.

**Interfaces:**
- Consumes: `resultado.ramasMovidas`, items `reutilizada`, `soloPruebas` findings (Tasks 1–2).
- Produces: `plantillasVigentes(pr, r)` per Ruling 12; `marcarCopia(boton, ok, texto?)`; `resumenPlantillas(r) -> { fallas, pedidos, cumplen }`.

- [ ] Tests first (vm): Ruling 12 (dialog and tab agree for `desactualizada`, different `headSha`, `ramasMovidas`); stale notice text `The branch <rama> of <repo> moved after this review`; Ruling 13 labels for the three cases; Ruling 16 order, summary and counter; load error renders once with a `Try again` button (`data-plantillas-reintentar`) and is not retried by a repaint; no applicable AI template → no cost in the button and the text `Only fixed rules apply: no AI cost`; no template at all → no button, `No template applies to this PR.`; PR not open → `The PR is closed: the stored result stays, no new review.`; failed job banner has `Try again`; confirm button disabled with `Starting…` while the POST is pending and a 409 "already queued" goes to the tab; `?plantillas=1` replaced in the hash on open and a malformed `%` does not throw; `ESTADO_ITEM` lookup with `constructor`; reused items show `Reused from the previous commit`.
- [ ] Tests first (`sondeo-tablero` or vm): Ruling 14 (poll with `#modalIa` present → detail not repainted; shortcuts ignored; focus goes to the current opener when the stored one is disconnected) and Ruling 15 (two polls in progress → same banner node, elapsed text updated).
- [ ] Implement, including CSS: `.modal { overflow-wrap: anywhere }`, `.modal-pie { flex-wrap: wrap }`, stable width for the copy button (icon kept), visually hidden status region, Ruling 17.
- [ ] Full suite + `humo.mjs`. CHANGELOG. Commit `seki-review: Templates tab states, dialog focus and Copy review feedback`.

### Task 5: Motion (D1–D6)

**Files:** modify `mcp/tablero/partes/02-estilos.css`, `02c-modos.css`, `02d-revisar.css`, `07b-modos.js`, `07d-plantillas.js`, `04-script-1.js`, `DESIGN.md` (motion section: the values below), `test/tablero-plantillas.test.mjs`, `test/plantilla.test.mjs`, root `CHANGELOG.md`.

**Values (exact):**
- Dialog in: backdrop `opacity 0→1` 160 ms `ease-out`; box `opacity 0→1`, `translateY(8px)→0`, `scale(.98)→1`, 200 ms `cubic-bezier(.16,1,.3,1)`. Out (class `saliendo`): 120 ms `ease-in`, reverse.
- First reveal of a result (Ruling 18): each open item `opacity 0→1`, `translateY(4px)→0`, 220 ms `cubic-bezier(.2,.8,.2,1)`, `animation-delay: min(i × 30ms, 240ms)` via `--i`.
- End of progress: when the job leaves `en_curso`, the bar gets class `completa`: `transform: scaleX(1)` 200 ms ease-out, then `opacity→0` 150 ms; the banner is removed after it.
- Copy: success → button `scale(.96)→1` 140 ms `cubic-bezier(.34,1.56,.64,1)` and border `var(--verde)` while the label shows; failure → `translateX(±2px)` twice in 160 ms. Reduced motion: colour only.
- Fold (`details.plegado`) and stale notice: content wrapper `grid-template-rows: 0fr→1fr` 200 ms ease-out.

- [ ] Tests first: the generated board CSS contains each new class inside the `prefers-reduced-motion: reduce` block; `cerrarModal` under `matchMedia('(prefers-reduced-motion: reduce)').matches` removes at once; the reveal class is set on the first render of a result and not on the second (Ruling 18); replacing the dialog (`abrirModal` twice) does not replay the entrance of the backdrop.
- [ ] Implement; full suite + `humo.mjs`. DESIGN.md, CHANGELOG. Commit `seki-review: entrance, completion and copy motion in the review dialogs and the Templates tab`.
