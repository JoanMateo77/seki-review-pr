# Phase 2 — QA guide, import and tracker sync (0.22.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One action produces the QA test guide (`.xlsx` + `.pdf`) for the deliveries waiting for QA, the filled guide is imported back as `qa_resultado` events that move the board, and the project's findings spreadsheet is updated without losing its format.

**Architecture:** Pure layers first (ZIP, OOXML writer/reader/cell editor, guide content, import mapping, tracker diff), then I/O wrappers (files under `salida/qa/`, Chrome for the PDF, backups for the tracker), then the surfaces (MCP tools, endpoints, board). QA results enter the existing stage machine through the `qaDe` hook of `construirEntregas` (`mcp/lib/etapas.mjs:121`), matched by track PR ids, not by delivery key.

**Tech Stack:** Node ≥ 22 standard library only (`zlib.deflateRawSync`, `inflateRawSync` with `maxOutputLength`, `zlib.crc32`, `crypto.createHmac`, `child_process.spawn`), `node --test`.

**Spec:** `plugins/seki-review/docs/specs/2026-11-04-deliveries-qa-ai-modes-design.md` — sections 6.7, 6.8, 6.9, 6.11 (QA tools only), 7, 8, 12 ("QA rows, results and cuts", "Tracker", "Hardening"). §12 supersedes earlier sections.

All paths below are relative to `plugins/seki-review/`.

## Global Constraints

- No npm dependencies, no build step; Node ≥ 22 (launcher already enforces it). No CRC32 fallback.
- No project data in the repository: column names, state texts, ID patterns and tracker paths come only from the user's `proyectos.json`. Fixtures use generic IDs (`X-001`) and generic text.
- UI and tool text: formal, impersonal English. Identifiers follow the existing Spanish naming.
- QA-facing cells never show PR numbers, branch names or file paths.
- No shell strings: `spawn`/`execFile` with argument arrays (Chrome).
- Every new endpoint behind the existing token and Host check; JSON bodies capped (16 KB for the guide/tracker endpoints, 7 MB for the import body carrying ≤ 5 MB decoded).
- Generated files only under `salida/qa/`; tracker writes only to the path in the config; backups under `salida/respaldos/`.
- XLSX reader limits: 200 entries, 20 MB total uncompressed, inflate with `maxOutputLength`, 5 000 rows, 100 columns, 32 767 chars per cell, 5 MB file.
- Errors carry a tag (`[seki-review/qa]`, `[seki-review/xlsx]`, `[seki-review/rastreador]`) and a safe message; never cell contents or secrets in logs.
- Tests: `node --test 'test/*.test.mjs'` and `node test/humo.mjs`, run with `node` (Node >= 22). Existing tests stay green.
- Commits: conventional prefix, no AI attribution of any kind, no `Co-Authored-By`, no session trailers. Never `git stash`.

## Rulings made while planning (spec silent or ambiguous)

1. **Row identity.** One guide row per (finding ID, track). A track without IDs gets one row labelled `E<n>` (n = 1-based delivery position in the guide). The pair (ID cell, Portal cell) is unique inside a guide; import matches rows by that pair against the `_seki` sheet, never by row position, so QA may sort, filter or delete rows.
2. **HMAC scope.** The HMAC covers the key fields (guide id, row label, portal, sorted track PR ids, delivery key). QA-editable columns (Result, QA notes, Evidence, Date, Tester) are outside it.
3. **Results by track PR ids.** `qa_resultado` events carry the track's PR ids; `qaDe(entrega, pista)` matches events whose `prs` intersect `pista.prs`. Regrouping or renaming a delivery does not lose results.
4. **Aggregation per track** (spec §12): any `fallo` → `{ resultado: 'fallo' }`; all rows `ok`/`na` with at least one row → `ok`; otherwise `null` (still waiting). Any `bloqueado` row adds `bloqueado: true`, which produces a new alert `qa_bloqueada`. Only rows of the newest guide covering the track count; per row, the newest import wins.
5. **Stale results.** Import refuses rows of a track whose newest testing merge is later than the merge the guide recorded for it ("New testing merge after the guide: generate a new guide"). The stage machine's own staleness rule stays as a second guard; `qa.ts` = import time.
6. **Missing steps.** The MCP tool never spends AI. The dashboard endpoint accepts `explicarFaltantes: true` and queues the existing explain job for PRs without explanation; their rows say `Steps pending`. Saving mode arrives in phase 3 and will replace the model choice there.
7. **Pending tracker updates are derived, not stored.** Desired cell values per finding ID are computed from the deliveries; "pending" = cells whose current value differs. The watcher never writes; writes happen on import and on the "Update spreadsheet" action (`escribirEnMerge` stays out of this phase).
8. **Tracker columns by header text.** `qa.rastreador` names columns by their header text (trimmed, case-insensitive) in row `filaEncabezado` (default 1), not by letter, so inserting a column does not break the mapping.
9. **Dates written to the tracker** for "in testing"/"in production" are `YYYY-MM-DD` of the newest merge of that environment; PR cells hold the PR URLs joined by `\n`.

