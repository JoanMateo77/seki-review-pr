# Design

PR review dashboard (`mcp/tablero/plantilla.html`). Operate mode: a daily work tool. References taken from Mobbin (2026-10-27): GitHub (PR list), Linear (collapsible groups, split inbox), Graphite and GitLab (PR detail with fixed sections and a status stack), Vercel (status as a dot plus a word).

## Structure

- Top bar: project, snapshot date, search (`/`), Author / Reviewer selector.
- Sidebar (second neutral layer): views, portal and filters with counts; export and import review; shortcuts.
- Queue: collapsible groups by action (author) or by reviewer decision; single-line rows with a tone dot, id in mono, truncated title and up to four signals (findings, review, security, effort, days).
- Detail: status, title, branch and size; actions; status stack (testing, production, twin, other portals, verifications, reviewer); tabs Summary, Files (GitHub-style unified diff: index with +/−, collapsible files, Viewed checkbox, reading order, findings under their line, Expand), Verifications, How to test, Review.
- Sidebar collapsible with the top bar button or `[`; the state is remembered in the browser.
- Diff comments: clicking a line number selects it, Shift + click extends the range within the file. Below the selection a box appears with three types (Ask, Request change, Note with optional suggested code). Comments are shown as threads under their last line; those that no longer match the diff go in a "Comments on lines that changed" block at the top of the file. Questions and change requests are drafts until sent from the "Pending review (N)" bar, fixed at the bottom of the tab. The AI's answer goes inside the thread, separated by a rule, with model and cost in a muted tone and the Ask again action; an error shows the reason in red and Retry. The top bar shows "AI spend today" when there were jobs. A change proposal is shown inside its thread: summary, mini diff per file (files other than the commented one carry "Outside the comment"), check rows (Rules, Types, Tests) and actions by state: Approve and push to the branch (or "Approve with failures" with double confirmation), Request adjustment, Discard; when conflicting or rejected, the reason with Regenerate and Copy patch; when approved, the link to the commit.
- Under 900 px: sidebar as a scrollable row, queue and detail as separate views with a "Queue" button.

## Color

Warm neutrals; color only marks status. One tone per PR, the most severe: red blocks (blocking verification or security not yet in production), amber asks for a look, green ready for production, violet merged. Blue accent only for the primary action, selection and focus. Light by default, dark with `prefers-color-scheme`; both token sets live in `:root`.

## Typography

System sans. Product scale: 12 px (metadata, counts, mono), 13 px (text and controls), 20 px (PR title). Mono only for ids, branches, paths and code. Tabular numbers.

## Components

- Status: pill with a tinted background and text in the same tone.
- Check: icon, name and value with a line of evidence below ("how it was checked").
- Icons: custom SVG symbols, 1.6 stroke, 14 px. No emojis or Unicode glyphs.

## Deliberate rejections

No big-number tiles, no card per row, no tag soup, no uppercase labels above titles, no colored side borders. The previous version had all of that.
