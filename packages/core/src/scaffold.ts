import type { FileMap } from "./bundle.ts";
import { isPrincipleId, PRINCIPLE_ID_RULE } from "./manifest.ts";

/**
 * The files of a new principle that already passes its check.
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
The detector should stay quiet on exactly those, and a quiet case should prove it.
`,
    "detector.ts": `import { writtenLines, type Ctx, type EventName, type Finding } from "@wellactually/sdk";

/** When the detector runs: write, read, prompt, command. */
export const events: EventName[] = ["write"];

/** Which files it runs on. Leave the list empty for every file. */
export const globs = ["**/*.ts"];

/**
 * Runs inside an isolate: no filesystem, no network, no process.
 * It gets a context and yields findings. Evidence must be text from the input.
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
    "cases/fires-on-fixme.ts": `export function total(items: number[]): number {
  // FIXME: handle the empty list
  return items.reduce((sum, item) => sum + item);
}
`,
    "cases/quiet-on-plain-comment.ts": `export function total(items: number[]): number {
  // An empty list sums to zero.
  return items.reduce((sum, item) => sum + item, 0);
}
`,
    "cases/quiet-on-other-language.py": `# FIXME: this is a Python file, which the globs do not select
total = sum(items)
`,
    "cases/expect.json": `{
  "fires-on-fixme.ts": { "lines": [2] }
}
`,
  };
}
