import assert from 'node:assert/strict';
import { test } from 'vitest';

import { claudeArgs } from './harness/claude.ts';
import { codexArgs, codexError } from './harness/codex.ts';

test('passes each selected effort in the form its harness expects', () => {
  const claude = claudeArgs('do it', 'opus', 'high');
  const claudeEffort = claude.indexOf('--effort');
  assert.deepEqual(claude.slice(claudeEffort, claudeEffort + 2), ['--effort', 'high']);

  const codex = codexArgs('/tmp/work', 'do it', 'gpt-test', 'xhigh');
  assert.deepEqual(codex.slice(3, 8), [
    'gpt-test',
    '--strict-config',
    '--config',
    'model_reasoning_effort="xhigh"',
    '--cd',
  ]);
});

test('uses the requested Codex sandbox', () => {
  const args = codexArgs(
    '/tmp/work',
    'commit it',
    'gpt-test',
    undefined,
    'danger-full-access',
  );
  const sandbox = args.indexOf('--sandbox');
  assert.deepEqual(args.slice(sandbox, sandbox + 2), [
    '--sandbox',
    'danger-full-access',
  ]);
});

test('surfaces the Codex API error hidden behind stderr progress', () => {
  const stdout = [
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'error',
      message: JSON.stringify({
        type: 'error',
        status: 400,
        error: {
          type: 'invalid_request_error',
          message:
            "The 'claude-sonnet-5' model is not supported when using Codex with a ChatGPT account.",
        },
      }),
    }),
  ].join('\n');

  assert.equal(
    codexError(stdout),
    "The 'claude-sonnet-5' model is not supported when using Codex with a ChatGPT account.",
  );
});
