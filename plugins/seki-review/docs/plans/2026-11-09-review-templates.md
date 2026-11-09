# Review templates — checklist review per PR with cited evidence and Conventional Comments (0.25.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Templates" tab on every PR detail. Without AI, it shows which review templates apply to the changed files and why. On a confirmed, cost-estimated job, it reviews the PR item by item:
- Each item ends `cumple | falla | no_aplica | no_verificable`.
- Each `cumple` or `falla` carries a literal quote checked against the code.
- Items that a fixed rule can decide never reach the model.

The result includes ready Conventional Comments that "Copy review" appends.

**Spec:** `docs/specs/2026-11-09-plantillas-revision-propuesta.md` (proposal) and the dry run on a real PR; the dry run is kept outside the repo. Its lessons are the rulings 6-8 below.

**Why (evidence, 2026-11-09):**
- Ultra runs three fixed lenses (`mcp/lib/ultra.mjs:27`), and one security prompt for every PR (`mcp/prompts/ultra-seguridad.md:3-4`).
- Findings have no quoted text (`ultra.mjs:32-39`).
- Nothing records which controls were checked.
- "Copy review" (`07c-revisar.js:58`) has no Conventional Comments, although the owner's review guide requires them.
- The dry run found the only blocking issue outside the diff: the other repo's target branch already called a route that did not exist yet. No rule or lens looks there.
- The `as-any` rule missed `(_req: any)`.

**Architecture:**
- **New job type.** `revisar_plantillas` lives next to Ultra and does not change it. Ultra stays the broad review; templates are the repeatable checklist.
- **Template files.** Templates are JSON files: the plugin ships generic base templates in `plantillas/`, and a project may add or override them by id from `p.plantillas` (a directory).
- **The job.**
  - Selects the templates by glob.
  - Runs the fixed rules and the new cross-repo route check.
  - Makes one read-only AI call per active template, for the items that need judgment.
  - Validates the quotes.
  - Runs one verification call over the failures.
  - Builds the comments and Markdown on the server.
  - Stores everything in `salida/plantillas/<repo>-<n>.json`, tied to `headSha`.

**Tech Stack:** Node ≥ 22 standard library, `gh`, `git`, `node --test`. No dependencies.

All paths are relative to `plugins/seki-review/`.

## Global Constraints

- No npm dependencies, no build step. No writes to GitHub: the comments leave only through "Copy review" (product principle 4).
- No project data in the repository. Base templates use generic globs. Project templates live outside the repo, in the folder named by `p.plantillas`.
- UI and tool text: formal, impersonal English. Identifiers follow the existing Spanish naming.
- The text the AI writes for comments follows the template's `idioma` (`es` | `en`, default `en`). Conventional Comments labels and decorations stay in English.
- `spawn`/`execFile` with argument arrays only. Route strings from the diff reach `git grep` only as `-F -e <literal>`, never as a pattern.
- New endpoints use the existing token and Host check, the strict JSON reader and the 16 KB cap.
- Tests:
  - Run `/Users/dev/.proto/tools/node/24.15.0/bin/node --test --test-concurrency=2 'test/*.test.mjs'` and `node test/humo.mjs`, from `plugins/seki-review`.
  - Existing tests stay green. No unit test reaches real gh, git or claude.
- Commits: conventional prefix, English. No AI attribution, no `Co-Authored-By`, no trailers. Never `git stash`.

## Rulings

