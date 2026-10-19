/**
 * Reducing trials to cells, and cells to the three gates that decide whether
 * the table may be read at all.
 *
 * The gates encode the discipline the README spells out: a failed control
 * means the pipeline is broken and every other row is measuring that; an
 * unreliable baseline means the case is broken and its plugin row credits the
 * difference between two rubrics; a cell whose trials all errored is not a
 * result. None of those are numbers to average — they are reasons to stop.
 */

import { detail } from './report.ts';
import type { Axis, Row } from './types.ts';

/** The serialisable shape of one finished (or failed) trial. */
export interface TrialResult {
  harness: string;
  requestedModel: string;
  /** What actually answered, when known. */
  model?: string;
  effort?: string;
  case: string;
  axis: Axis;
  arm: string;
  n: number;
  ok: boolean;
  pass?: boolean;
  reason?: string;
  error?: string;
  facts?: Record<string, unknown>;
  dir: string;
  agentVersion?: string;
  judgeCostUsd?: number;
}

export interface CellKey {
  harness: string;
  model: string;
  effort?: string;
  caseId: string;
  axis: Axis;
  arm: string;
}

export function rowsFor(cells: CellKey[], results: TrialResult[]): Row[] {
  return cells.map((cell): Row => {
    const mine = results.filter(
      (result) =>
        result.harness === cell.harness &&
        result.requestedModel === cell.model &&
        result.effort === cell.effort &&
        result.case === cell.caseId &&
        result.arm === cell.arm,
    );
    const ok = mine.filter((result) => result.ok);
    return {
      harness: cell.harness,
      requestedModel: cell.model,
      // What answered, falling back to what was asked for when every trial in
      // the cell errored before any model spoke.
      model: ok.find((result) => result.model)?.model ?? cell.model,
      effort: cell.effort,
      case: cell.caseId,
      axis: cell.axis,
      arm: cell.arm,
      ran: ok.length,
      passed: ok.filter((result) => result.pass).length,
      errors: mine.length - ok.length,
      detail: detail(mine),
    };
  });
}

export interface Gate {
  /** Row exit code contribution: true means the run must not exit 0. */
  failed: boolean;
  message: string;
}

/**
 * Everything that makes the table unreadable, in the order it should be
 * reported. The caller prints each message and sets the exit code when any
 * gate failed.
 */
export function gates(rows: Row[]): Gate[] {
  const out: Gate[] = [];

  const errored = rows.filter((row) => row.ran === 0);
  if (errored.length > 0) {
    out.push({
      failed: true,
      message: `${errored.length} cell(s) produced no usable trial. Those are not results.`,
    });
  }

  // A control asks nothing of the framing, so it fails only when the pipeline
  // is broken: a harness that stopped injecting, a judge grading something
  // other than what it was handed, an agent that never really ran.
  const brokenControls = rows.filter((row) => row.axis === 'control' && row.passed < row.ran);
  if (brokenControls.length > 0) {
    out.push({
      failed: true,
      message:
        `CONTROL FAILED in ${brokenControls.length} cell(s). The other rows above are not ` +
        `trustworthy: a control does not depend on any framing, so something in the pipeline is wrong.`,
    });
  } else if (!rows.some((row) => row.axis === 'control')) {
    out.push({
      failed: false,
      message: 'No control case ran. Add --case control so a broken pipeline cannot pass for a result.',
    });
  }

  // The baseline is graded on the base task only, so a model that cannot do
  // the task without the plugin cannot show the plugin adding anything either.
  for (const row of rows.filter((r) => r.arm === 'baseline' && r.axis !== 'control')) {
    if (row.ran > 0 && row.passed < row.ran) {
      out.push({
        failed: true,
        message:
          `BASELINE UNRELIABLE  ${row.case} on ${row.harness}/${row.model}@${row.effort ?? 'default'}: ` +
          `${row.passed}/${row.ran} without the plugin.\n` +
          `  The base task is not being done even before a rule is injected, so the plugin row ` +
          `for this case says nothing about the rule.\n` +
          `  Reason given: ${row.detail}`,
      });
    }
  }

  return out;
}