## Configuration (`qa` section of a project in `proyectos.json`)

```json
"qa": {
  "columnas": ["ID", "Portal", "Screen and access", "Preconditions and data", "Steps", "Expected result", "Priority", "Result", "QA notes", "Evidence", "Date", "Tester"],
  "resultados": ["OK", "Fail", "Blocked", "Pending", "N/A"],
  "mapeo": { "OK": "ok", "Fail": "fallo", "Blocked": "bloqueado", "Pending": null, "N/A": "na" },
  "chrome": null,
  "rastreador": null
}
```

`rastreador` when set: `{ "tipo": "xlsx", "ruta": "~/...", "hoja": "Sheet1", "filaEncabezado": 1, "columnaId": "ID", "lectura": { "hallazgo": null, "pasos": null, "esperado": null, "pantalla": null, "prioridad": null }, "columnas": { "estado": null, "prPruebas": null, "prProd": null, "enPruebas": null, "enProd": null }, "estados": { "<etapa>": "<text>" }, "escribir": true }`. Any `null` column is skipped. `columnas` positions are semantic: the guide writer locates Result/ID/Portal by index 7/0/1 of the default list; a user list must keep `ID`, `Portal` and `Result` (validated, else the default list is used with a warning).

## Review Focus

1. **The tracker is open in Excel during an import** (`~$<name>` exists) → the import still records events and moves the board; the tracker write is refused with "The spreadsheet is open in another program; close it and use Update spreadsheet". Test in Task 7.
2. **QA sorts, filters or deletes rows, or Excel re-saves the guide** (shared strings, `t="s"`, `t="str"`, new styles) → rows still map by (ID, Portal); deleted rows are simply absent. Tests in Tasks 2 and 6 (Excel-variant fixture, shuffled rows).
3. **A testing merge lands after the guide was generated** → those rows are refused with the reason and the delivery stays in `esperando_qa`; the next "since last cut" guide includes it again. Tests in Tasks 4 and 6.
4. **The same file is imported twice, or a corrected file later** → no duplicate events; per row the newest import wins (a Fail corrected to OK moves the track to `listo_produccion`). Test in Task 6.
5. **Chrome missing, hanging or failing** → `.xlsx` and `.html` are still produced, the response says the PDF is unavailable and why; a hang is killed at the timeout and the profile directory is removed. Test in Task 5.

---

### Task 1: ZIP container (`mcp/lib/zip.mjs`)

**Files:**
- Create: `mcp/lib/zip.mjs`
- Test: `test/zip.test.mjs`

**Interfaces:**
- Produces: `crearZip(entradas: Array<{ nombre: string, datos: Buffer|string, comprimir?: boolean }>) => Buffer` (deflate by default, stored when `comprimir: false`, UTF-8 names, flag bit 11, no data descriptors, no ZIP64).
- Produces: `leerZip(buf: Buffer, { maxEntradas = 200, maxTotal = 20 * 2**20, maxArchivo = 5 * 2**20 } = {}) => Map<string, Buffer>`; throws `Error` with `codigo` in `ZIP_GRANDE | ZIP_ENTRADAS | ZIP_CIFRADO | ZIP64 | ZIP_DUPLICADO | ZIP_RUTA | ZIP_DESCRIPTOR | ZIP_TAMANO | ZIP_SOLAPADO | ZIP_METODO | ZIP_CORRUPTO`.
- Produces: `reemplazarEntradas(buf: Buffer, cambios: Map<string, Buffer>) => Buffer` — rebuilds the archive copying every untouched entry's local header + compressed bytes verbatim and re-encoding only the named ones (used by the cell editor so other parts stay byte-identical).

