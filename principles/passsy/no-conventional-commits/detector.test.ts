import { expect, test } from "vitest";
import { command, detect, prompt } from "@wellactually/sdk/v3/test";

test.each([
  { line: `git add lib/auth.dart && git commit -m "feat(auth): add passkey login"`, subject: "feat(auth): add passkey login" },
  { line: `git commit --message='fix: crash on empty cart'`, subject: "fix: crash on empty cart" },
  { line: `git commit -m "fix: Explain the change"`, subject: "fix: Explain the change" },
  { line: `git commit -m "chore!: drop Dart 2 support"`, subject: "chore!: drop Dart 2 support" },
])("fires on a prefixed subject: $line", ({ line, subject }) => {
  expect(detect(command(line))).toEqual([{ match: subject }]);
});

test("fires on the subject of a heredoc message", () => {
  const line = `git commit -m "$(cat <<'EOF'\ndocs: explain the sync engine\n\nThe body.\nEOF\n)"`;
  expect(detect(command(line))).toEqual([{ match: "docs: explain the sync engine" }]);
});

test.each([
  `git commit -m "Add passkey login"`,
  `git commit -m "Router: stop dropping the query string"`,
  `echo "feat: this is not a commit" && git status`,
  `git log --oneline`,
])("stays quiet on %s", (line) => {
  expect(detect(command(line))).toEqual([]);
});

test("points at the principle when the user mentions conventional commits", () => {
  expect(detect(prompt("Should we switch to conventional commits?"))).toEqual([{ match: "conventional commits", depth: "pointer" }]);
});

test("stays quiet on a prompt about commits in general", () => {
  expect(detect(prompt("What are the last three commits about?"))).toEqual([]);
});
