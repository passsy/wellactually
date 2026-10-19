import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { solve } from './solve.ts';
import type { Case, Harness, Injection } from './types.ts';

/**
 * A harness that never spawns a CLI: it plays the agent by editing the
 * workspace and returning a canned answer. What is under test is everything
 * around the agent — fixture build, git isolation, truth persistence, the
 * injection marker discipline.
 */
function stubHarness(behave: (dir: string, injection: Injection) => void): Harness {
  let seen: Injection | null = null;
  return {
    id: 'stub',
    defaultModel: 'stub-1',
    prepare: (dir, injection) => {
      seen = injection;
    },
    run: (request) => {
      behave(request.dir, seen as Injection);
      return Promise.resolve({
        ok: true,
        text: 'done',
        model: 'stub-1-resolved',
        agentVersion: 'stub 0.0.1',
      });
    },
  };
}

function caseFor(): Case {
  return {
    id: 'demo/one/action',
    axis: 'action',
    principles: [],
    prompt: 'edit the file',
    timeoutMs: 60_000,
    build: (dir) => {
      writeFileSync(join(dir, 'main.dart'), 'void main() {}\n');
      return { seeded: true };
    },
    rubric: { baseline: 'b', withRule: 'r' },
    facts: () => ({}),
  };
}

test('a trial persists its truth, pristine copy, and git isolation', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'wellactually-eval-solve-'));

  const solved = await solve({
    harness: stubHarness(() => {
      /* the agent does nothing */
    }),
    model: 'stub-1',
    testCase: caseFor(),
    arm: { name: 'baseline', kind: 'baseline' },
    runDir,
  });

  assert.equal(solved.ok, true);
  assert.deepEqual(JSON.parse(readFileSync(join(runDir, 'truth.json'), 'utf8')), {
    seeded: true,
  });
  assert.equal(readFileSync(join(runDir, 'answer.md'), 'utf8'), 'done');
  assert.ok(existsSync(join(runDir, 'pristine', 'main.dart')));
  // The fixture got its own repository, so the agent cannot see this repo's
  // history or working tree through git.
  assert.ok(existsSync(join(runDir, 'workspace', '.git')));
});

test('an injecting arm whose hook never ran is an error, not a result', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'wellactually-eval-solve-'));

  const solved = await solve({
    harness: stubHarness(() => {
      /* the agent "forgets" to run the hook: the marker is never touched */
    }),
    model: 'stub-1',
    testCase: caseFor(),
    arm: { name: 'plugin', kind: 'plugin' },
    runDir,
  });

  assert.equal(solved.ok, false);
  if (!solved.ok) {
    assert.match(solved.error, /injection never ran/);
  }
});

test('the marker satisfies the injection discipline', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'wellactually-eval-solve-'));

  const solved = await solve({
    harness: stubHarness(() => {
      // A real harness executes the hook command, whose first act is
      // touching the marker. The stub does just that part.
      writeFileSync(join(runDir, 'hook-ran'), '');
    }),
    model: 'stub-1',
    testCase: caseFor(),
    arm: { name: 'plugin', kind: 'plugin' },
    runDir,
  });

  assert.equal(solved.ok, true);
});
