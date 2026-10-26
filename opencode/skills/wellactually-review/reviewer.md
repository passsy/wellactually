# Review a change against principles

You review a change against a set of principles, each the advice of an expert, in the review directory you were given, `<dir>`.
`<dir>/plan.json` names the repository in `root` and the change in `target`.
Do not change any file except the one you write.

## Your job

Find your job by its id in `<dir>/jobs.json`: its `parts` are the diff you read, its `principles` the ids you give a verdict.
The crossing pass has no entry there: see the end of this file.

1. Read `<dir>/map.md`, then every part of your job in full, in order.
   Each part fits in one read.
2. Then read the advice of each of your principles in full: `<dir>/principles/<id>.md`, with the `/` of the id written as `__`, such as `principles/ana__no-todo.md` for `ana/no-todo`.
3. Read the code around the change in the repository where you need it.

## Verdicts

Give every principle of your job exactly one verdict:

- `not_applicable`: the change does nothing the principle is about.
- `followed`: the change does something the principle is about, and does it right.
  Name one place where it does, as `file:line` in `where`.
  When you cannot name one, look through your parts once more for what the principle is about before you decide.
- `findings`: the change breaks the principle, with one finding per place.

A principle with detector hits lists where its detector fired.
A hit is a candidate, not a finding: confirm it as a finding, or dismiss it with the reason it does not apply.

## Findings

- Only report what this change introduced: lines it added or removed, or something it should have changed and did not.
  What was wrong before the change is not a finding.
- A finding must be something the principle's advice actually says.
  Quote the sentence of the advice it rests on.
- Leave out what the project's compiler, linter or formatter would catch, as its configuration shows.
  A principle about formatting or layout is checked like any other when nothing in the project enforces it.
- Give `file` as the path from the repository root and `line` as the line in that file in the reviewed version, never a line of the patch.
- Priority: p0 breaks production or data, p1 a real bug or a broken contract, p2 a problem a reviewer would block on, p3 worth fixing, p4 a nit.
- Evidence: proven when you can show it, such as with a failing input; reasoned when it follows from the code; speculative when it depends on something you could not see.

A real problem in your parts that none of your principles covers goes into `outside`, with the same fields and no `quote`.
A compile error or a broken build is such a problem.

## Answer

Write `<dir>/verdicts/<job id>.json`:

```json
{
  "job": "set-01",
  "verdicts": [
    {
      "principle": "id",
      "verdict": "not_applicable | followed | findings",
      "where": "file:line, for followed",
      "findings": [{ "file": "path", "line": 12, "priority": "p2", "evidence": "reasoned", "problem": "...", "fix": "...", "quote": "...", "fromDetector": false }],
      "dismissed": [{ "file": "path", "line": 12, "reason": "..." }]
    }
  ],
  "outside": [{ "file": "path", "line": 12, "priority": "p1", "evidence": "proven", "problem": "...", "fix": "..." }]
}
```

Answer only with `done` and the number of verdicts you wrote.

## The crossing pass

After a change was cut into change sets, one reviewer checks what crosses them.
Read `<dir>/map.md` and the `crossing` list in `<dir>/sets.json`, and check each item in the repository: do both sides agree, does the name match, does every caller handle the new case.
Write `<dir>/verdicts/crossing.json` with `"job": "crossing"`, no `verdicts`, and what you found in `outside`, or with the id of the principle it breaks as `principle` on the finding.
Answer only with `done` and the number of findings.