- [ ] **Step 1: Write the failing tests** — round trip (`leerZip(crearZip([...]))` returns equal buffers for stored and deflated entries, UTF-8 name `hoja-ñ.xml`); `reemplazarEntradas` leaves untouched entries' raw bytes identical (compare the slices between local header offsets); hardening, one test per code: buffer > `maxArchivo` → `ZIP_GRANDE`; 201 entries → `ZIP_ENTRADAS`; flag bit 0 set → `ZIP_CIFRADO`; `0xFFFFFFFF` size or ZIP64 EOCD locator → `ZIP64`; two entries same name → `ZIP_DUPLICADO`; names `../a`, `/a`, `a\\b`, `C:a` → `ZIP_RUTA`; flag bit 3 → `ZIP_DESCRIPTOR`; inflated length ≠ declared (built by patching the central size) → `ZIP_TAMANO`; a 1 KB entry that inflates to 50 MB → rejected without allocating beyond `maxTotal` (`ZIP_TAMANO` or `ZIP_GRANDE`); two central records pointing to the same local offset → `ZIP_SOLAPADO`; method 12 → `ZIP_METODO`; truncated buffer → `ZIP_CORRUPTO`; CRC mismatch → `ZIP_CORRUPTO`.
- [ ] **Step 2: Run** `node --test test/zip.test.mjs` — expect FAIL (module missing).
- [ ] **Step 3: Implement.** Parse from the End Of Central Directory (scan back ≤ 65 557 bytes); trust only central directory offsets, cross-check the local header name and flags; inflate with `inflateRawSync(slice, { maxOutputLength: declared })` and also enforce the running total against `maxTotal`; verify `zlib.crc32`. Fixed DOS time `1980-01-01 00:00` so output is deterministic.
- [ ] **Step 4: Run** the test file — expect PASS; run the full suite — expect green.
- [ ] **Step 5: Commit** `feat(seki-review): add hardened zip reader and writer`

### Task 2: Minimal OOXML writer and reader (`mcp/lib/xlsx.mjs`) + fixture builder

**Files:**
- Create: `mcp/lib/xlsx.mjs`, `test/util/xlsx-fixture.mjs`
- Test: `test/xlsx.test.mjs`

**Interfaces:**
- Consumes: Task 1.
- Produces: `escribirXlsx({ hojas: Array<{ nombre, filas: string[][], anchos?: number[], encabezado?: boolean, congelar?: boolean, validaciones?: Array<{ rango: string, lista: string[] }>, oculta?: boolean }> }) => Buffer`. Inline strings (`t="inlineStr"`), `xml:space="preserve"`, bold header style + wrap style in `styles.xml`, frozen first row, `<dataValidation type="list">`, `state="hidden"` sheet. Strings with chars invalid in XML 1.0 have them removed.
- Produces: `leerXlsx(buf) => { hojas: Array<{ nombre, oculta, filas: string[][] }> }`, reading `t="s"` (shared strings, including rich text runs), `t="inlineStr"`, `t="str"`, numbers and booleans as text; cells placed by their `r` attribute (gaps filled with `''`). Sheets found through `workbook.xml` + `workbook.xml.rels`; only those part names are read.
- Produces: `columnaLetra(i: number) => string` and `indiceColumna(letra: string) => number` (0-based).
- Produces (test util): `trackerFixture({ variante: 'inline' | 'compartidas', filas }) => Buffer` — an openpyxl-like workbook (inline strings, two styles, two list validations, an auto filter on the header, `<dimension>`, `spans`) and its Excel-saved twin (shared strings, `t="s"`). Generic headers: `ID, Finding, How to reproduce, Expected, State, Testing PR, Production PR, In testing, In production`.

