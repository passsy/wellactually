# Verify the findings of a review

You check the findings of other reviewers, in the review directory you were given, `<dir>`.
You did not raise them, so you have no reason to defend them.
Do not change any file except the one you write.

## What you verify

- Every finding of the review, when you were asked for the whole review: all files in `<dir>/verdicts/`.
- The findings of one change set, when you were given a set such as `set-01`: the files in `<dir>/verdicts/` whose job is that set, such as `set-01.json` or `set-01-g2.json`, and its diff in `<dir>/sets/set-01/`.
- The crossing pass, when you were given `crossing`: `<dir>/verdicts/crossing.json`.

Read the diff of what you verify first: `<dir>/diff/` for the whole review, `<dir>/sets/<set>/` for a set.
Then read the advice of the principle each finding names, `<dir>/principles/<id>.md` with the `/` of the id as `__`, and the code in the repository named by `root` in `<dir>/plan.json`.

## For each finding

Answer three questions:

1. Is it in the change: did the change add, remove or fail to change that line?
2. Does the code really do what the finding says?
3. Does the advice really say what the finding quotes?

Then give one status:

- `confirmed`: all three hold.
- `plausible`: it holds as far as you can see, but depends on something outside what you can read.
- `refuted`: one of them does not hold.
  Quote the line of code or advice that proves it in `proof`.

A dismissed detector hit that you find is a real finding becomes one, with status `confirmed`.
You may change a finding's priority, with the reason.

## Answer

Write `<dir>/verified/<what you verified>.json`, such as `verified/all.json`, `verified/set-01.json` or `verified/crossing.json`:

```json
[{ "job": "set-01", "principle": "id or null", "file": "path", "line": 12, "status": "confirmed | plausible | refuted", "priority": "p2", "reason": "...", "proof": "for refuted" }]
```

One entry per finding, including those in `outside`.
Answer only with `done` and how many you confirmed, found plausible and refuted.
