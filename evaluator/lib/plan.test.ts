import assert from 'node:assert/strict';
import { test } from 'vitest';

import { planCells, planQueue, trialDirName, trialKey, type Options } from './plan.ts';
import type { Arm, Case, Harness } from './types.ts';

const noop = () => {
  /* a harness under plan never runs */
};

function harness(id: string): Harness {
  return {
    id,
    defaultModel: `${id}-default`,
    prepare: noop,
    run: () => Promise.reject(new Error('never runs in planning')),
  };
}

function testCase(id: string, extra: Partial<Case> = {}): Case {
  return {
    id,
    axis: 'action',
    principles: [],
    prompt: 'do the thing',
    timeoutMs: 60_000,
    build: () => ({}),
    rubric: 'pass everything',
    facts: () => ({}),
    ...extra,
  };
}

const ARMS: Arm[] = [
  { name: 'baseline', kind: 'baseline' },
  { name: 'plugin', kind: 'plugin' },
];

function options(partial: Partial<Options>): Options {
  return {
    agents: [{ harness: 'claude', model: 'sonnet' }],
    case: ['demo/one'],
    arms: ARMS,
    n: 3,
    concurrency: 2,
    judgeModel: 'judge',
    ...partial,
  };
}

test('the matrix is agents × cases × arms, with n trials per cell', () => {
  const cells = planCells(
    options({
      agents: [
        { harness: 'claude', model: 'sonnet' },
        { harness: 'codex', model: 'gpt', effort: 'high' },
      ],
      case: ['demo'],
    }),
    { claude: harness('claude'), codex: harness('codex') },
    {
      'demo/one/action': testCase('demo/one/action'),
      'demo/two/control': testCase('demo/two/control'),
    },
    (message) => {
      throw new Error(message);
    },
  );

  // 2 agents × 2 cases × 2 arms.
  assert.equal(cells.length, 8);
  assert.equal(planQueue(cells, 3).length, 24);
});

test('a case that only one harness can execute is skipped for the other', () => {
  const cells = planCells(
    options({
      agents: [
        { harness: 'claude', model: 'sonnet' },
        { harness: 'codex', model: 'gpt' },
      ],
      case: ['demo'],
    }),
    { claude: harness('claude'), codex: harness('codex') },
    { 'demo/one/action': testCase('demo/one/action', { harnesses: ['claude'] }) },
    (message) => {
      throw new Error(message);
    },
  );

  assert.deepEqual(
    cells.map((cell) => cell.harness.id),
    ['claude', 'claude'],
  );
});

test('a selector that matches nothing stops the run before it starts', () => {
  assert.throws(
    () =>
      planCells(
        options({ case: ['PW-NOPE'] }),
        { claude: harness('claude') },
        { 'demo/one/action': testCase('demo/one/action') },
        (message) => {
          throw new Error(message);
        },
      ),
    /no case matches: PW-NOPE/,
  );
});

test('the trial key survives a directory rename to the resolved model', () => {
  // The key is built from what was requested, so it matches whatever the
  // directory was later renamed to.
  const before = trialKey({
    harness: 'claude',
    requestedModel: 'sonnet',
    effort: 'high',
    caseId: 'demo/one/action',
    arm: 'plugin',
    n: 2,
  });
  const after = trialKey({
    harness: 'claude',
    requestedModel: 'sonnet',
    effort: 'high',
    caseId: 'demo/one/action',
    arm: 'plugin',
    n: 2,
  });
  assert.equal(before, after);
});

test('the directory name drops the harness when the model already names it', () => {
  assert.equal(
    trialDirName('PW-D001/x/action', 'claude', 'claude-sonnet-5', 'high', 'plugin', 1),
    'PW-D001_x_action-claude-sonnet-5-effort-high-plugin-1',
  );
  assert.equal(
    trialDirName('PW-D001/x/action', 'claude', 'sonnet', undefined, 'baseline', 2),
    'PW-D001_x_action-claude-sonnet-effort-default-baseline-2',
  );
});
