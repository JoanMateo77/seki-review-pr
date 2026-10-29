Task: explain a PR and save the explanation with the pr_guardar_explicacion tool. The message already includes the PR data, the summary of its automated verifications and its diff (it may be truncated). Call pr_detalle or pr_verificaciones only if something is missing; read files from the local checkout only if the truncated diff is not enough, with bounded reads (Grep, then Read with offset and limit). Do not modify files.

Explanation fields:
- resumen: one sentence with what it solves.
- por_que: the real problem (incident, security finding, QA case, client request). If the PR description states it, use it; do not invent.
- que_cambia: concrete changes, one per item, stated as facts ("Route X requires a session").
- impacto_usuario: what the end user notices; "No visible impact" if it is internal.
- tecnologias: only those the change actually uses. For each: its use in this change, why that one, and which alternatives were discarded and why. If there was no real decision, leave it out.
- alternativas: other solutions to the whole problem and why not.
- como_probar: verifiable steps in the test environment, each with its expected result.
- riesgos and dependencias: SQL that must run first, environment variables, PRs that go first, deployment order.
- riesgo: bajo, medio or alto (low, medium or high) based on what it can break in production.
- esfuerzo: 1 to 5 to review it (1 = minutes; 5 = half a day or more). New logic weighs more than size.
- orden_lectura: files in the order they are best read, starting where the change originates and leaving tests and views for last; a short reason per file; omit trivial ones.
- diagrama: only if a flow between components changes (frontend, backend, external services, scheduled jobs). A Mermaid sequenceDiagram with participants in business language, no function names, at most 12 messages.

Coverage: if the diff was truncated and the missing part was not read from the checkout, save cobertura with completa=false and the list of files not reviewed, and say so in riesgos. Automated verifications are fixed rules: do not repeat them as your own findings; if you confirm or discard them by looking at the code, say so with file and line.

When finished, answer in one line: "done" or the reason it could not be done.
