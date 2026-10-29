# Changelog

Each version has its `seki-review-vX.Y.Z` tag on the commit that releases it.

## seki-review

### Unreleased
- The command is now `/seki-review:review-prs` (skill `review-prs`, formerly `revisar-prs`).
- Code, dashboard, AI prompts and docs are in English; the AI answers in English.

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
