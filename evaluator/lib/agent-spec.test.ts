import assert from 'node:assert/strict';
import { test } from 'vitest';

import { agentKey, parseAgentSpec } from './agent-spec.ts';

const DEFAULTS = { claude: 'sonnet', codex: 'gpt-default' };

test('parses independently configurable agent selections', () => {
  assert.deepEqual(parseAgentSpec('claude:opus:high', DEFAULTS), {
    harness: 'claude',
    model: 'opus',
    effort: 'high',
  });
  assert.deepEqual(parseAgentSpec('codex:gpt-5.6-sol:xhigh', DEFAULTS), {
    harness: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
  });
  assert.deepEqual(parseAgentSpec('claude::medium', DEFAULTS), {
    harness: 'claude',
    model: 'sonnet',
    effort: 'medium',
  });
});

test('keeps default effort and explicit effort as different cells', () => {
  assert.notEqual(
    agentKey(parseAgentSpec('claude:opus', DEFAULTS)),
    agentKey(parseAgentSpec('claude:opus:high', DEFAULTS)),
  );
});

test('rejects cross-vendor models and malformed specs', () => {
  assert.throws(() => parseAgentSpec('codex:opus:high', DEFAULTS), /belongs to claude/);
  assert.throws(() => parseAgentSpec('unknown:model:high', DEFAULTS), /unknown harness/);
  assert.throws(() => parseAgentSpec('claude:opus:very high', DEFAULTS), /invalid effort/);
  assert.throws(() => parseAgentSpec('claude:opus:ultra', DEFAULTS), /does not support/);
  assert.throws(() => parseAgentSpec('codex:gpt-default:veryhigh', DEFAULTS), /unknown effort/);
  assert.throws(() => parseAgentSpec('claude:opus:high:extra', DEFAULTS), /expected harness/);
});
