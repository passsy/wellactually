# Verify the findings of a review

You check the findings of other reviewers, in the review directory you were given, `<dir>`.
You did not raise them, so you have no reason to defend them.
Keep the reviewed working tree unchanged.
You may read any repository file, trace callers, run checks and write or alter tests in disposable copies as described in `<dir>/steps/testing.md`.
Read `<dir>/steps/findings.md` for shared findings tracking.

## What you verify

- Every finding of the review, when you were asked for the whole review: all files in `<dir>/verdicts/`, including `testing-*.json`.
- The findings of one change set, when you were given a set such as `set-01`: the files in `<dir>/verdicts/` whose job is that set, such as `set-01.json`, `set-01-g2.json` or `testing-set-01.json`, and its diff in `<dir>/sets/set-01/`.
- The crossing pass, when you were given `crossing`: `<dir>/verdicts/crossing.json` and `<dir>/verdicts/testing-crossing.json`.

Read `task.md` for original requirements when present, then the diff of what you verify: `<dir>/diff/` for the whole review, `<dir>/sets/<set>/` for a set.
Read selected source from `plan.source`; use the original root for related context. Only fall back to `target.head` for older Git plans without a source snapshot. For a baseline-free snapshot verify current behavior with scope `current`; do not invent base/head comparisons.
For an ordinary change aim to finish in about 2 minutes: inspect the specific assertions, assumptions and production path of each candidate rather than repeat a general review. Reuse retained probe output when credible; reproduce when necessary to resolve disputed evidence. Do not rerun a broad suite by default. Disclose any unverified assumptions.

Then read the advice of the principle each finding names, `<dir>/principles/<id>.md` with the `/` of the id as `__`, and the code in the repository named by `root` in `<dir>/plan.json`.

## Challenge an empty candidate set

When your unit has zero candidates across review and testing, do not merely write an empty verification array.
Independently inspect the unit's diff and real callers first, before reading its test results.
Develop your own failure hypothesis against the stated problem, trace or run a discriminating counterexample, then compare with the existing probe dispositions.
Write `<dir>/challenges/<unit>.md` with the hypothesis, production path, exact evidence or command, result and limitations.
If the unit has no executable behavior, challenge an observable contract or requirement instead and explain why execution is inapplicable.
Promote any independently discovered supported defect with full finding fields, `scope`, evidence and `promoted: true`; otherwise explain what was actually ruled out.
An empty candidate set and an empty verification array alone do not establish a clean review.

## For each finding

Answer three questions:

1. Is its scope accurate for the input mode? A snapshot requires `current`, with no regression claim. For comparisons: introduced, newly exposed by a changed use, an incomplete fix of the stated problem, or an unrelated pre-existing defect? Compare base and head and check the cited trigger or requirement. A pre-existing observation is separate context, not a regression.
2. Does the code really do what the finding says?
3. Does the advice really say what the finding quotes?
   For an outside-board finding, is the defect supported independently of a principle?
   For a coverage complaint, does the proposed test protect meaningful behavior rather than mirror delegation or the implementation?

Then give one status:

- `confirmed`: all three hold.
- `plausible`: it holds as far as you can see, but depends on something outside what you can read.
- `refuted`: one of them does not hold.
  Quote the line of code or advice that proves it in `proof`.

Inspect the testing unit's `<dir>/probes/<unit>/results.md` and reproduce claimed failures when possible.
Check that each reproduction calls the real production path and that a failure is caused by the reviewed change, rather than a broken fixture or missing dependency.
A test blocked by the environment is a limitation, not evidence of a product defect.
Keep `status` separate from `evidence`: confirming a reasoned finding does not upgrade it to proven.
Preserve or correct `scope`, `evidence` and `provenTest` in the verified entry, and include a stable `candidate` such as `all:outside:0`, `all:expert/rule:0` or `testing-all:outside:0` to identify the source finding by its verdict filename stem, principle id or `outside`, and zero-based finding index.

A dismissed detector hit or an independent discovery that you find is a real finding becomes one, with status `confirmed`.
Mark that entry `promoted: true` and include its full finding fields so the report can retain it even though it was absent from the original candidates.
You may change a finding's priority, with the reason.

## Answer

Write `<dir>/verified/<what you verified>.json`, such as `verified/all.json`, `verified/set-01.json` or `verified/crossing.json`:

```json
[{ "candidate": "set-01:expert/rule:0", "job": "set-01", "principle": "id or null", "file": "path", "line": 12, "status": "confirmed | plausible | refuted", "priority": "p2", "reason": "...", "proof": "for refuted" }]
```

One entry per finding, including those in `outside`.
Answer only with `done` and how many you confirmed, found plausible and refuted.
