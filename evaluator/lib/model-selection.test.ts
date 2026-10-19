import assert from 'node:assert/strict';
import { test } from 'vitest';

import { modelHarness } from './model-selection.ts';

test('recognises model names that belong to one harness', () => {
  assert.equal(modelHarness('claude-sonnet-5'), 'claude');
  assert.equal(modelHarness('opus'), 'claude');
  assert.equal(modelHarness('gpt-5.6-sol'), 'codex');
  assert.equal(modelHarness('custom-provider/model'), null);
});
