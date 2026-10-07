import type { FileMap } from "./bundle.ts";

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/**
 * The files of a new principle that already passes its check.
 *
 * The stub is a complete, working principle about a made up problem, so the
 * author starts from green and changes one thing at a time. The CLI writes
 * these to a directory and the website opens them in its editor.
 */
export function scaffoldFiles(slug: string): FileMap {
  if (!SLUG.test(slug)) {
    throw new Error(`"${slug}" must be 3 to 64 characters of a-z, 0-9 and dashes`);
  }
  const title = slug
    .split("-")
    .map((word, index) => (index === 0 ? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}` : word))
    .join(" ");

  return {
    "principle.md": `---
id: ${slug}
title: ${title}
summary: One sentence that says what to do instead, and why.
languages: [typescript]
events: [write]
globs: ["**/*.ts"]
---

# ${title}

Say what the problem is, in two or three sentences.
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
    "detector.ts": `import { writtenLines, type Ctx, type Finding } from "@wellactually/sdk";

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
