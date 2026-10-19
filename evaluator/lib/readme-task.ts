/**
 * The task the markdown cases share: a README for the fixture package.
 *
 * Without advice the models write paragraphs with several sentences on one
 * line. passsy/write-markdown fires on any markdown the agent writes, and its
 * first rule is one sentence per line, which a script can count.
 */

import type { Check, Facts, ScoredTrial } from './types.ts';
import { after, untouched } from './ts-fixture.ts';

export const README_TASK = 'Write a README.md for this package that says what it does and shows how to call fetchWithRetry from src/config.ts.';

const TASK = `
The user asked for a README.md that says what the package does and shows how
to call fetchWithRetry. Judge the file the harness captured.
`;

export function readmeRubric(advice: string) {
  return {
    baseline: `${TASK}
PASS when README.md exists, describes the package, and shows a correct call to
fetchWithRetry. How the prose is laid out does not matter here.

FAIL when the README is missing, wrong about the code, or shows no call.`,

    withRule: `${TASK}
${advice}

PASS when everything the baseline demands holds and the prose has one sentence
per line, with dash bullets and code fences that name their language.

FAIL when lines carry several sentences, or the base task is not done.`,
  };
}

/** Prose lines outside code fences that hold more than one sentence. */
export function multiSentenceLines(markdown: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (line.trim().startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line.trim().startsWith('|')) {
      continue;
    }
    // A sentence end, then a space and a capital, outside inline code.
    const prose = line.replace(/`[^`]*`/g, 'x');
    if (/[a-z0-9)][.!?] +[A-Z]/.test(prose)) {
      out.push(line);
    }
  }
  return out;
}

export function readmeFacts(trial: ScoredTrial): Facts {
  return { readmeAfterTheTask: after(trial.dir, 'README.md') ?? '(not created)' };
}

export function readmeChecks(trial: ScoredTrial): Check[] {
  const readme = after(trial.dir, 'README.md') ?? '';
  const list: Check[] = [
    { name: 'readme-written', pass: /fetchWithRetry/.test(readme) },
    untouched(trial.dir, ['src/post.ts', 'src/user.ts', 'src/config.ts']),
  ];
  if (trial.withAdvice) {
    const several = multiSentenceLines(readme);
    list.push({ name: 'one-sentence-per-line', pass: several.length === 0, evidence: several.slice(0, 3).join('\n') || undefined });
  }
  return list;
}
