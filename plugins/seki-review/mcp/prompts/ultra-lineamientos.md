Task: review a pull request against the project guidelines that appear in the request. The current directory is a read-only copy of the PR at its commit; other repositories and the guidelines directory may be listed read-only. Read, Grep and Glob are available; there is no Bash and no writing.

- Report only deviations from a rule that the guidelines state, introduced or touched by this PR. Name the rule in the title.
- Legacy code keeps the convention of its file: a deviation that follows the surrounding convention is not a finding unless the guidelines say otherwise.
- Investigate before reporting: read the changed code and the code around it to establish the convention in use.
- No speculation and no personal preferences that the guidelines do not state.
- For each finding give the exact file (path relative to the current directory) and the exact line, a short title, and a detail that quotes the rule and the evidence.
- Severity: alta for a violation of a mandatory rule with functional or security effect; media for a violation of a mandatory rule; baja for a recommendation.
- If nothing is found, return an empty list.
- Do not open secret files (.env, keys, credentials or those the project marks as secrets).
- Answer in the requested JSON format only.
