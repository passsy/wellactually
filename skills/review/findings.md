# Findings MCP is the review workspace

Findings MCP owns the complete finding lifecycle: unverified candidates, verification decisions and human-triage findings. Never create `verified/*.json`, `findings.json`, or another local shadow of those records.
Discover tools by capability—`start_review`, `create_candidates`, `list_candidates`, `resolve_candidates`, `list_findings`, `update_finding`, `add_location` and `baseline_check`—rather than assuming a server prefix. Use the exposed schemas; never hand-edit MCP storage.
Its repository-local storage is `<repo>/.well-actually/<target>/`. Existing `.pascal-review/<target>/` data is copied there on first access; all subsequent writes use `.well-actually`.

## Initialize, in the coordinator

Read `plan.json` and use its absolute `root` as `repo` on every call. Choose one stable `target`: `pr-<number>` for a pull request, otherwise the branch/range, or `local-changes` for a working tree review.
Call `start_review` as soon as the target is known, with a base only when one exists and known PR facts only. Use the review artifact directory name as a stable `run` id for this invocation. Write `<dir>/tracking.json` with `repo`, `target`, `run` and availability so fresh workers address the same review. Tracking must not require Git.
If Findings MCP is absent or cannot represent the selected input, stop before dispatching review workers and report the limitation. Do not fall back to files.

## Create candidates, in reviewers

As soon as a worker finishes checking code and has one or more possible findings, call `create_candidates` once for that worker with the shared `run`. Send the complete author-facing candidate directly:

- a stable `source` meaningful to probes, plus its verification `unit`;
- `title` and a `body` containing the problem and remedy as separate paragraphs;
- priority, evidence, anchor, scope and rule/advice quote when applicable;
- exact `provenTest` text for demonstrated failures.

Correct every indexed error immediately. The returned `C…` ids are the only finding references written into the worker's verdict file: principle `findings` and `outside` arrays contain candidate-id strings, never finding objects. Parallel workers do not read or reconcile one another's candidates.

## Verify, in verifiers

Call `list_candidates` for the assigned `run` and unit with `status: pending`. Verify every returned candidate against the reviewed source, principle advice and retained probes.
Call `resolve_candidates` as soon as the unit's decisions are ready:

- `confirmed` promotes the candidate to an undecided/unresolved finding;
- `plausible` does the same and requires the unresolved dependency in `reason`;
- `refuted` requires `proof` or `reason` and remains MCP calibration evidence, not a finding.

Use the optional `finding` correction only when verification changes author-facing fields, scope, priority or evidence. Confirmation never upgrades reasoned evidence to Proven. A newly discovered defect is created with `create_candidates` and immediately resolved; it is never staged on disk.
Correct every indexed error and call `list_candidates` again. The unit is complete only when it has no pending candidates.

Verification is not human triage. Leave promoted findings undecided and unresolved. Never set a human verdict or resolve a finding because technical verification refuted a candidate.

## Reconcile, in the coordinator

After all verifiers finish, require zero pending candidates for this `run` across every unit and call `list_findings`. Use `add_location` for another affected caller instead of creating a duplicate. Act on pre-existing-code notices by finding the causing edit or describing the defect as pre-existing.

On a complete review, call `baseline_check` once with every current finding anchor, including existing findings that still stand. On partial coverage, leave the baseline untouched.
Do not post PR comments, file rule issues, change product code, accept/dismiss findings or resolve them unless the user separately asks.
## Metadata findings

For PR titles, PR bodies or commit messages, submit immediately with an explicit metadata anchor: `{kind:"metadata", subject:"pr-title"|"pr-body"|"commit-message", file:"<authoritative HTTP(S) URL including a subject fragment>", line:1, text:"<full original text>"}`. Lines refer to the quoted metadata. Use distinct URLs/fragments for title and body. Include the commit SHA for commit messages when known. Never invent a source-file anchor or omit a candidate merely because the problem is metadata. The verifier checks the original metadata and advice just as it checks source findings.
