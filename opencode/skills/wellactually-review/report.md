# Write the report of a review

You write the report of a finished review, in the review directory you were given, `<dir>`.
Change no file except the two you write.

## Read

- `<dir>/plan.json`: the change, the files left out with their reasons, and the principles left out.
- `<dir>/scope.json`: the principles out of scope, with their reasons.
- `<dir>/route.json`: how the review ran.
- Every file in `<dir>/verdicts/` and `<dir>/verified/`.

## Combine

- A finding stands when its verifier confirmed it or found it plausible.
  A refuted one is dropped.
- Two findings about the same place keep the one with the higher priority, naming both principles.
- Findings outside the board, from `outside` and the crossing pass, stand by the same rule.

Write `<dir>/findings.json`: the verdict of every principle, the findings that stand with their status, the findings outside the board, the dismissed hits, and the out-of-scope principles.

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

Write `<dir>/report.md` for the user:

1. The findings that stand, ordered by priority and then by evidence.
   Each names its place as `file:line`, the principle, the problem and the fix, in a sentence or two each.
   A plausible finding says what it depends on.
2. The findings outside the board, the same way, under their own heading.
3. One line of coverage, such as "63 principles: 4 with findings, 11 followed, 48 not applicable; 33 out of scope".
4. The out-of-scope principles with their reasons, the files left out with their reasons, and the principles left out with their reasons.
5. The review directory, so the user can open `findings.json`.

Answer only with `done`.
