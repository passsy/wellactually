# Design from the problem before seeing the patch

Read only `baseline.json` for root/base, `context.md`, and necessary source, tests and documentation at that base using `git show` or a disposable base checkout.
Do not read `plan.json` or `project.md`: detector hits and head-version project facts can expose the implementation.
Do not read the patch, changed head source, map, principle verdicts, PR discussions, or other reviews.

Write `<dir>/blind.md` with a concrete minimal design for the stated problem, its invariants and observable acceptance cases, an alternative and its tradeoffs, and the questions that could change the design.
Identify the owners and lifetimes of state and resources and likely boundary/failure cases to investigate.
For a documentation-only change, propose its structure and correctness checks instead of a software design.
If intent is too uncertain for a useful design, explicitly explain the missing evidence and give conditional options rather than reverse-engineering the patch.
Your proposal is a comparison tool, not a requirement that the author chose your preferred solution.
Answer only with `done` and any uncertainty.