- [ ] **Step 1: Write the failing tests** — round trip text (accents, `<&>"'`, line breaks, leading/trailing spaces, 32 767-char cell); validation list and hidden sheet present in the XML; frozen pane present; reading both fixture variants yields the same `filas`; rejects (`codigo` `XLSX_XML`) a part containing `<!DOCTYPE` or `<!entity` in any case; rejects UTF-16 (BOM `FF FE`/`FE FF` or `encoding="UTF-16"`) with `XLSX_CODIFICACION`; 5 001 rows → `XLSX_FILAS`; column index ≥ 100 → `XLSX_COLUMNAS`; cell longer than 32 767 → `XLSX_CELDA`; a relationship target `../../etc/x` → `XLSX_RUTA`.
- [ ] **Step 2: Run** `node --test test/xlsx.test.mjs` — expect FAIL.
- [ ] **Step 3: Implement** with a small regex-free-of-backtracking tokenizer over `<row>`, `<c>`, `<v>`, `<is>`, `<t>`, `<si>`, `<r>` (no general XML parser; unknown elements skipped). Decode the five XML entities and numeric character references only.
- [ ] **Step 4: Run** the test file and the full suite — expect PASS.
- [ ] **Step 5: Commit** `feat(seki-review): add minimal xlsx writer and strict reader`

### Task 3: Tracker cell editor (`mcp/lib/xlsx-editar.mjs`)

**Files:**
- Create: `mcp/lib/xlsx-editar.mjs`
- Test: `test/xlsx-editar.test.mjs`

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces: `editarCeldas(buf: Buffer, { hoja: string, celdas: Array<{ ref: string, valor: string }> }) => Buffer`. Rewrites only the target `<c>` elements of that sheet as `t="inlineStr"`, keeping their `s` attribute; creates missing `<c>` in column order and missing `<row>` in row order (copying the `s` of the cell above in the same column when the new cell has none); updates `<dimension>` and the row's `spans` only when the edit extends them; leaves `sharedStrings.xml`, styles, validations, auto filter and every other part byte-identical (via `reemplazarEntradas`).

- [ ] **Step 1: Write the failing tests** on both fixture variants: edited cells read back with the new value; the sheet XML outside the edited `<c>`/`<row>`/`<dimension>` is unchanged (compare after removing those elements); every other ZIP entry byte-identical; `s` preserved on a `t="s"` cell turned inline; a new cell in an existing row lands in column order; a new row lands in row order; `dataValidations` and `autoFilter` elements unchanged; editing a sheet name that does not exist → `XLSX_HOJA`.
- [ ] **Step 2: Run** — expect FAIL. **Step 3: Implement.** **Step 4: Run** file + suite — PASS.
- [ ] **Step 5: Commit** `feat(seki-review): add style-preserving xlsx cell editor`

### Task 4: QA config, guide content and cuts (`mcp/lib/qa-guia.mjs`, `config.mjs`, `acceso.mjs`)

**Files:**
- Create: `mcp/lib/qa-guia.mjs`
- Modify: `mcp/lib/config.mjs` (add `QA_DEFECTO`, validators, nested `rastreador` validation), `mcp/lib/acceso.mjs` (add `secretoQa(p)`), `mcp/lib/cache.mjs` (add `rutaGuias`, `dirQa`, `dirRespaldos`)
- Test: `test/qa-guia.test.mjs`, extend `test/config.test.mjs`, `test/acceso.test.mjs`

