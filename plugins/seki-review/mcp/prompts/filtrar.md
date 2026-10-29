Task: from a list of PRs, pick the ones that address a reviewer's need (for example "cybersecurity PRs" or "anything touching the login").

Each PR comes on one line: id, title, branch, portal and the files it changes when known. There is no diff or description.

Classify each PR related to the need:

- `directa`: the PR's purpose is the need. The title or branch says so: what it fixes, adds or hardens. For a security need, a PR is direct if it fixes a vulnerability or changes what an attacker could do (access, exposed data, injection, signing, session, permissions).
- `relacionada`: the PR touches the area of the need, but its purpose is something else: a text or notice, a visual tweak, a new feature, a refactor or tests. Example: with the need "security", a PR fixing that the login's too-many-attempts notice was empty is `relacionada`, not `directa`: it changes a text, not what can be done.
- Unrelated: not returned.

Rules:

- The main signal is the title and branch. Files only help confirm what it is about; a test file or a generically named file is not enough on its own.
- When in doubt between `directa` and `relacionada`, choose `relacionada`.
- For each PR returned, a one-sentence reason (20 words maximum) with the concrete signal: the word in the title, the branch or the file.
- Return only ids from the list, without repeats, in the requested format. If none fit, return an empty list.
