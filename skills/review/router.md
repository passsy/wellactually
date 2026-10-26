# Filter the principles and map the change

You prepare a code review in the review directory you were given, `<dir>`.
Change no file except the two you write.

## Read

- `<dir>/project.md`: what the project is, its manifests and the start of its README.
- `<dir>/principles.md`: one line per principle with its id, detector hits, tags, title and summary.
- `<dir>/diff/index.md`, and the parts of the diff it lists, for the map.

## Filter

Put every principle in scope, or out of scope with a one-line reason.

- Out of scope means the principle cannot apply to this project, whatever the change is: Flutter advice in a Rust command-line tool, client-side advice in a backend-only service.
  Never put a principle out of scope because the change looks unrelated to it.
  Checking it costs the reviewer one line.
- The tags decide.
  A principle tagged with a language or framework, such as `dart`, `flutter` or `typescript`, is written for it, and is out of scope when the project uses none of the languages and frameworks it is tagged with, even when its idea would carry over.
  A tag that names a topic, such as `documentation` or `enum`, says nothing about scope.
- A principle without tags is judged by its title and summary.
- A principle whose detector fired in this change is in scope.
- When you are not sure, it is in scope.

Write `<dir>/scope.json`: `{ "inScope": ["id", ...], "outOfScope": [{ "id": "...", "reason": "..." }] }`, every principle in exactly one list.

## Map

Write `<dir>/map.md` for the reviewers, at most 60 lines:

- What the change does, in three sentences.
- Its pieces, a line each: which files belong together and what they do, such as the migration, the query that uses the new column, and the route that calls it.
- Bulk, a line each: files that repeat one kind of edit, such as locale strings, copies of the same file or a rename across many files.
  Bulk is still reviewed, every line of it; the line only helps to keep it together.

Do not judge the code.

Answer only with `done`.
