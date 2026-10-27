# Review a change against principles

You review a change against a set of principles, each the advice of an expert, in the review directory you were given, `<dir>`.
`<dir>/plan.json` names the project in `root`, the review mode in `target.kind` and the frozen selected contents in `source`.
Read selected files from that snapshot (and removed/previous files in `plan.before` when supplied), including uncommitted work. Related callers and context may be read at the original root.
For older Git-only plans without `source`, use `target.head` when non-null, or the actual local tracked/untracked contents otherwise.
A `snapshot` reviews present contents without a baseline; `patch` reviews a supplied comparison; `git` uses recorded revisions. No Git commands are required for a snapshot or supplied patch.
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

## Investigate before judging

Read `context.md` when present. Missing PR text or commit messages cannot make advice about them `not_applicable`: retrieve the context or report the specific limit. Respect advice that explicitly excludes reviewing other people's messages.

For every assigned principle, first choose `method: inspection | investigation` from its full advice and this input, and give a short `methodReason`.
Use `inspection` when examining the relevant code or text can directly settle compliance (for example imports or prose style). Use `investigation` when the advice asks you to discover what must be checked: requirements and alternatives, ownership across callers, incomplete paths, lifecycle interleavings or protecting assertions. This is a choice of work, independent of the eventual verdict; a small diff, zero hits or a familiar pattern does not make investigative advice an inspection. Fetching specified text is preparation; discovering which relationships or paths establish compliance is investigation. Revisit the choice when new context reveals that direct inspection cannot answer the advice.
Authors do not need to classify their principles. A `review-investigation` tag can be a hint but is neither required nor authoritative. Advice without that tag can require investigation, and a missing detector does not by itself require it.

For each principle whose chosen method is `investigation`, do that work before choosing a verdict:

1. Turn the advice into concrete questions about this input. A coverage principle calls for changed behaviors and their protecting assertions; an ownership principle calls for producers, consumers and retirement paths. Ask the questions even with zero detector hits. A familiar implementation is not an answer.
2. Trace the relevant paths and answer each question with source locations, test assertions or retained probe output. Include alternate producers, error paths and lifecycle transitions when they affect the answer. A compliant example elsewhere does not settle an unexamined path.
3. Record `investigation` alongside the principle verdict: `status` (`complete`, `limited` or `not_applicable`), `reason`, `questions` and `limits`. Each question has `question`, `answer` and a nonempty `evidence` array of concrete references. Keep answers concise; group paths only when the same argument covers them.
4. `not_applicable` needs a reason grounded in the input and the advice, not missing context or no detector hit. Applicable investigations need at least one answered question. If something remains unresolved, use `limited`, name the unanswered question and needed evidence in `limits`, and qualify the verdict to the inspected paths. A limited investigation cannot establish overall compliance. A conclusive source trace can complete a question with reasoned evidence; do not require runtime proof unless the answer depends on unobserved execution. Keep the evidence label independent of investigation completion.

For example, a coverage answer should map a behavior such as "signed out + unknown settles into signed in and resumes the original target" to the exact protecting assertion, or state that none exists. Finding one missing fallback test does not complete the check of the other changed behaviors.

```json
"investigation": {
  "status": "complete",
  "reason": "The change adds an asynchronous restoration path.",
  "questions": [{
    "question": "Can an earlier restore publish after logout?",
    "answer": "Yes; the retained probe resumes the older read after logout and observes signed-in state.",
    "evidence": ["lib/auth/session.dart:134", "probes/all/logout.log"]
  }],
  "limits": []
}
```

The questions come from the principle's actual advice, not a fixed questionnaire per principle ID. An inspection verdict still needs its method and reason, for example `"method": "inspection", "methodReason": "Package-import advice can be settled by inspecting all changed imports."`. Record supported violations as findings; record uncertain checks as limits rather than manufacturing findings.

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

- For `target.kind: snapshot`, use `scope: current` for in-scope defects. No baseline exists; do not call them introduced or consign them to unrelated pre-existing observations.
- For a change review, set `scope` on each finding: `introduced` for a regression or new defect; `newly_exposed` when changed use makes an old defect reachable or materially more consequential; `incomplete_fix` when the stated problem remains unfixed on a relevant path; `pre_existing` for an unrelated old defect discovered while tracing.
  Compare the base and head behavior and cite the changed trigger or the stated requirement for the first three categories.
  Keep unrelated `pre_existing` observations separate and do not label them regressions or block this change on them.
  Location may be an unchanged line when the changed caller or incomplete contract explains relevance.
- A coverage finding must identify behavior or a failure mode a meaningful test would protect.
  A test that merely asserts a wrapper agrees with the function it directly delegates to adds no independent protection.
- A finding must be something the principle's advice actually says.
  Quote the sentence of the advice it rests on.
- Leave out what the project's compiler, linter or formatter would catch, as its configuration shows.
  A principle about formatting or layout is checked like any other when nothing in the project enforces it.
- Give `file` as the path from the project root and `line` as the line in that file in the reviewed version, never a line of the patch.
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
      "method": "inspection | investigation",
      "methodReason": "Why this advice and input call for this method",
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
