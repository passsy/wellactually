import { expect, test } from "vitest";
import { command, detect, prompt } from "@wellactually/sdk/v3/test";

test("points at the principle when the user asks for a commit", () => {
  expect(detect(prompt("commit these changes"))).toEqual([{ match: "commit", depth: "pointer" }]);
});

test.each(["What are the last three commits about?", "Amend the last change", "run the pre-commit hook"])("stays quiet on the prompt %s", (text) => {
  expect(detect(prompt(text))).toEqual([]);
});

test("fires in full on an upcoming git commit -m", () => {
  expect(detect(command("git commit -m 'Explain the change'"))).toEqual([{ match: "git commit -m" }]);
});

test("fires on git commit -m after git add", () => {
  expect(detect(command('git add lib && git commit -m "Add passkey login"'))).toEqual([{ match: "git commit -m" }]);
});

test.each(["git log --oneline", "git commit --amend", "printf '%s\\n' 'git commit -m is the documented form'"])("stays quiet on the command %s", (line) => {
  expect(detect(command(line))).toEqual([]);
});