**Interfaces:**
- Produces: `QA_DEFECTO` exactly as in the Configuration section; `p.qa` always present after `proyecto()`.
- Produces: `secretoQa(p) => Buffer` — 32 random bytes at `salida/datos/secreto-qa` (mode 0600, created once, reused; same pattern as `tokenDe`).
- Produces: `rutaGuias(salida) = salida/datos/guias.json`; `dirQa(salida) = salida/qa`; `dirRespaldos(salida) = salida/respaldos`.
- Produces: `limpiarParaQa(texto: string) => string` — removes `#123`, `owner/repo#123`, PR URLs, branch-like tokens (`feat/…`, `fix/…`, `hotfix/…`, `chore/…`, `release/…`) and file paths with an extension; collapses the leftover whitespace.
- Produces: `filasDeGuia({ entregas, prsPorId, cfgRepos, explicaciones: Map<prId, explicacion>, rastreador: Map<id, { hallazgo, pasos, esperado, pantalla, prioridad }> | null, columnas }) => Array<{ etiqueta, portal, entrega, prs: string[], celdas: string[], pendiente: boolean }>` — one row per (finding ID, track), rows of tracks only in `esperando_qa` or `qa_fallo`; content precedence tracker row → explanation `como_probar` of the track's testing PRs (numbered steps) → PR body list items under a heading matching `/how to test|c[oó]mo probar|pruebas/i` (first 4 KB) → `Steps pending` with `pendiente: true`. Expected falls back to the cleaned delivery title. Every QA-facing cell goes through `limpiarParaQa`.
- Produces: `firmaFila(secreto, { guia, etiqueta, portal, prs, entrega }) => string` (hex HMAC-SHA-256 over `guia\netiqueta\nportal\nsorted prs joined by ','\nentrega`).
- Produces: `entregasDesdeCorte({ entregas, guias }) => entregas[]` — tracks in `esperando_qa` whose newest testing merge is later than the merge any registered guide recorded for a track sharing a PR id with it (or no guide covers it).
- Produces: `registrarGuia(p, guia)` / `leerGuias(p)` on `guias.json` `{ guias: [{ id, fecha, entregas: string[], filas: [{ etiqueta, portal, entrega, prs }], fusiones: { [prsOrdenadas]: mergedAt } }] }`, written with `conBloqueo` + `escribirAtomico`.

- [ ] **Step 1: Write the failing tests** — config: defaults applied; invalid `columnas` (missing `Result`) falls back with one warning; invalid `rastreador.tipo` → `rastreador: null` with a warning; `secretoQa` stable across calls and mode 0600; `limpiarParaQa` strips each token kind and keeps normal text; `filasDeGuia`: two IDs × two portals → four rows with unique (etiqueta, portal); delivery without IDs → `E1`; tracker content wins over explanation; explanation wins over body; nothing → `Steps pending`, `pendiente: true`; no cell contains `#12`, `fix/`, `.mjs`; `entregasDesdeCorte`: covered track excluded, track merged again after the guide included again (Review Focus 3); `firmaFila` changes when any key field changes and not when PR order changes.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** file + suite — PASS.
- [ ] **Step 5: Commit** `feat(seki-review): build qa guide rows and cuts`

### Task 5: Guide files, PDF and `qa_guia` tool (`mcp/lib/qa-salida.mjs`, `mcp/lib/pdf.mjs`, `mcp/tools/qa_guia.mjs`)

**Files:**
- Create: `mcp/lib/qa-salida.mjs`, `mcp/lib/pdf.mjs`, `mcp/tools/qa_guia.mjs`, `test/util/chrome.mjs`
- Test: `test/qa-salida.test.mjs`, `test/pdf.test.mjs`

