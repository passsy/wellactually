# Write the report of a review

You write the report of a finished review, in the review directory you were given, `<dir>`.
Write `findings.json` and the tracking files described in `<dir>/steps/findings.md`.
Use the findings MCP when available, following that file; its tool-managed records are separate from the review's intermediate JSON.

## Read

- `<dir>/plan.json`: the change, the files left out with their reasons, and the principles left out.
- `<dir>/scope.json`: the principles out of scope, with their reasons.
- `<dir>/route.json`: how the review ran.
- `context.md`, `blind.md`, every unit in `investigation/`, the test results and any empty-set challenge in `challenges/`.
- Every file in `<dir>/verdicts/` and `<dir>/verified/`.

## Combine

- Match verification to the source candidate id, not just its file and line.
- A finding stands when its verifier confirmed it or found it plausible.
  A refuted one is dropped.
- Merge duplicates only when they describe the same defect, keeping the strongest evidence and naming every relevant principle.
  Independent defects on the same line stay separate.
- Candidates from testing and the crossing pass stand by the same verification rule.
  A surviving candidate with a principle id belongs to that principle, even when it arrived in `outside`.
  Upgrade its final principle verdict to `findings`; only candidates with no principle belong outside the board.

Check that every job has every required principle verdict, every testing unit has a result, and every candidate has a verifier entry.
When anything is missing, report the review as incomplete and name the missing work; do not claim clean coverage or run a complete baseline check.

Write `<dir>/findings.json` with this shape:

```json
{
  "complete": true,
  "verdicts": [{ "principle": "expert/rule", "verdict": "findings | followed | not_applicable" }],
  "findings": [],
  "outside": [],
  "dismissed": [],
  "outOfScope": []
}
```

`verdicts` has exactly one entry per unique principle assigned across all jobs, merging per-set verdicts.
`findings` contains the surviving principle findings, and `outside` the surviving findings with no principle.
Retain source candidate references, location, priority, scope, evidence, verification status, problem, fix, advice quote and reproduction evidence on each finding.
Use `candidate` for one source or `candidates` for an array of sources merged as the same defect.
Every confirmed or plausible candidate must be represented once; no refuted candidate may survive.
A promoted verifier finding uses `verified/<unit>.json:<zero-based entry index>` as its source reference.
Include MCP ids after tracking when available.
Keep dismissed hits and out-of-scope principles with their reasons.
Set `complete` to false for missing coverage, missing artifacts or unfinished verification; blocked test execution is disclosed as a limitation in its test result, and must not be described as a passing test.

Keep reproduction commands and artifacts with proven findings.
Record the findings that stand in the findings MCP, and finish its baseline only for a complete review, as `findings.md` describes.

## Rate

Tell each principle's expert how it went, once per principle, with the MCP tool whose name ends in `rate_principle`; search your tools for that word if it is not loaded:

- `up` when a finding of it stood.
- `not_applicable` when its detector fired in this change and every hit was dismissed because it matched something the advice is not about.
  A hit on something the advice is about, where the change already follows it, is no reason to rate.
- Nothing for a verdict of `not_applicable` or `followed`, and nothing for a refuted finding of a principle without a detector.
  That was the reviewer's mistake, not the advice's.

Principles whose id starts with `local/` are not rated.
When the tool says the machine is not signed in, as on a CI runner without a token, write once in the report that ratings were not sent.

## Report

Answer with the report for the user, as Markdown, and nothing else:

1. The change-relevant findings that stand (`introduced`, `newly_exposed`, `incomplete_fix`), ordered by priority and then by evidence, each explicitly labeled with its scope.
   Put unrelated `pre_existing` observations in a separate informational section and do not count them as regressions or blockers.
   Each names its place as `file:line`, the principle, the problem and the fix, in a sentence or two each.
   A plausible finding says what it depends on.
2. The findings outside the board, the same way, under their own heading.
3. Summarize the problem/design comparison, ownership and branch/test coverage work, including unresolved hypotheses and independent empty-set challenges.
   One line of principle coverage, such as "63 principles: 4 with findings, 11 followed, 48 not applicable; 33 out of scope".
4. The out-of-scope principles with their reasons, the files left out with their reasons, and the principles left out with their reasons.
5. Tests and counterexamples run, with their result, and any unavailable tools or unverified behavior.
6. The review directory, so the user can open `findings.json`, and the findings MCP target when tracking is available.
