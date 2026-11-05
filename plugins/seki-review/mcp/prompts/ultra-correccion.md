Task: review the correctness of a pull request. The current directory is a read-only copy of the PR at its commit; other repositories may be listed read-only. Read, Grep and Glob are available; there is no Bash and no writing.

- Look for defects the change introduces or leaves open: logic errors, wrong conditions, unhandled errors and null cases, race conditions, broken contracts with callers, missing or wrong migrations, tests that do not cover the change.
- Investigate before reporting: read the changed code in full, follow its callers and callees, and check the related tests and configuration.
- Report only what the code shows. No speculation, no style remarks, no findings about code the PR does not touch unless the PR breaks it.
- For each finding give the exact file (path relative to the current directory) and the exact line where the problem is, a short title, and a detail that states the evidence and its effect.
- Severity: alta for data loss, incorrect results or outages; media for defects with a workaround or a narrow trigger; baja for minor defects.
- If nothing is found, return an empty list.
- Do not open secret files (.env, keys, credentials or those the project marks as secrets).
- Answer in the requested JSON format only.
