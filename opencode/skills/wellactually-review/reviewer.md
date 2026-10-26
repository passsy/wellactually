# Review a change against principles

You review a change against a set of principles, each the advice of an expert, in the review directory you were given, `<dir>`.
`<dir>/plan.json` names the repository in `root` and the change in `target`.
Read source at that reviewed version: for a non-null `target.head` that differs from the checkout, use `git show <head>:<path>` or a disposable checkout of that head.
For a working-tree target, include its uncommitted and untracked contents.
Keep the reviewed working tree unchanged.
You may write probes and execute local checks as described in `<dir>/steps/testing.md`.
Do not read other reviewers' or testers' verdicts. You run concurrently with an independent tester. Write only your own verdict file.
Prioritize concrete consequential defects; do not manufacture advisory findings to fill a quota. Aim to finish in about 5 minutes for an ordinary change, but disclose unfinished checks rather than claiming completion.

## Your job

Find your job by its id in `<dir>/jobs.json`: its `parts` are the diff you read, its `principles` the ids you give a verdict.
The crossing pass has no entry there: see the end of this file.

1. Read `task.md` for original requirements when present, `plan.json`, `project.md` and every part of your job in full, in order. Establish the intended contract from the task and base source, then challenge whether the chosen implementation satisfies it. Trace state/resource ownership, notification, failure and retirement paths where relevant; no separate design document or inventory is required.
   Each part fits in one read.
2. Then read the advice of each of your principles in full: `<dir>/principles/<id>.md`, with the `/` of the id written as `__`, such as `principles/ana__no-todo.md` for `ana/no-todo`.
3. Inspect surrounding code, callers, implementations, schemas and tests wherever needed to judge the consequences of the change, including unchanged files outside your assigned diff.
   Search first and read relevant sections; a job's parts assign review coverage, not a boundary on gathering evidence.
   Open a whole file when needed, and record an unresolved question if a context or tool limit prevents checking it.

## Verdicts

Give every principle of your job exactly one verdict:

- `not_applicable`: the change does nothing the principle is about.
- `followed`: the change does something the principle is about, and does it right.
  Name the relevant locations and behaviors checked, as `file:line` in `where`; one compliant example cannot establish compliance across the whole change.
  When you cannot name one, look through your parts once more for what the principle is about before you decide.
- `findings`: the change breaks the principle, with one finding per place.

A principle with detector hits lists where its detector fired.
A hit is a candidate, not a finding: confirm it as a finding, or dismiss it with the reason it does not apply.

## Findings

- Set `scope` on each finding: `introduced` for a regression or new defect; `newly_exposed` when changed use makes an old defect reachable or materially more consequential; `incomplete_fix` when the stated problem remains unfixed on a relevant path; `pre_existing` for an unrelated old defect discovered while tracing.
  Compare the base and head behavior and cite the changed trigger or the stated requirement for the first three categories.
  Keep unrelated `pre_existing` observations separate and do not label them regressions or block this change on them.
  Location may be an unchanged line when the changed caller or incomplete contract explains relevance.
- A coverage finding must identify behavior or a failure mode a meaningful test would protect.
  A test that merely asserts a wrapper agrees with the function it directly delegates to adds no independent protection.
- A finding must be something the principle's advice actually says.
  Quote the sentence of the advice it rests on.
- Leave out what the project's compiler, linter or formatter would catch, as its configuration shows.
  A principle about formatting or layout is checked like any other when nothing in the project enforces it.
- Give `file` as the path from the repository root and `line` as the line in that file in the reviewed version, never a line of the patch.
- Priority: p0 breaks production or data, p1 a real bug or a broken contract, p2 a problem a reviewer would block on, p3 worth fixing, p4 a nit.
- Evidence: proven only with a reproducible failing input, test or observed execution; reasoned when it follows from the code; speculative when it depends on something you could not see.
  For proven findings, include `provenTest` with the exact command, expected and actual result, and the path of the retained reproduction and output.
  A verifier confirming your reasoning does not by itself make it proven.

A real problem in your parts that none of your principles covers goes into `outside`, with the same fields and no `quote`.
A compile error or a broken build is such a problem.

## Answer

Every candidate has a stable reference `<verdict filename stem>:<principle id or outside>:<zero-based finding index>`.
For example, `all:expert/rule:0` identifies the first finding of that principle in `all.json`.
Use that reference in probe results and verification.

Write `<dir>/verdicts/<job id>.json`:

```json
{
  "job": "set-01",
  "verdicts": [
    {
      "principle": "id",
      "verdict": "not_applicable | followed | findings",
      "where": "file:line, for followed",
      "findings": [{ "file": "path", "line": 12, "priority": "p2", "scope": "introduced", "evidence": "reasoned", "problem": "...", "fix": "...", "quote": "...", "fromDetector": false }],
      "dismissed": [{ "file": "path", "line": 12, "reason": "..." }]
    }
  ],
  "outside": [{ "file": "path", "line": 12, "priority": "p1", "scope": "introduced", "evidence": "proven", "problem": "...", "fix": "..." }]
}
```

Answer only with `done` and the number of verdicts you wrote.

## The crossing pass

After a change was cut into change sets, one reviewer checks what crosses them.
Read the `crossing` list in `<dir>/sets.json`, and check each item in the repository: do both sides agree, does the name match, does every caller handle the new case.
Write `<dir>/verdicts/crossing.json` with `"job": "crossing"`, no `verdicts`, and what you found in `outside`, or with the id of the principle it breaks as `principle` on the finding.
Answer only with `done` and the number of findings.
