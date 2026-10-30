# Findings tracking shared by review workers

Intermediate verdict and verification JSON is the review's coverage and handoff data.
When findings MCP tools are available, use them for durable finding records and the review inbox.
Discover tools by capability, such as `start_review`, `list_findings`, `create_finding`, `update_finding`, `add_location` and `baseline_check`, rather than assuming a server prefix.
Use the schemas the host exposes; do not run a made-up shell substitute or hand-edit the MCP's storage.
When the tools are absent or fail, retain the JSON results and report tracking as unavailable.

## Initialize, in the coordinator

Read `plan.json` and use its absolute `root` as `repo` on every MCP call.
Choose one stable `target` for this review: `pr-<number>` for a pull request, otherwise the branch or range under review, or `local-changes` for a working tree review.
Call `start_review` with a base only when one exists, and any known PR facts, and `list_findings` for that target.
Write `<dir>/tracking.json` with `repo`, `target` and availability, and retain the same target in every later stage.
Do not invent PR facts from a local branch name.

## Investigate, in reviewers, testers and verifiers

Write candidates and evidence to stage JSON. Do not read prior reviews or another concurrent worker's results. The coordinator alone reconciles durable findings after verification, so parallel workers do not race to record the same problem.

For a file/folder/project snapshot, use a descriptive target and do not fabricate Git/PR facts. If the installed findings MCP requires Git or cannot anchor the selected input, record tracking as unavailable and retain the review artifacts. Do not initialize a repository or let optional inbox support block the review.

## Record, in the coordinator

List existing findings again before writing.
For each verified finding that stands, create it once or update the matching existing finding.
Include the reviewed anchor, priority, principle id as `rule` when present, advice quote, explanation, proposed fix, verification status and evidence.
Preserve the verified `title`. Build the author-facing body from `problem` and `fix` as separate paragraphs; do not append advice quotes, audit narration or local evidence paths to that prose. Keep them in the MCP metadata/evidence fields where supported, otherwise retain them in the linked review artifacts.
For a committed target, pass the reviewed commit in the anchor when the MCP supports it.
If the MCP can only capture the current checkout and it differs from the target, use a disposable reviewed checkout as `repo` consistently or report tracking as unavailable for that target; never record source from the wrong version.
Map `proven`, `reasoned`, `speculative` to the evidence values the tool accepts, such as `Proven`, `Reasoned`, `Speculative`.
Supply `provenTest` for demonstrated failures, serialized as text if the tool expects a string, retaining the exact command, results and artifact paths.
Preserve the returned MCP id in `findings.json`; use `add_location` for another affected caller or the causing edit instead of creating a duplicate.
Act on any pre-existing-code notice by locating the edit that causes the defect, or clearly disclose that it predates the change and leave it out of introduced findings.

Verification is not human triage.
Leave findings undecided and unresolved; never set a human verdict or resolve a finding because a verifier refuted it.
A refuted existing candidate can have its explanation and evidence corrected, without changing the human's decision.
Do not file rule issues, publish PR comments or change product code as part of tracking.
Only after complete coverage, call `baseline_check` once with every current finding anchor for this target, including existing findings that still stand.
On a partial review, report the missing coverage and leave the baseline untouched.
