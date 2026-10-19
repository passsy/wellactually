import assert from 'node:assert/strict';
import { test } from 'vitest';

import { gates, rowsFor, type CellKey, type TrialResult } from './metrics.ts';

function cell(partial: Partial<CellKey> = {}): CellKey {
  return {
    harness: 'claude',
    model: 'sonnet',
    effort: 'high',
    caseId: 'PW-T001/one/action',
    axis: 'action',
    arm: 'plugin',
    ...partial,
  };
}

function result(partial: Partial<TrialResult> = {}): TrialResult {
  return {
    harness: 'claude',
    requestedModel: 'sonnet',
    effort: 'high',
    case: 'PW-T001/one/action',
    axis: 'action',
    arm: 'plugin',
    n: 1,
    ok: true,
    pass: true,
    reason: 'fine',
    dir: '/tmp/x',
    ...partial,
  };
}

test('errored trials count separately and are never averaged in', () => {
  const rows = rowsFor(
    [cell()],
    [
      result({ n: 1, pass: true }),
      result({ n: 2, pass: false, reason: 'missed the retry' }),
      result({ n: 3, ok: false, pass: undefined, error: 'rate limited' }),
    ],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.ran, 2);
  assert.equal(rows[0]?.passed, 1);
  assert.equal(rows[0]?.errors, 1);
});

test('the resolved model names the row, the alias stays as requested', () => {
  const rows = rowsFor([cell()], [result({ model: 'claude-sonnet-5' })]);

  assert.equal(rows[0]?.model, 'claude-sonnet-5');
  assert.equal(rows[0]?.requestedModel, 'sonnet');
});

test('a failed control poisons the whole table', () => {
  const rows = rowsFor(
    [cell({ caseId: 'PW-T001/one/control', axis: 'control' })],
    [result({ case: 'PW-T001/one/control', axis: 'control', pass: false, reason: 'edited the file' })],
  );

  const failed = gates(rows).filter((gate) => gate.failed);
  assert.equal(failed.length, 1);
  assert.match(failed[0]?.message ?? '', /CONTROL FAILED/);
});

test('an unreliable baseline fails the gate and names the case', () => {
  const rows = rowsFor(
    [cell({ arm: 'baseline' }), cell({ caseId: 'PW-T001/one/control', axis: 'control', arm: 'baseline' })],
    [
      result({ arm: 'baseline', pass: false, reason: 'never made the commit' }),
      result({ case: 'PW-T001/one/control', axis: 'control', arm: 'baseline', pass: true }),
    ],
  );

  const failed = gates(rows).filter((gate) => gate.failed);
  assert.equal(failed.length, 1);
  assert.match(failed[0]?.message ?? '', /BASELINE UNRELIABLE/);
  assert.match(failed[0]?.message ?? '', /PW-T001\/one\/action/);
});

test('a run without any control gets a warning, not a failure', () => {
  const rows = rowsFor([cell()], [result()]);

  const warnings = gates(rows);
  assert.equal(warnings.some((gate) => gate.failed), false);
  assert.match(warnings[0]?.message ?? '', /No control case ran/);
});

test('a cell whose trials all errored is flagged as not a result', () => {
  const rows = rowsFor([cell()], [result({ ok: false, pass: undefined, error: 'timeout' })]);

  const failed = gates(rows).filter((gate) => gate.failed);
  assert.equal(failed.length, 1);
  assert.match(failed[0]?.message ?? '', /no usable trial/);
});
