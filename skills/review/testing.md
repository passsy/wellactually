# Test a review unit and seek counterexamples

You test unit `<unit>` of the review in `<dir>`.
Read `plan.json` for the repository and exact target, `context.md`, `blind.md`, `map.md`, `investigation/<unit>.json`, and the unit's diff parts and candidate findings in `verdicts/`.
For `all`, use all jobs and diff parts; for a set, use its jobs; for `crossing`, use `sets.json` and the crossing candidates.
Read `<dir>/steps/findings.md` for shared tracking.

## Gather evidence

Inspect real code, callers and existing tests wherever needed, including unchanged files.
Choose checks for the behavior the change can break: boundary inputs, error paths, compatibility, concurrency or contracts between components.
Start with the inventory's unprotected behaviors and failure hypotheses, and build focused counterexamples that exercise real production entry points before replaying existing suites.
For each hypothesis, record whether the counterexample refuted it, supported a candidate, remained blocked, or proved unnecessary with concrete evidence.
Extend the inventory if tracing uncovers another affected branch or resource.
Existing suite success alone cannot discharge a hypothesis or establish coverage.
Run relevant existing tests after focused falsification; if an existing test is itself the focused counterexample, explain the exact distinguishing assertion.
Do not spend the whole stage repairing test infrastructure while leaving independent code and probe work undone.
You may add or modify tests, fixtures and probe scripts in a disposable copy of the reviewed snapshot.
Use `target.head` for a committed review, even when the user's checkout is on another branch.
For local changes, include their tracked and untracked contents in that copy; testing only HEAD would test a different change.
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

Write `<dir>/probes/<unit>/results.md` with checks, commands, results, limitations, candidate references, and the disposition of each inventory hypothesis and coverage gap.
Write `<dir>/verdicts/testing-<unit>.json` in the reviewer's format with `job` set to the unit and an empty `verdicts` list.
Put new candidates in `outside`; when one violates an assigned principle, include its `principle` id and an exact advice `quote`.
For an existing candidate, put the evidence and its source candidate reference in `results.md` rather than duplicating it.
Every proven candidate carries `provenTest` with the reproduction command and artifact paths.

Answer only with `done`, the number of checks run and candidates found, and any blocker.