**Interfaces:**
- Consumes: Tasks 2 and 4; `datosEntregas` / `entregas.json`, explanations via `rutaExplicacion`.
- Produces: `generarGuia(p, { claves?: string[], desde?: 'ultimo-corte', ahora = new Date() }) => Promise<{ id, archivos: { xlsx, html, pdf: string|null }, filas: number, pendientes: string[] /* PR ids without steps */, avisoPdf: string|null, vacia: boolean }>`. With no matching tracks returns `vacia: true` and writes nothing. File names `guia-<YYYY-MM-DD>-<n>.{xlsx,html,pdf}`, `n` = next free integer that day. The xlsx has the visible sheet `QA` (header frozen, Result validation over the data range from `qa.resultados`, widths 14/12/24/28/48/36/10/12/28/20/12/14) and hidden `_seki` (row 1 `guia, proyecto, generado`; then one row per guide row: `etiqueta, portal, entrega, prs, firma`). Registers the guide (Task 4) only after all files are written.
- Produces: `htmlGuia({ titulo, columnas, filas }) => string` — every value escaped, `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`, no scripts, no remote resources, landscape print CSS.
- Produces: `rutaChrome(p) => string|null` (`p.qa.chrome`, else `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, `/Applications/Chromium.app/Contents/MacOS/Chromium`, `/usr/bin/google-chrome`, `/usr/bin/chromium`, `/usr/bin/chromium-browser`; first existing regular file).
- Produces: `htmlAPdf(chrome, html, pdf, { limiteMs = 60_000 }) => Promise<{ ok, motivo? }>` — `spawn(chrome, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${tmp}`, '--no-pdf-header-footer', `--print-to-pdf=${pdf}`, pathToFileURL(html).href])`, serialized with its own `enTurno`, SIGKILL at the limit, `tmp` (from `mkdtemp`) removed in `finally`; never `--no-sandbox` nor `--allow-file-access-from-files`. `ok` only if the PDF exists and is non-empty.
- Produces (test util): `chromeFalso({ modo: 'ok' | 'falla' | 'cuelga' }) => ruta` — a Node script that writes `%PDF-1.4` to the `--print-to-pdf` path, exits 1, or sleeps.
- Produces: tool `qa_guia { proyecto?, claves?: string[], desde?: 'ultimo-corte' }` returning the paths, row count, the PR ids without steps ("run explain on them, then generate again") and the PDF notice. It never queues AI (ruling 6).

- [ ] **Step 1: Write the failing tests** — `generarGuia` on a temp project with an `entregas.json` fixture: files exist, `leerXlsx` gives header = `qa.columnas`, rows match `filasDeGuia`, `_seki` hidden and its signatures verify with `secretoQa`; second call the same day → `-2`; nothing waiting → `vacia: true`, no files, no registry entry; `htmlGuia` escapes `<script>` and contains the CSP meta; PDF (Review Focus 5): fake Chrome `ok` → `pdf` path set; `falla` → `pdf: null`, `avisoPdf` set; `cuelga` with `limiteMs: 300` → killed, `pdf: null`, temp profile removed; no Chrome found → html only with notice; argument array never contains `--no-sandbox`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** files + suite — PASS; `node test/humo.mjs` lists `qa_guia`.
- [ ] **Step 5: Commit** `feat(seki-review): generate qa guide as xlsx, html and pdf`

### Task 6: Import and stage wiring (`mcp/lib/qa-importar.mjs`, `etapas.mjs`, `recolectar.mjs`, `mcp/tools/qa_importar.mjs`)

**Files:**
- Create: `mcp/lib/qa-importar.mjs`, `mcp/tools/qa_importar.mjs`
- Modify: `mcp/lib/etapas.mjs` (alert `qa_bloqueada`), `mcp/lib/recolectar.mjs:118-131` (pass `qaDe` built from events + guides), `mcp/lib/eventos.mjs` (accept `qa_resultado`), `mcp/tools/entregas.mjs` (`TIPOS.qa_resultado`: `QA result`), `mcp/lib/tablero-entregas.mjs` (next step text for `qa_bloqueada`)
- Test: `test/qa-importar.test.mjs`, extend `test/etapas.test.mjs`, `test/eventos.test.mjs`

**Interfaces:**
- Consumes: Tasks 2, 4, 5; `registrarEventos`, `derivarEntregas`.
- Produces: `analizarImportacion(p, buf, { entregas, guias, ahora }) => { guia, eventos: Event[], resumen: Array<{ entrega, portal, resultado: 'ok'|'fallo'|'pendiente'|'bloqueado', filas }>, rechazadas: Array<{ etiqueta, portal, motivo }> }` (pure apart from reading the secret). Checks: `_seki` present, guide id registered, each visible row's (ID, Portal) found in `_seki` with a valid signature, guide's recorded merge ≥ the track's newest testing merge (ruling 5), track still `esperando_qa`/`qa_fallo`. Result text mapped through `qa.mapeo` (trimmed, case-insensitive); `null`/empty → ignored; unknown text → rejected row.
- Produces: event `{ id: sha256('qa_resultado|' + guia + '#' + etiqueta + '@' + portal + '|' + archivoSha), ts: ahora, tipo: 'qa_resultado', entrega, prs, portal, guia, fila: etiqueta, resultado: 'ok'|'fallo'|'bloqueado'|'na', tester, archivo: archivoSha, origen: 'qa' }`.
- Produces: `qaDeEventos(eventos, guias) => (entrega, pista) => { resultado: 'ok'|'fallo'|null, ts, bloqueado: boolean } | null` implementing ruling 4.
- Produces: `importarQa(p, { buf } | { ruta, confirmar }) => Promise<{ guia, resumen, rechazadas, rastreador: { escrito: boolean, motivo?: string, celdas?: number } }>` — validates the path (`realpath`, `.xlsx`, regular file, `stat` size ≤ 5 MB before reading, inside `salida/qa/` or `~/Downloads`, otherwise requires `confirmar: true`), registers events, re-derives deliveries, then calls the tracker sync of Task 7 when configured (until Task 7 lands, `rastreador: { escrito: false, motivo: 'No tracker configured' }`).
- Produces: tool `qa_importar { proyecto?, ruta, confirmar?: boolean }` returning the per-delivery summary and rejected rows.

- [ ] **Step 1: Write the failing tests** — round trip guide → fill Result with `OK`/`Fail` via `editarCeldas` → import → events and summary; rows shuffled and one deleted (rebuild the visible sheet in a new order) still map (Review Focus 2); Excel-variant re-save of the filled guide maps; tampered ID cell → rejected `Row key does not match the guide`; unknown guide id → error `QA_GUIA`; same file twice → second import adds 0 events; a corrected file (Fail → OK) → `qaDeEventos` gives `ok` (Review Focus 4); testing merge after the guide → rows rejected with the new-guide reason (Review Focus 3); `Blocked` row → stage `esperando_qa` with alert `qa_bloqueada`; mixed tracks: portal A OK, portal B Fail → delivery shows `qa_fallo` (least advanced); path checks: outside allowed roots without `confirmar` → `QA_RUTA`; symlink escaping the root → `QA_RUTA`; 6 MB file → `QA_TAMANO` without reading it; `.xls` → `QA_RUTA`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** files + suite — PASS.
- [ ] **Step 5: Commit** `feat(seki-review): import qa results into delivery stages`

### Task 7: Tracker adapter (`mcp/lib/rastreador-xlsx.mjs`)

**Files:**
- Create: `mcp/lib/rastreador-xlsx.mjs`
- Modify: `mcp/lib/qa-importar.mjs` (call the sync), `mcp/lib/qa-guia.mjs` consumers (read tracker content through this module)
- Test: `test/rastreador-xlsx.test.mjs`

**Interfaces:**
- Consumes: Tasks 2, 3, 6; `p.qa.rastreador`.
- Produces: `leerRastreador(cfg) => { filasPorId: Map<id, { fila: number, valores: Record<clave, string> }>, encabezados: Map<texto, indice> }` — header row `filaEncabezado`, header text match trimmed and case-insensitive; a configured column missing from the header → `RASTREADOR_COLUMNA` naming the header text.
- Produces: `contenidoRastreador(cfg) => Map<id, { hallazgo, pasos, esperado, pantalla, prioridad }>` (used by `generarGuia`; works with `escribir: false`).
- Produces: `cambiosPendientes(cfg, entregas, prsPorId) => Array<{ id, ref, columna, actual, nuevo }>` — desired values per ID of the delivery (rulings 7 and 9): `estado` from `estados[etapa]` (skipped if that stage has no text), PR URL lists, merge dates. Only cells whose text differs.
- Produces: `aplicarRastreador(p, entregas, prsPorId, { ahora }) => Promise<{ escrito: boolean, celdas: number, respaldo?: string, motivo?: string }>` — refuses (no throw) when `escribir` is false, the path is not a regular file or is a symlink, or `~$<name>` exists beside it; otherwise copies to `salida/respaldos/<name>-<YYYYMMDD-HHmmss>.xlsx`, writes the edited buffer to a temp file in the same directory and renames it over the original, all under `conBloqueo` on the tracker path.

- [ ] **Step 1: Write the failing tests** on both fixture variants in a temp dir: header mapping by text with different case; missing configured header → `RASTREADOR_COLUMNA`; `cambiosPendientes` lists only differing cells and skips stages without text; `aplicarRastreador` writes the cells, creates the backup, leaves every other cell and ZIP entry identical; lock file `~$tracker.xlsx` present → `escrito: false` with the open-in-another-program motive and no backup (Review Focus 1); symlink → refused; `escribir: false` → refused; import with a tracker configured writes it and reports `celdas`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** file + suite — PASS.
- [ ] **Step 5: Commit** `feat(seki-review): sync qa results to the tracker spreadsheet`

### Task 8: Endpoints and board (`servidor-web.mjs`, `tablero-entregas.mjs`, `partes/`)

**Files:**
- Modify: `mcp/lib/servidor-web.mjs`, `mcp/lib/tablero-entregas.mjs`, `mcp/tablero/partes/08b-entregas.js`, `mcp/tablero/partes/02b-entregas.css`, `mcp/tablero/partes/03-cuerpo.html` (only if the deliveries toolbar lives there)
- Test: extend `test/entregas-api.test.mjs`, `test/plantilla.test.mjs` if it pins part contents

**Interfaces:**
- Consumes: Tasks 5-7, the existing `cola`, `explicarConIa`, `leerJsonEstricto`.
- Produces endpoints (token + Host as today):
  - `POST /api/qa/guia` `{ claves?: string[], desde?: 'ultimo-corte', explicarFaltantes?: boolean }` (16 KB) → result of `generarGuia` with file names only (no absolute paths) plus `encolados` when `explicarFaltantes` queued explain jobs.
  - `GET /api/qa/archivo?nombre=<file>` — `nombre` must match `^guia-\d{4}-\d{2}-\d{2}-\d+\.(xlsx|pdf|html)$`, served from `salida/qa/` with `Content-Disposition: attachment`, correct content type, `X-Content-Type-Options: nosniff`.
  - `POST /api/qa/importar` `{ nombre: string, contenido: base64 }` (7 MB body cap, decoded ≤ 5 MB, else 413) → result of `importarQa` with `{ buf }`.
  - `GET /api/qa/rastreador` → `{ configurado, pendientes: number, muestra: first 20 cambiosPendientes }`; `POST /api/qa/rastreador` (16 KB, empty object) → `aplicarRastreador`.
- Produces board UI (DOM via `textContent`, no inline handlers): in the Deliveries tab a toolbar with "QA guide since last cut", "QA guide for selected" (checkboxes on cards in Waiting for QA / QA failed), "Import QA result" (file input `.xlsx` → base64 → POST), "Update spreadsheet (N pending)" shown only when a tracker is configured; a result panel listing generated files as download links, rows with pending steps, import summary per delivery and rejected rows with their reasons; `qa_bloqueada` alert rendered like the others.

- [ ] **Step 1: Write the failing tests** — each endpoint: 401 without token, 403 wrong token, 415 non-JSON, 413 over cap; `/api/qa/archivo` rejects `../x`, `guia-x.xlsx`, `prs.json` with 400 and serves a real guide with the attachment headers; import endpoint round trip moves a delivery to `listo_produccion` in `GET /api/entregas`; rastreador endpoint reports pending count and writes.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** files + suite — PASS. Eye check: serve the board on a scratch copy of a project, generate a guide, open it, import a filled copy, screenshot to the scratchpad.
- [ ] **Step 5: Commit** `feat(seki-review): qa guide and import on the deliveries board`

### Task 9: Skill, docs and release 0.22.0

**Files:**
- Modify: `skills/review-prs/SKILL.md` (arguments `qa-guide`, `qa-import <path>`; `qa_importar` with `confirmar: true` only after the user names the path), `README.md`, `PRODUCT.md`, `proyectos.ejemplo.json` (generic `qa` block), `CHANGELOG.md` (0.22.0), `.claude-plugin/plugin.json` and `mcp/server.mjs` (version `0.22.0`), `test/humo.mjs` expectations if it pins the tool count (9 tools)
- Test: full suite + `node test/humo.mjs`

- [ ] **Step 1:** Update the docs and versions; CHANGELOG lists features, hardening and the rulings that change behaviour (row identity, results by PR ids, derived tracker updates).
- [ ] **Step 2: Run** `node --test 'test/*.test.mjs'` and `node test/humo.mjs` — expect green and `0.22.0`, 9 tools.
- [ ] **Step 3: Commit** `chore(seki-review): release 0.22.0`
