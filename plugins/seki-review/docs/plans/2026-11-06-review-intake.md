# Review intake — PRs requested from the owner and PRs added by link (0.24.0) Design and Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A PR that another developer wants the owner to review reaches the dashboard by itself when the owner is requested as reviewer on GitHub, or in one step when the owner pastes its link. Once in, it gets the full review experience (summary, files, checks, how to test, comments, AI, Ultra), and the owner can copy the review as Markdown to paste on GitHub.

**Why (evidence, 2026-11-06):** `autor: "@me"` adds `--author` to `gh pr list` (`mcp/lib/recolectar.mjs:204`), so other people's PRs never enter the snapshot; nothing parses a PR link (search only filters `FOTO.prs`, `04-script-1.js:104`); every review endpoint answers "PR not in the snapshot" (`servidor-web.mjs:337,492,523`); `review-requested` is not used anywhere. Practice: VS Code GitHub PR extension "Waiting For My Review" (`is:open review-requested:${user}`), Graphite "Needs your review"; GitHub drops a reviewer from `review-requested:` results once they submit a review, so requested PRs must be remembered locally.

**Architecture:** One local list `salida/datos/revisar.json` holds the PRs to review (`origen: 'solicitada' | 'enlace'`). Each refresh adds the open PRs of the configured repos where the owner is requested (`gh pr list -R o/r --state open --search "review-requested:@me" --json CAMPOS`), loads the listed PRs that are not already collected (`gh pr view <n> -R o/r --json CAMPOS`), and runs them through the same per-PR pipeline as the owner's PRs. Closed or merged PRs leave the list at refresh. A dashboard field and an MCP tool add a PR by link without spending AI and without writing to GitHub.

**Tech Stack:** Node ≥ 22 standard library, `gh`, `node --test`.

All paths are relative to `plugins/seki-review/`.

## Global Constraints

- No npm dependencies, no build step. No writes to GitHub (non-goal of the product: no approving or commenting).
- No project data in the repository; fixtures use generic owners/repos.
- UI and tool text: formal, impersonal English. Identifiers follow the existing Spanish naming.
- `spawn`/`execFile` with argument arrays only; the pasted link is parsed and validated before any `gh` call (never passed raw).
- New endpoints behind the existing token + Host check, strict JSON reader, 16 KB cap.
- Tests: `/Users/dev/.proto/tools/node/24.15.0/bin/node --test --test-concurrency=2 'test/*.test.mjs'` and `node test/humo.mjs` (from `plugins/seki-review`). Existing tests stay green. No unit test reaches real gh/git/claude.
- Commits: conventional prefix, no AI attribution of any kind, no `Co-Authored-By`, no trailers. Never `git stash`.

## Rulings

