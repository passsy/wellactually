import { API_VERSION } from "@wellactually/sdk";
import type { FileMap } from "./bundle.ts";
import { isPrincipleId, PRINCIPLE_ID_RULE } from "./manifest.ts";

/**
 * The files of a new principle that already passes its tests.
 *
 * The stub is a complete, working principle about a made up problem, so the
 * author starts from green and changes one thing at a time. The CLI writes
 * these to a directory and the website opens them in its editor.
 */
export function scaffoldFiles(slug: string): FileMap {
  if (!isPrincipleId(slug)) {
    throw new Error(`"${slug}" must be ${PRINCIPLE_ID_RULE}`);
  }
  const title = slug
    .split("-")
    .map((word, index) => (index === 0 ? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}` : word))
    .join(" ");

  return {
    "principle.md": `# ${title}

One sentence that says what to do instead, and why.

The heading above is the title and that first sentence is the summary shown in lists.
From here on, say what the problem is.
An agent reads this in the middle of a task, so lead with what to do.

## Instead

\`\`\`ts
// Bad
// FIXME: handle the empty list

// Good
if (items.length === 0) {
  return [];
}
\`\`\`

## When it is fine

Name the cases where the principle does not apply.
The detector should stay quiet on exactly those, and a test should prove it.
`,
    "detector.ts": `import { writtenLines, type Ctx, type EventName, type Finding } from "@wellactually/sdk/v${API_VERSION}";

/** When the detector runs: write, read, prompt, command. */
export const events: EventName[] = ["write"];

/** Which files it runs on. Leave the list empty for every file. */
export const globs = ["**/*.ts"];

/**
 * Runs inside an isolate: no network, no process, nothing to write to.
 * It gets a context and yields findings. Evidence must be text from the input.
 * It can read the files of the project with node:fs, from ctx.file.path.
 *
 * Replace this stub. It flags a FIXME comment the agent writes.
 */
export function* detect(ctx: Ctx): Generator<Finding> {
  // Only lines the agent wrote. Code that was already there stays unjudged.
  for (const written of writtenLines(ctx)) {
    if (/\\/\\/\\s*FIXME\\b/.test(written.text)) {
      yield { line: written.line, evidence: written.text.trim() };
    }
  }
}
`,
    "detector.test.ts": `import { expect, test } from "vitest";
import { detect, edit, source, write } from "@wellactually/sdk/v${API_VERSION}/test";

// Run with vitest, for example through npm test. The registry runs the same file again.
// A test builds the event a detector receives and checks what it reports.
// write() is a file the agent wrote in full, edit() one it changed, and there
// are read(), prompt() and command() as well.

const code = source\`
  export function total(items: number[]): number {
    // FIXME: handle the empty list
    return items.reduce((sum, item) => sum + item);
  }
\`;

test("fires on a FIXME the agent writes", () => {
  expect(detect(write("src/total.ts", code))).toEqual([{ line: 2, evidence: "// FIXME: handle the empty list" }]);
});

test("stays quiet on a FIXME that was already there when the agent edits another line", () => {
  expect(detect(edit("src/total.ts", code, { written: "  return items.reduce((sum, item) => sum + item);" }))).toEqual([]);
});

test("stays quiet on an ordinary comment", () => {
  expect(detect(write("src/total.ts", "// An empty list sums to zero.\\nexport const total = 0;"))).toEqual([]);
});

test("stays quiet in other languages", () => {
  // The globs in detector.ts do not select this file, so the detector never runs.
  expect(detect(write("total.py", "# FIXME: this is Python"))).toEqual([]);
});
`,
  };
}
