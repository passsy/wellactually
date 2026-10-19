import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { score } from './score.ts';
import type { Case } from './types.ts';

/**
 * A trial directory the way `solve` leaves one behind: a git-seeded workspace,
 * a pristine copy, the answer, and the stored truth. Everything scoring needs,
 * none of it requiring an agent.
 */
function storedTrial(answer: string, truth: Record<string, unknown>): string {
  const runDir = mkdtempSync(join(tmpdir(), 'wellactually-eval-score-'));
  const workspace = join(runDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'main.dart'), 'void main() {}\n');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'evaluator@example.com');
  git('config', 'user.name', 'Evaluator');
  git('add', '-A');
  git('commit', '-qm', 'Seed');
  cpSync(workspace, join(runDir, 'pristine'), { recursive: true });
  writeFileSync(join(runDir, 'answer.md'), answer);
  writeFileSync(join(runDir, 'truth.json'), JSON.stringify(truth));
  return runDir;
}

function caseWith(partial: Partial<Case>): Case {
  return {
    id: 'demo/one/action',
    axis: 'action',
    principles: [],
    prompt: 'count the catch blocks',
    timeoutMs: 60_000,
    build: () => ({}),
    rubric: { baseline: 'base bar', withRule: 'rule bar' },
    facts: (trial) => ({ edited: trial.edited }),
    ...partial,
  };
}

test('a failing check fails the trial without a judge call', async () => {
  const runDir = storedTrial('there are 4 catch blocks', { expected: 4 });

  const scored = await score({
    testCase: caseWith({
      checks: (trial, truth) => [
        { name: 'answer-names-the-count', pass: trial.text.includes(String(truth.expected)) },
        { name: 'workspace-untouched', pass: !trial.edited },
        { name: 'always-wrong', pass: false, evidence: 'planted failure' },
      ],
    }),
    arm: { name: 'plugin', kind: 'plugin' },
    runDir,
    judgeModel: 'a-model-that-does-not-exist',
  });

  assert.equal(scored.ok, true);
  if (!scored.ok) {
    return;
  }
  // The nonexistent judge model proves no judge ran: reaching it would error.
  assert.equal(scored.pass, false);
  assert.equal(scored.reason, 'check failed: always-wrong');

  const verdict = JSON.parse(readFileSync(join(runDir, 'verdict.json'), 'utf8')) as {
    pass: boolean;
    reason: string;
  };
  assert.equal(verdict.pass, false);

  // The checks travel with the facts, so the stored file shows both halves.
  // An arm with advice is also held to staying quiet about ratings.
  const facts = JSON.parse(readFileSync(join(runDir, 'facts.json'), 'utf8')) as {
    checks?: { name: string; pass: boolean }[];
  };
  assert.deepEqual(facts.checks?.map((check) => check.name).at(-1), 'quiet-about-ratings');
  assert.equal(facts.checks?.length, 4);
});

test('the rubric follows the arm, not the case', async () => {
  const runDir = storedTrial('an answer', {});

  const scored = await score({
    testCase: caseWith({
      // A failing check keeps the judge out of the way; only the chosen rubric
      // is under test.
      checks: () => [{ name: 'planted', pass: false }],
    }),
    arm: { name: 'baseline', kind: 'baseline' },
    runDir,
    judgeModel: 'unused',
  });

  assert.equal(scored.ok, true);
  if (scored.ok) {
    assert.equal(scored.rubric, 'base bar');
  }
});

test('scoring works from the stored answer when no outcome is passed', async () => {
  const runDir = storedTrial('the stored answer', { marker: 'x' });
  let sawText = '';

  await score({
    testCase: caseWith({
      facts: (trial) => {
        sawText = trial.text;
        return {};
      },
      checks: () => [{ name: 'planted', pass: false }],
    }),
    arm: { name: 'plugin', kind: 'plugin' },
    runDir,
    judgeModel: 'unused',
  });

  assert.equal(sawText, 'the stored answer');
});
