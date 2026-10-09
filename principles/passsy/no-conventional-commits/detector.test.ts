import { expect, test } from "vitest";
import { command, detect } from "@wellactually/sdk/v2/test";

test.each([
  `git add lib/auth.dart && git commit -m "feat(auth): add passkey login"`,
  `git commit --message='fix: crash on empty cart'`,
])("fires on a prefixed subject: %s", (line) => {
  expect(detect(command(line))).toHaveLength(1);
});

test.each([
  `git commit -m "Add passkey login"`,
  `git commit -m "Router: stop dropping the query string"`,
  `echo "feat: this is not a commit" && git status`,
])("stays quiet on %s", (line) => {
  expect(detect(command(line))).toEqual([]);
});
