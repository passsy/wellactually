/**
 * The case registry.
 *
 * Cases live at cases/<scenario>/<kind>.ts and are identified by that path.
 * A scenario is worth asking up to three things of: does the advice land when
 * it should (action), does it stay out of the way when the task was a question
 * (informative), and does it leave unrelated work alone (control).
 *
 * The id is the path, so `--case enum-style` selects a scenario and
 * `--case control` every control.
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { Case } from './types.ts';

export async function loadCases(root: string): Promise<Record<string, Case>> {
  return Object.fromEntries(
    await Promise.all(
      caseFiles(root).map(async (path: string) => {
        const module = (await import(path)) as Omit<Case, 'id'>;
        const id = relative(root, path).replace(/\.ts$/, '');
        return [id, { ...module, id }];
      }),
    ),
  );
}

/** Only these are cases. A principle's detector.ts beside a case is not one. */
const KINDS = new Set(['action.ts', 'informative.ts', 'control.ts']);

function caseFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      return caseFiles(path);
    }
    return KINDS.has(entry.name) ? [path] : [];
  });
}

/** Expand `--case` selectors (path prefixes) into concrete case ids. */
export function selectCases(
  cases: Record<string, Case>,
  selectors: string[],
): { matched: string[]; unmatched: string[] } {
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const selector of selectors) {
    const ids = Object.keys(cases).filter(
      (id) => id === selector || id.startsWith(`${selector}/`),
    );
    if (ids.length === 0) {
      unmatched.push(selector);
    }
    matched.push(...ids);
  }
  return { matched, unmatched };
}
