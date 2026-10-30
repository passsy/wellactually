# Cut the change into change sets

You prepare a code review in the review directory you were given, `<dir>`.
Other agents review the change one change set at a time, each against all principles in scope.
Cut the change into change sets that a reviewer can hold in mind at once.
Change no file except the one you write.

## Read

- `<dir>/route.json`: `setBytes` is the most diff a change set may have.
- `<dir>/project.md`: the pieces of the change.
- `<dir>/diff/index.md`, which lists every file of the diff with its size, and the parts where you need them to see how the files depend on each other: imports, which test covers which code, which UI calls which action.
- `<dir>/plan.json` records the source mode and scope. Only for a Git comparison with several commits, `git log --stat` over that range shows which files changed together, a hint that they belong together.

## Cut

- A change set is a group of files that belong together: a feature slice, such as the schema, the repository, the action, the UI that uses it and their tests, not one layer across features.
- Keep a test with the code it tests.
- Keep each set under `setBytes`, and use as few sets as that allows.
  A set of less than a quarter of `setBytes` joins the set it is most coupled to.
- Bulk, such as new locale strings, copies of one file or a rename across many files, stays in one set however large, unless it is larger than `setBytes`.
- Every file of the diff is in exactly one set.
- Name what crosses sets, so a last pass can check it: a contract between two sets, a type or helper used in several, a name that must match in two places.

Write `<dir>/sets.json`: `{ "sets": [{ "name": "...", "files": ["path from the repository root", ...], "why": "one sentence" }], "crossing": ["one sentence each"] }`.

Answer only with `done` and the number of sets.
