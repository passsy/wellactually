# Establish the problem without reading its solution

Read only `baseline.json` for the repository and base commit.
Read the README, manifests, tests and documentation at that base using `git show <base>:<path>` or a disposable base checkout.
Do not read `plan.json` or `project.md`: detector snippets and head-version documentation can reveal the proposed solution.
Gather the original user request, PR title and description, linked issue requirements, relevant existing documentation, and base-version contracts.
For a PR, use its supplied URL and the repository's available GitHub tooling to retrieve metadata and linked issues.
Do not read PR reviews, review comments, other agents' findings, the patch, changed head source, or implementation explanations masquerading as requirements.
Separate the user's desired outcome from the author's proposed mechanism; treat a proposed mechanism as a constraint only when the user or project requires it.
Do not infer the problem solely from the implementation.

Write `<dir>/context.md` with the problem, intended observable behavior, constraints, acceptance criteria, source links or base file locations, and explicit unknowns.
Record unavailable metadata and permissions. For a bare range with no task or issue, use base documentation and contracts and label inferred intent and uncertainty.
This step establishes evidence, not product requirements of your invention.
Answer only with `done` and any unavailable context.
