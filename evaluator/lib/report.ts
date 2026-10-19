/**
 * Turning trials into a table somebody will actually read.
 *
 * A cell reports how many trials passed, out of how many ran. Errored trials
 * are counted separately and never averaged in, because an arm that could not
 * reach the API is not an arm that behaved badly.
 */

import type { Row } from './types.ts';

export function table(rows: Row[]): string {
  const header = ['harness', 'model', 'effort', 'case', 'axis', 'arm', 'pass', 'errors', 'detail'];
  const body = rows.map((row) => [
    row.harness,
    row.model,
    row.effort ?? 'default',
    row.case,
    row.axis,
    row.arm,
    row.ran === 0 ? '—' : `${row.passed}/${row.ran}`,
    row.errors === 0 ? '' : String(row.errors),
    row.detail,
  ]);

  const widths = header.map((_, i) =>
    Math.max(header[i]!.length, ...body.map((r) => String(r[i]).length)),
  );
  const line = (cells: (string | number)[]) =>
    cells
      .map((c, i) => String(c).padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();

  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}

/**
 * One line per cell. For a cell that failed, the judge's own reasons are more
 * use than any number: they say what was wrong with the answer.
 */
export function detail(trials: { ok: boolean; pass?: boolean; reason?: string; error?: string }[]): string {
  const ok = trials.filter((t) => t.ok);
  if (ok.length === 0) {
    return [...new Set(trials.map((t) => t.error))].join(' | ').slice(0, 100);
  }

  const failures = ok.filter((t) => !t.pass);
  const source = failures.length > 0 ? failures : ok;
  return [...new Set(source.map((t) => t.reason))].join(' | ').slice(0, 140);
}
