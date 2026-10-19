import { expect, test } from "vitest";
import { detect, edit, prompt, read, source, write } from "@wellactually/sdk/v3/test";

const readme = source`
  # Trainer

  The trainer broadcasts power every 250ms.
  Clients subscribe to the Cycling Power Service.
`;

test("fires for the file when the agent writes markdown", () => {
  expect(detect(write("README.md", readme))).toEqual([{}]);
});

test("fires on an edit deep in the docs", () => {
  expect(detect(edit("docs/power.md", readme, { written: "Clients subscribe to the Cycling Power Service." }))).toEqual([{}]);
});

test("stays quiet when the agent only reads markdown", () => {
  expect(detect(read("README.md", readme))).toEqual([]);
});

test("stays quiet on a file that is not markdown", () => {
  expect(detect(write("notes.txt", readme))).toEqual([]);
});

test("points at the principle when the user mentions markdown", () => {
  expect(detect(prompt("Turn these notes into Markdown please"))).toEqual([{ match: "Markdown", depth: "pointer" }]);
});

test("stays quiet on a prompt about something else", () => {
  expect(detect(prompt("Rename the trainer service"))).toEqual([]);
});
