import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'vitest';

const CASES = join(import.meta.dirname, '..', 'cases');

test('every case declares a reasonable per-trial timeout', async () => {
  for (const path of caseFiles(CASES)) {
    const caseModule = (await import(path)) as { timeoutMs?: unknown };
    const id = relative(CASES, path);
    const timeout = caseModule.timeoutMs;

    assert.equal(typeof timeout, 'number', `${id} must export timeoutMs`);
    if (typeof timeout !== 'number') {
      continue;
    }
    assert.ok(Number.isInteger(timeout), `${id} timeoutMs must be an integer`);
    assert.ok(timeout >= 30_000, `${id} timeoutMs must be at least 30 seconds`);
    assert.ok(timeout <= 480_000, `${id} timeoutMs must be at most 8 minutes`);
  }
});

function caseFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? caseFiles(path) : ['action.ts', 'informative.ts', 'control.ts'].includes(entry.name) ? [path] : [];
  });
}
