# Test a review unit and seek counterexamples

You test unit `<unit>` of the review in `<dir>`.
Read `task.md` for original requirements when present, then `plan.json` for the project, mode and exact target, `project.md`, and the unit's diff parts.
For `all`, use all diff parts; for a set, use its jobs; for `crossing`, use `sets.json`.
You run concurrently with principle reviewers. Do not wait for or read their candidates: develop your own hypotheses from production code and existing assertions.

## Gather evidence

Inspect real code, callers and existing tests wherever needed, including unchanged files.
Choose checks for the behavior the change can break: boundary inputs, error paths, compatibility, concurrency or contracts between components.
Identify the most consequential changed behavior that existing assertions do not protect, including ownership, lifecycle, error and contract transitions.
Design small falsifiable hypotheses and focused counterexamples against real production entry points. Check whether the implementation approach can satisfy the requirement, not merely whether its individual functions work.
No exhaustive ownership map, branch matrix, hypothesis quota or separate investigation document is required.
Prefer a few discriminating probes over many broad ones. Aim for about 5 minutes for an ordinary change; stop expanding low-value checks, and disclose unresolved risks or infrastructure limits.
Run an existing suite only when it materially resolves a question; suite success alone cannot establish coverage. Do not replay a broad baseline by default.
Do not spend the whole stage repairing test infrastructure while leaving independent code and probe work undone.
You may add or modify tests, fixtures and probe scripts in a disposable copy of the reviewed snapshot.
Use `plan.source` as the frozen selected input; copy it into your own probe directory as needed. It includes local uncommitted/untracked work when that is the chosen scope. Obtain unchanged dependencies and context from the original root without modifying them.
Only use Git revisions for a Git comparison. For older plans without a source snapshot, preserve the recorded target and actual working-tree contents. A snapshot review has no base comparison: use scope `current` and test the present contract.
Keep the user's source, tests, staging area and branch untouched.
Do not apply a product fix as part of the review.

Use `<dir>/probes/<unit>/` for scripts, logs and a disposable checkout when necessary.
Each unit owns its directory, so concurrent testers do not modify each other's fixtures.
Use the project's available runtime and dependencies; preserve the host's sandbox and approval controls.
Run checks against local test resources, not production services or data.
If a required runtime, dependency or permission is unavailable, record the exact blocked check and continue independent checks.
Do not claim a blocked check passed or call an infrastructure failure a product defect.

## Prove the defect

For a new counterexample, capture the command, input, expected result, actual result and exit status.
Where feasible, show it fails on the reviewed version and passes on the base, with the same fixture.
Otherwise explain how the diff causes the failure and what prevents a base comparison.
A probe must call the actual production path rather than reproduce its implementation in the test.
Retain the reproduction and its output so another reviewer can rerun it.
Use `proven` only for a demonstrated defect; use `reasoned` for an argument from code and `speculative` for unverified assumptions.
Look for missing behavior tests as well as checking the existing candidates; test coverage complaints must cite an in-scope principle or explain a concrete risk.
If the unit has no executable behavior, record that and skip execution.

## Answer

Write `<dir>/probes/<unit>/results.md` with checks, commands, results, limitations, candidate references, and the disposition of the hypotheses actually pursued. Keep this short; record skipped material checks as limitations.
Write `<dir>/verdicts/testing-<unit>.json` in the reviewer's format with `job` set to the unit and an empty `verdicts` list.
Put new candidates in `outside`; when one violates an assigned principle, include its `principle` id and an exact advice `quote`.
The verifier will reconcile your independent discoveries with principle candidates; do not wait for a handoff.
Every proven candidate carries `provenTest` with the reproduction command and artifact paths.

Answer only with `done`, the number of checks run and candidates found, and any blocker.