1. **Template file** `plantillas/<id>.json`:
   ```json
   { "id": "owasp-web", "version": 1, "titulo": "OWASP web", "idioma": "en", "siempre": false,
     "aplicaA": ["src/routes/**", "src/**/*controller*"], "excluir": ["**/__tests__/**", "**/*.spec.*", "**/*.test.*"],
     "items": [ { "id": "W1-authn", "pregunta": "...", "evidencia": "...", "reglas": [],
                  "siFalla": { "etiqueta": "issue", "bloqueante": true, "tema": "security" } } ] }
   ```
   - **Validation:**
     - `id` matches `^[a-z0-9-]{1,40}$`; `version` is a positive integer; `items` has 1 to 30 entries with unique ids.
     - `siFalla.etiqueta` is one of `issue | suggestion | question | nitpick | todo`; `tema` is optional, `^[a-z]{1,20}$`.
     - `aplicaA` and `excluir` hold at most 40 globs of up to 200 characters each.
   - An invalid file is skipped with a `console.error` warning and listed under `invalidas` (file and reason). It never throws.
   - An item with a non-empty `reglas` is deterministic and is never sent to the AI.
2. **Glob** (`globARegex`) supports `**`, `*`, `?` and literal characters, case-sensitive, and is anchored on the full path. `**/` also matches zero directories. No braces or classes: the brace character `{` is a literal.
3. **Selection** (`seleccionarPlantillas(plantillas, rutas)`, no AI, also used by the board's GET):
   - A template is active if `siempre` is true, or if at least one changed path matches `aplicaA` and not `excluir`.
   - The output is `{ activas: [{ id, version, titulo, motivo: { archivo, glob } | 'siempre' }], omitidas: [{ id, titulo }], sinPlantilla: [ruta] }`.
     - `motivo` is the first matching path.
     - `sinPlantilla` lists the paths covered only by `siempre` templates.
4. **Base templates shipped:** `ligera` (always), `owasp-web` and `pci-dss`, with the item ids and questions of the dry run, worded generically.
   - `ligera` includes two deterministic items:
     - `L4-despliegue`, with `reglas: ["rutas-en-otros-repos"]`.
     - `L7-tipos`, with `reglas: ["as-any", "tipo-any"]`.
   - Project templates with the same `id` replace the base one. A project template with a new id is added.
5. **Item states:**
   - **`cumple` and `falla` from the AI** require `archivo`, `linea` and `cita` (≤ 300 characters). Checks:
     - The cited file must exist inside a directory given to the AI. This reuses `existeCita`, exported from `ultra.mjs`.
     - The whitespace-collapsed `cita` must be a substring of the whitespace-collapsed lines `linea-2 … linea+2`.
     - On any check failure, the item becomes `no_verificable` with `motivo: 'The quote does not match the cited code'`.
   - **`no_verificable`** requires `pedido` (≤ 300 characters): the concrete question for the author.
   - **Unknown states or item ids** are dropped. **Items missing from the AI output** become `no_verificable` with `motivo: 'The review did not cover this item'`.
6. **Deterministic items.**
   - `falla` if any fixed-rule finding (from `verificar(...)`, the same call as `pr_verificaciones`) or cross-repo finding has a `regla` in the item's `reglas`. The first finding gives `archivo`, `linea` and `cita` (its `texto`), and all findings are kept as `hallazgos`. Otherwise `cumple`, with `detalle: 'No added line matches the rules <ids>'`.
   - The state source is always marked `origen: 'determinista'`.
   - The rules of a deterministic item ignore the template's `aplicaA`: they run on the whole diff.
7. **New fixed rule `tipo-any`** in `reglas.mjs`:
   - Pattern `/(?::\s*any\b|<any>|\bany\[\])/` on `.ts`/`.tsx` added lines.
   - Tests included, because the standard bans `any` everywhere. Severity `aviso`.
   - Title: "Typing with `any`". Message: "Use `unknown` and narrow it, or the real type."
   - It does not fire on lines already matched by `as-any` (`excluir: /\bas any\b/`).
8. **Cross-repo routes**, rule id `rutas-en-otros-repos`, in `mcp/lib/rutas-cruzadas.mjs`:
   - **Extraction.** `rutasDelDiff(archivos)` reads the added and removed lines of non-test files. It matches `/\.(?:get|post|put|patch|delete|all|use)\(\s*(["'`])(\/[^"'`\s]{5,200})\1/`.
     - It keeps literals whose last segment is static: not `:param`, not `*`.
     - Output: `{ agregadas: [{ ruta, archivo, linea }], quitadas: [...] }`. A route both added and removed in the PR, which is a move, is in neither list.
   - **Search.** `buscarRutas({ rutas, otros, grep })` looks in each other repo copy from `otrasRamas(p, pr)` (`{ repo, portal, rama, dir }`, without `falla`).
     - It runs `git grep -n -F -e <ruta> -- .` in `dir`, at most 3 hits per route per repo, and at most 20 routes per PR.
   - **Findings** have the `verificar` hallazgo shape plus `{ repoOtro, rama, archivoOtro, lineaOtro }`:
     - A removed route still used in the other repo gives severity `bloqueante`, message: "<repoOtro> (<rama>) still calls <ruta> at <archivoOtro>:<lineaOtro>."
     - An added route already used there gives severity `alto`, message: "<repoOtro> (<rama>) already calls <ruta> at <archivoOtro>:<lineaOtro>; this PR must be deployed first."
     - In both cases `archivo` and `linea` point to this PR's line, and `texto` is the route.
   - **Repos not available.** If the other repos cannot be loaded, the job marks `otrosRepos: 'no_disponibles'`, and `L4` becomes `no_verificable` with `pedido: 'Check the other repositories by hand: they could not be loaded'`.
9. **AI call per template.**
   - Job type `plantilla` in the profiles table: `{ modelo: 'sonnet', topeUsd: 1, turnos: 25, segundaPasada: false }` in every mode.
   - Tools: `Read`, `Grep`, `Glob`; directories: this repo's read copy plus the other repos.
   - System: `sistemaDe(p, 'base', 'plantilla')`. The new prompt is `mcp/prompts/plantilla.md`.
   - User prompt: `Template: <id> v<version>. Language: <idioma>.` plus the AI items (`id`, `pregunta`, `evidencia`) as JSON and the same PR context block as Ultra (`contextoDeDiff`).
   - Schema `SCHEMA_PLANTILLA`: `{ items: [{ id, estado, archivo?, linea?, cita?, titulo, detalle, pedido? }] }`, with `required: ['id','estado','titulo','detalle']`.
   - A template whose call fails is stored with `ok: false, motivo`, and its AI items become `no_verificable` with `motivo: 'The template review failed'`. The other templates still count.
   - The job fails only if every active template that has AI items fails.
10. **Verification.**
    - **Input:** the AI `falla` items that survived the quote check go to one call. It uses the existing `ultra-verificar` system prompt and `SCHEMA_VERIFICAR`, both exported from `ultra.mjs`, with ids `<plantilla>/<item>`.
    - **`REJECTED`:** the item becomes `no_verificable`, with `motivo: 'Rejected by the verification: <razon>'` and `pedido` set to the original `titulo`.
    - **No verdict:** the item keeps `falla` with `veredicto: null`. It is never blocking.
    - **Call failure:** every AI `falla` keeps `veredicto: null`, and the result carries `verificacion: 'fallida'`.
11. **Comments** (pure `comentariosDePlantillas(resultado)` in `mcp/lib/comentarios-plantilla.mjs`).
    - **One comment per `falla`**, with:
      - `etiqueta` from `siFalla`.
      - Decorations: `blocking` only when `siFalla.bloqueante` and (`origen === 'determinista'` or `veredicto === 'CONFIRMED'`). Otherwise `non-blocking`, except for `nitpick`, which gets no blocking decoration. Then `tema` if any.
      - `asunto` = `titulo` (for deterministic items: the first finding's `mensaje`), plus `archivo`, `linea`, `cita`, `detalle` and `ref: '<plantilla>/<item>'`.
    - **Order:** blocking first, then by template order and then by item order. At most 5 comments per template; the cut is counted in `recortados`.
    - **Praise:** one `praise`, from the first `cumple` item that has a `cita` and `origen: 'ia'`.
    - **Not verifiable:** one block lists every `no_verificable` item as `- <pregunta> — <pedido ?? motivo>`. Its heading is "Not verifiable from the diff" (en) or "No se pudo verificar desde el diff" (es), in the language of the first active template.
    - **Markdown per comment:**
      ```
      **<etiqueta> (<decoraciones>): <asunto>**
      `<archivo>:<linea>`
      > <cita>

      <detalle>
      _[<ref>]_
      ```
      Decorations are joined with `, `. When there are none, the parentheses are omitted.
    - **Joining:** the comments are joined with a blank line. The praise goes last, then the not-verifiable block.
    - **Return value:** `{ comentarios, markdown, recortados }`.
12. **Stored result** `salida/plantillas/<repo>-<n>.json`:
    ```
    { headSha, fecha, seleccion, otrosRepos?, verificacion?,
      plantillas: [{ id, version, titulo, ok, motivo?, costo, items: [...] }],
      comentarios, markdown, recortados }
    ```
    - `seleccion` is the Ruling 3 output.
    - A result for an older commit is returned with `desactualizada: true`, as Ultra does.
    - Cost record: `tipo: 'revisar_plantillas'`, with `detalle` per step.
    - Job cap: `topeRevisarPlantillas(n) = n * plantilla.topeUsd + ultra_verificar.topeUsd`, where `n` is the number of active templates that have AI items.
13. **API.**
    - `GET /api/plantillas?repo=&numero=` returns `{ seleccion, invalidas, estimacion, topeUsd, resultado }`.
    - `POST /api/plantillas { repo, numero, repetir?, modo?, confirmar: true }` returns 202 `{ encolado: '<id>:plantillas' }`, or 200 `{ desdeCache: true, resultado }` when the stored result covers the current head. It is refused when:
      - `confirmar` is missing (400).
      - The PR is not in the snapshot (409).
      - The PR is not open (409).
      - A job for the PR is already queued (409).
    - A PR whose active templates have no AI items is not refused: the job runs only the deterministic part, at cost 0.
14. **Board.**
    - **New "Templates" tab** (after "Ultra review", count = number of `falla` items). It shows:
      - The active templates with their reason, the omitted templates, and the files covered only by the base template.
      - A "Review with templates · ~US$X" button that opens a confirmation modal like Ultra's.
      - The status of the job.
      - A checklist grouped by template: state chip, item id, question, `archivo:linea` linking to the PR files on GitHub, the quote in `mono`, the detail, and `pedido` or `motivo` for `no_verificable`.
      - The comments preview: the stored `markdown` in a `<pre>`, escaped.
      - The outdated banner when needed.
    - **"Copy review"** appends `\n\n---\n\n` plus the stored `markdown` when a non-outdated template result exists for the PR, and only then.
15. **MCP tool `pr_plantillas`** (read-only, like `pr_ultra`): `{ seleccion, invalidas, estimacion, topeUsd, resultado, enlace: '#/pr/<repo>/<n>?plantillas=1' }`. It never starts the job. The skill gains the argument `templates <repo>#<n>` (Spanish `plantillas`).
16. **Config:** `p.plantillas` is a string path (`~` expanded) or absent. When it is not a string, the config warns and ignores it. It is documented in `config/proyectos.ejemplo.json`.

## Review Focus

1. **The model fakes evidence** (the line exists, the text does not): the quote check moves the item to `no_verificable`. Covered in Task 4: `a quote that is not in the cited lines turns the item into no_verificable`.
2. **The model skips items or invents ids:** the missing ones become `no_verificable`, and the invented ones are dropped. Task 4: `items the AI omitted are not verifiable and unknown ids are dropped`.
3. **A project template is broken** (bad JSON, bad glob, 500 items): it is skipped and listed, and the board still loads. Task 1: `an invalid project template is skipped and reported`.
4. **Other repos unavailable** (no checkout, network): `L4` becomes `no_verificable` instead of `cumple`. Task 3 and Task 4: `without the other repositories the deployment item is not verifiable`.
5. **Comments land in Copy review from a stale result:** the outdated result is never appended. Task 6: `copy review ignores an outdated template result`.

---

### Task 1: Template loading, validation and selection

**Files:**
- Create: `mcp/lib/plantillas.mjs`, `plantillas/ligera.json`, `plantillas/owasp-web.json`, `plantillas/pci-dss.json`, `test/plantillas.test.mjs`.
- Delete: `plantillas/*.md`, the dry-run drafts. Their content moves to the JSON files with generic globs.
- Modify: `mcp/lib/config.mjs` (`p.plantillas`, Ruling 16), `test/config.test.mjs`.

**Interfaces:**
- Produces:
  - `globARegex(glob: string): RegExp`
  - `validarPlantilla(obj: unknown): { ok: true, plantilla } | { ok: false, motivo: string }`
  - `cargarPlantillas(p, { dirBase? }): { plantillas: Plantilla[], invalidas: [{ archivo, motivo }] }`, with project overrides by id, sorted with `siempre` first and then by id.
  - `seleccionarPlantillas(plantillas, rutas: string[]): Seleccion`, as in Ruling 3.
  - `itemsIa(plantilla)` and `itemsDeterministas(plantilla)`.

- [ ] **Step 1: Write the failing tests** in `test/plantillas.test.mjs`:
  - `globARegex matches ** across directories and zero directories`. Assertions:
    - `src/**/x.ts` matches `src/x.ts` and `src/a/b/x.ts`.
    - `*.ts` does not match `a/b.ts`.
    - `a{b}` matches the literal `a{b}`.
  - `the base templates load and validate`: ids `['ligera','owasp-web','pci-dss']`, `ligera.siempre === true`, `invalidas` empty.
  - `a project template with the same id replaces the base one` (temp dir with `owasp-web.json`, version 9).
  - `an invalid project template is skipped and reported`. Use three files: bad JSON, `items: []`, and 31 items. Expect `invalidas.length === 3`, each with `archivo` and `motivo`, and the base templates still loaded.
  - `selection reports the first matching file and the files covered only by the base template`:
    - Paths: `src/routes/a.ts`, `src/routes/__tests__/a.spec.ts`.
    - Expect `owasp-web` active with `motivo.archivo === 'src/routes/a.ts'`, and `sinPlantilla` = `['src/routes/__tests__/a.spec.ts']`.
- [ ] **Step 2:** Run `node --test test/plantillas.test.mjs`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `mcp/lib/plantillas.mjs`, the three JSON templates and the config key.
  - The globs come from Ruling 4, written generically. For example `owasp-web` uses `aplicaA: ["**/routes/**", "**/Routes/**", "**/middleware/**", "**/Middleware/**", "**/controllers/**", "**/Controllers/**", "**/*.routes.*", "**/*.ejs"]`.
  - `pci-dss` uses `["**/*[Pp]ago*", "**/*[Pp]ayment*", "**/*[Tt]ransac*", "**/*[Mm]erchant*", "**/*[Cc]heckout*"]`. Ruling 2 has no classes, so write case variants as separate globs.
  - Read files with `readdirSync` filtered to `.json`, and skip files over 64 KB.
- [ ] **Step 4:** Run the same test plus `test/config.test.mjs`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(seki-review): review templates and their selection by changed files`.

### Task 2: `tipo-any` fixed rule

**Files:** Modify `mcp/lib/reglas.mjs` (after `as-any`), `test/calidad.test.mjs` or the test file that already covers `as-any` (find it with `grep -l "as-any" test/`).

**Interfaces:** Produces the rule id `tipo-any`, which `ligera`'s `L7-tipos` consumes.

- [ ] **Step 1: Failing test** `tipo-any flags any in parameters, generics and arrays, also in tests`:
  - `verificar` on an added `src/__tests__/a.spec.ts` with the lines `(_req: any, res: any) =>`, `const x = <any>y;`, `let l: any[] = [];` and `const z = y as any;`.
  - Expect three `tipo-any` findings (lines 1-3), none on line 4.
  - On line 4, `as-any` stays excluded for tests, as today.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Add the rule from Ruling 7.
- [ ] **Step 4:** Run the full test suite. Expected: PASS. Fix any existing test that counted the catalog size.
- [ ] **Step 5:** Commit `feat(seki-review): fixed rule for any in type positions`.

### Task 3: Cross-repo route check

**Files:** Create `mcp/lib/rutas-cruzadas.mjs`, `test/rutas-cruzadas.test.mjs`.

**Interfaces:**
- Produces:
  - `rutasDelDiff(archivos: {filename,status,patch}[]): { agregadas: Ruta[], quitadas: Ruta[] }`, where `Ruta = { ruta, archivo, linea }`. For removed lines, `linea` is the old-file line.
  - `async buscarRutas({ rutas, otros, grep = grepGit }): Hallazgo[]`, in the Ruling 8 shape.
  - `grepGit(dir, ruta): Promise<{ archivo, linea }[]>`. It runs `git(dir, ['grep','-n','-F','-e',ruta,'--','.'])`. Exit code 1 (no match) means `[]`.
- Consumes: `git` from `proceso.mjs`.

- [ ] **Step 1: Failing tests:**
  - `added and removed express routes are read from the diff`. Patch `+router.post(\n+    "/v1/crear-orden",` written on one line as `+router.post("/v1/crear-orden", mw, ctl);`, plus `-router.get('/viejaRuta', ctl);`. Expect one entry in each list, with the new and old line numbers.
  - `a route moved within the PR, a param-only route and a test file are ignored`. Inputs: `/:id`, `/a/:id`, and a route in `x.spec.ts`.
  - `an added route already called in another repo is high and a removed one still called is blocking`. With an injected `grep`, expect the severities `alto` and `bloqueante` and the message text from Ruling 8.
  - `at most 3 hits per route and repo and 20 routes per PR`.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement it.
  - Old-line numbering mirrors `lineasAgregadas`: count `-` and ` ` lines from the hunk's `-a` start.
  - Add an exported `lineasQuitadas(patch)` to `verificar.mjs` next to `lineasAgregadas`, and test it with the first case.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit `feat(seki-review): find routes added or removed by a PR in the other repositories`.

### Task 4: Template review job

**Files:**
- Create: `mcp/lib/revision-plantillas.mjs`, `mcp/prompts/plantilla.md`, `test/revision-plantillas.test.mjs`.
- Modify:
  - `mcp/lib/ultra.mjs`: export `existeCita`, `SCHEMA_VERIFICAR` and `contextoDeDiff`, which is already exported. No behavior change.
  - `mcp/lib/perfiles.mjs`: add the `plantilla` row and `topeRevisarPlantillas(n)`.
  - `mcp/lib/cache.mjs`: `rutaPlantillas`.
  - `test/perfiles.test.mjs`.

**Interfaces:**
- Consumes:
  - Task 1: `cargarPlantillas`, `seleccionarPlantillas`, `itemsIa`, `itemsDeterministas`.
  - Task 3: `rutasDelDiff`, `buscarRutas`.
  - `verificar` and `reglasDeConfig`.
  - From `ultra.mjs`: `existeCita`, `SCHEMA_VERIFICAR`, `contextoDeDiff`.
  - `otrasRamas`, `crearCopia`, `asegurarDiff`, `argsClaude`, `ejecutarClaude`, `sistemaDe`, `registrarCosto` and `leerCostos`.
  - Task 5: `comentariosDePlantillas`. **Execution order: Task 5 runs before Task 4.**
- Produces:
  - `leerPlantillasPr(p, repo, numero, headSha?)`.
  - `datosPlantillas(p, pr, rutas): { seleccion, invalidas, estimacion, topeUsd, resultado }`.
  - `async revisarPlantillas(p, pr, { repetir, ejecutar, copiar, otras, diff, commits, grep, cargar }): { ok, motivo, costo, modelo, resultado, desdeCache? }`.

- [ ] **Step 1: Failing tests.** Follow the `ultra.test.mjs` harness: a fake `ejecutar` keyed on `/^Template: ([\w-]+)/` and a temp copy with `src/a.ts`.
  - `only the AI items of each active template are sent and deterministic items never are`. Assert that the prompt JSON contains no item with `reglas`.
  - `a quote that is not in the cited lines turns the item into no_verificable`.
  - `a quote with different whitespace still matches within two lines`.
  - `items the AI omitted are not verifiable and unknown ids are dropped`.
  - `deterministic items fail from fixed rule findings and pass with no finding`. Use `tipo-any` on an added `: any`.
  - `without the other repositories the deployment item is not verifiable`. Here `otras` throws.
  - `a rejected failure becomes not verifiable with the reason and a confirmed blocking one stays blocking`.
  - `one failed template does not fail the job; all failed does`.
  - `the result is stored per commit, read back as outdated after a new head, and a second run for the same head spends nothing`.
  - `the cost record has tipo revisar_plantillas and one detail per step`.
  - `topeRevisarPlantillas(2) equals 2 * plantilla cap + ultra_verificar cap` (in `perfiles.test.mjs`).
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement Rulings 5, 6 and 8-12.
  - **Prompt** `plantilla.md` covers:
    - The context: read-only copy, other repos.
    - Answer every listed item and no other.
    - `cumple` or `falla` only with the exact file, line and a literal quote of up to 300 characters copied from that line or the next ones.
    - Otherwise `no_aplica` (the change does not touch what the item asks) or `no_verificable`, with `pedido`: the concrete question for the author.
    - Follow the data from its entry point; no speculation.
    - `titulo` and `detalle` in the given language; `detalle` states the evidence and the effect in at most three sentences.
  - **Concurrency:** templates run with `enParalelo` at the queue's `paralelo()`.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(seki-review): template review job with quoted evidence per item`.

### Task 5: Conventional Comments builder

**Files:** Create `mcp/lib/comentarios-plantilla.mjs`, `test/comentarios-plantilla.test.mjs`.

**Interfaces:** Produces `comentariosDePlantillas(resultado): { comentarios: Comentario[], markdown: string, recortados: number }`, as in Ruling 11. `Comentario = { etiqueta, decoraciones: string[], asunto, archivo, linea, cita, detalle, ref, bloqueante: boolean }`.

- [ ] **Step 1: Failing tests:**
  - `a confirmed blocking failure renders as issue (blocking, security) with file, quote and reference`. Assert the exact Markdown block from Ruling 11.
  - `an unverified blocking failure is non-blocking`, with `veredicto: null`.
  - `a deterministic failure is blocking without verification and uses the rule message as subject`.
  - `nitpick has no blocking decoration and no parentheses without decorations`.
  - `blocking comments come first, at most five per template, and the cut is counted`.
  - `one praise from the first quoted cumple and one not-verifiable block in the template language`. For `idioma: 'es'`, the heading is "No se pudo verificar desde el diff".
  - `an empty result produces empty markdown`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run them. Expected: PASS.
- [ ] **Step 5:** Commit `feat(seki-review): Conventional Comments from template results`.

### Task 6: API, board tab, Copy review and MCP tool

**Files:**
- Modify:
  - `mcp/lib/servidor-web.mjs`: Ruling 13, next to `/api/ultra`. Take the injectable `ejecutarPlantillas = revisarPlantillas`.
  - `mcp/tablero/partes/07-script-4.js`: `TABS` and `CUERPOS`.
  - `mcp/tablero/partes/07c-revisar.js`: the Copy review append.
  - `mcp/tablero/partes/orden.json`: add `07d-plantillas.js` after `07c-revisar.js`.
  - `mcp/tablero/partes/02d-revisar.css`: state chips reuse `.estado verde|rojo|ambar|''`.
  - `skills/review-prs/SKILL.md`.
  - `test/plantilla.test.mjs`.
- Create:
  - `mcp/tablero/partes/07d-plantillas.js`.
  - `mcp/tools/pr_plantillas.mjs`.
  - `test/plantillas-api.test.mjs`.
  - `test/tablero-plantillas.test.mjs`: `node:vm` rendering, the same approach as the Ultra and `revisionMarkdown` tests (find them with `grep -l "revisionMarkdown\|resultadoUltra" test/`).
- Also: `TIPO_TRABAJO` in `07b-modos.js` gains `revisar_plantillas: 'Template review'`, and the blocked-jobs list includes it.

**Interfaces:**
- Consumes `datosPlantillas` and `revisarPlantillas` (Task 4) and `nombresDeArchivos` (`tablero.mjs`).
- Produces:
  - The board functions `tabPlantillas(pr)`, `resultadoPlantillas(pr, r)` and `abrirPlantillas(prId)`.
  - The job id `<pr.id>:plantillas`.
  - The link `#/pr/<repo>/<n>?plantillas=1`, which selects the PR and opens the confirmation, never the job.

- [ ] **Step 1: Failing tests:**
  - API, following the existing Ultra API tests:
    - `GET /api/plantillas returns the selection without spending`.
    - `POST without confirmar is 400`.
    - `POST for a closed PR is 409`.
    - `POST queues one job and a second POST is 409`.
    - `POST with a current stored result answers 200 from cache`.
    - `requests without the token are refused`.
  - Board:
    - `the checklist shows each item with its state, link and escaped quote`. A quote `<img src=x onerror=alert(1)>` renders escaped.
    - `the outdated banner shows after new commits`.
    - `copy review appends the template comments only when the result is current`.
    - `copy review ignores an outdated template result`.
  - `every part listed in orden.json exists` stays green, and the built page scripts compile.
  - Tool: `pr_plantillas returns the selection and the link and never queues`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement it. Reuse `abrirModal`, `cerrarModal`, `api`, `esc`, `icono`, `plural`, `transcurrido`, `sondear` and `repintarDetalle`, as `07b-modos.js` does. No inline handlers.
  - Button text: "Review with templates".
  - Modal title: "Template review of <repo> #<n>".
  - The modal lists the active templates with their reasons and the estimate line, then a "Start review" button, or "Run again" when a result exists.
- [ ] **Step 4:** Run the full suite plus `node test/humo.mjs`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(seki-review): templates tab, API, copy review and pr_plantillas tool`.

### Task 7: Release 0.25.0 and dry run on the real PR

**Files:** Modify `.claude-plugin/plugin.json` and `mcp/server.mjs` (version `0.25.0`), `../../CHANGELOG.md`, `../../README.md` (Templates section), `PRODUCT.md`, `config/proyectos.ejemplo.json` (`"plantillas": "~/.config/seki-review/plantillas/<project>"`).
- In `PRODUCT.md`:
  - Mark "Rules for review templates" as delivered in 0.25.0.
  - Keep "Shared templates" as a future improvement: a shared repository for the team.
  - Note that splitting Ultra's security lens into templates is pending the owner's decision.

- [ ] **Step 1:** Run the full suite and `node test/humo.mjs`. Expected: PASS, with the output recorded in the final report.
- [ ] **Step 2:** Bump the version and update the CHANGELOG entry, written in the style of 0.24.0. Commit `seki-review 0.25.0: review templates`.
- [ ] **Step 3:** No tag or push here. The owner decides on the PR and the release.