1. **Accepted input** (`parsearEnlacePr(texto, p)` pure): `https://github.com/<owner>/<repo>/pull/<n>` with any suffix (`/files`, `/commits/...`, `?w=1`, `#discussion_r…`), `<owner>/<repo>#<n>`, `<repo>#<n>`, `<repo> <n>`. Owner must equal `p.owner` (case-insensitive) and repo must be a key of `p.repos`, else a clear error: "The repository <o>/<r> is not configured in project <clave>". `n` positive integer ≤ 10^7. Whitespace trimmed; max 500 chars.
2. **List file** `revisar.json`: `{ version: 1, prs: [{ repo, numero, origen, agregada }] }`, written atomically through `escribirJson`; same-id entries collapse (an `enlace` entry is never downgraded to `solicitada`). Max 200 entries (oldest `solicitada` dropped first).
3. **Requested PRs are remembered.** Every PR found through `review-requested:@me` is added to the list with `origen: 'solicitada'`, so it stays after the owner submits a review on GitHub. It leaves the list only when GitHub reports it closed or merged, or when the owner removes it.
4. **Same pipeline, no author filter.** Listed PRs bypass `p.autor` and go through the existing per-PR closure (extract it to a named function, no behaviour change for existing PRs). Items carry `paraRevisar: 'solicitada' | 'enlace'`. A PR that is both the owner's and listed keeps the owner's grouping and also shows the mark.
5. **Not part of deliveries.** Items whose author is not the owner and that are only in the snapshot because of the list are excluded from deliveries, events derived from merges, QA guide and orphan/recent lists (`derivarEntregas` and friends get only the owner's PRs). Their testing/production state is still computed (useful to the reviewer).
6. **Partial refresh.** Adding a PR by link triggers a partial refresh of that repo through the existing `refrescar(repos)` single-flight path; the response returns `{ id, estado: 'agregada' | 'ya_estaba' }` and the board selects the PR once it is in the snapshot. A PR that `gh pr view` reports closed/merged is refused: "PR <repo>#<n> is closed or merged".
7. **Board.** A section "To review" first in both Author and Reviewer views, with sub-groups from the owner's local decision (`revision(pr)`): "Needs my review" (no decision, or `duda`), "Waiting on the author" (`cambios`), "Approved by me" (`aprobada`, `probada`). Each card shows a badge "Requested" or "Added by link" and the author login. A field "Review a PR" (placeholder "Paste a PR link or repo#number") in the top bar; Enter adds; errors show inline. A remove action ("Remove from To review") on cards with `paraRevisar` (only removes from the list, never touches GitHub). Unknown `#<repo>#<n>` hash routes show "This PR is not in the dashboard. Paste its link in Review a PR." instead of being ignored.
8. **Copy review.** In the Review tab a "Copy review" button builds Markdown: decision line, then each comment of the owner (`**<file>:L<from>–<to>**` + text, questions prefixed "Question:"), then general notes. Pure function `revisionMarkdown(pr, decision, comentarios)` in a board part, unit-tested in `node:vm` like the Ultra renderer. Copy uses the existing clipboard helper.
9. **Chat.** New MCP tool `pr_revisar { enlace }` → parses, validates, appends to the list (no AI, no GitHub write; one `gh pr view` to check it is open) and returns `{ id, estado, enlaceTablero }`; a running dashboard picks it up on its next refresh. Tool `pr_revisar_lista` is NOT added: `prs_pendientes` gains a `paraRevisar` section. Skill: argument `review <link>` (Spanish `revisar <link>`) and the "To review" section in summaries.

## Review Focus

1. Pasting a link of an unconfigured repo, another owner, a closed PR, garbage, or 10 KB of text → clear error, no `gh` call with raw input.
2. The owner reviews on GitHub and the PR leaves `review-requested:` → it stays in "To review" until merged/closed/removed.
3. Someone else's PR never shows up in deliveries, the QA guide or merge events.
4. A refresh with 20 listed PRs keeps the existing concurrency (6) and the per-repo serialization of git work.
5. Existing users with no requested PRs and an empty list see no change (no new section rendered when empty).

---

### Task 1: Link parsing, list store and collection (`mcp/lib/revisar.mjs`, `recolectar.mjs`, `cache.mjs`)

**Files:** Create `mcp/lib/revisar.mjs`, `test/revisar.test.mjs`; modify `mcp/lib/recolectar.mjs`, `mcp/lib/cache.mjs` (`rutaRevisar`), `test/recolectar.test.mjs`.

**Produces:** `parsearEnlacePr(texto, p) => { repo, numero }` (throws tagged `[seki-review/revisar]` errors with `codigo`), `leerRevisar(p)`, `agregarRevisar(p, { repo, numero, origen })`, `quitarRevisar(p, id)`, `podarRevisar(p, cerradas: Set<id>)`. `recolectar` collects requested PRs (Ruling 3), loads listed ones (Ruling 4), marks `paraRevisar`, prunes closed/merged, and excludes non-owner listed items from deliveries/orphans/recents (Ruling 5).

- [ ] Tests first: every input form of Ruling 1 incl. suffixes and errors; list collapse/limit; requested PR remembered after it leaves the search (gh double returns it in one refresh, not in the next); closed listed PR pruned; author filter bypass only for listed PRs; deliveries exclude them; existing recolectar tests unchanged.
- [ ] Implement, run file + full suite, commit `feat(seki-review): collect PRs requested for review and PRs added by link`.

### Task 2: Endpoints, board and copy review (`servidor-web.mjs`, `tablero/partes/`)

**Files:** modify `mcp/lib/servidor-web.mjs`, board parts (new `07c-revisar.js` + CSS if cleaner, registered in `orden.json` before `08-script-5.js`), `test/plantilla.test.mjs`, new `test/revisar-api.test.mjs`.

**Produces:** `POST /api/revisar { enlace }` (Ruling 1, 6), `POST /api/revisar/quitar { id }`; board pieces of Rulings 7 and 8.

- [ ] Tests first: endpoint auth/Host/size, parse errors → 400 with message, closed PR → 409, partial refresh triggered once (single-flight), remove; `revisionMarkdown` output and escaping-independent Markdown (plain text); "To review" grouping function; empty list renders no section.
- [ ] Implement, run, commit `feat(seki-review): review a PR by link from the dashboard and copy the review`.

### Task 3: MCP tool, skill, smoke test, release 0.24.0

**Files:** create `mcp/tools/pr_revisar.mjs`; modify `mcp/tools/prs_pendientes.mjs`, `mcp/server.mjs` (0.24.0), `.claude-plugin/plugin.json` (0.24.0), `skills/review-prs/SKILL.md`, `test/humo.mjs`, `CHANGELOG.md` (repo root), README where it describes what the dashboard collects.

- [ ] Tests first (`test/pr-revisar.test.mjs`): tool validates and appends, refuses closed PR, no AI; humo: gh double with one requested PR and one linked PR → both in the snapshot under "To review", not in deliveries.
- [ ] Implement, full suite + humo, commit `feat(seki-review): release 0.24.0 with review intake`.
