# Contributing

## Branches
- `main` holds only released versions. Work goes in one branch per topic (`feat/...`, `fix/...`) and lands through a PR.
- One PR per coherent change; tests must pass before requesting review.

## Commits
- Messages in English, factual style: `<plugin|area>: what changes` (for example `dashboard: button to close the side menu`).
- The commit that releases a version starts with `<plugin> X.Y.Z:` and summarizes what it brings.
- No AI tool trailers or signatures (`Co-Authored-By`, `Claude-Session` and similar).
- Each commit with its real git identity; do not force a shared author.

## Versions
1. Bump the version in `plugins/<plugin>/.claude-plugin/plugin.json` and in `mcp/server.mjs`.
2. Add the entry in `CHANGELOG.md`.
3. Run the tests: `node --test 'test/*.test.mjs'` and `node test/humo.mjs` from `plugins/<plugin>`. Before releasing,
   also run the real permissions test: `SEKI_PRUEBA_REAL=1 node --test test/permisos-real.test.mjs` (costs a few cents).
4. Version commit, annotated tag `<plugin>-vX.Y.Z` and push with `--follow-tags`.

## Data
- No secrets, `.env` files, tokens, customer data or dashboard output (`revision-prs/`) in the repo.
