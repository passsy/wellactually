import type { Ctx, Finding } from "@wellactually/sdk";

const MAX_QUOTED_LENGTH = 300;

/**
 * A finding in words, for the agent and for the author: where it is and what
 * is there.
 *
 * A finding without a line in a file is about the file itself: where it lives,
 * what it is called, what it lacks. Without a file there is nothing to point
 * at, and the result is null: the principle fired, and that is all.
 *
 * A finding that names another file is about that file, and its line or
 * match says where in the event it came from.
 *
 * The quoted line comes from the event, not from the detector. A detector
 * only says which line.
 */
export function describeFinding(ctx: Pick<Ctx, "file" | "text">, finding: Finding): string | null {
  const place = describePlace(ctx, finding);
  // Naming the file of the event itself says no more than naming no file.
  if (finding.file === undefined || finding.file === ctx.file?.relativePath) {
    return place ?? (ctx.file ? `the file ${ctx.file.relativePath}` : null);
  }
  if (place === null) {
    return `the file ${finding.file}`;
  }
  return `the file ${finding.file}, from ${place}`;
}

/** The line or the match in the event that a finding names, or null when it names neither. */
function describePlace(ctx: Pick<Ctx, "file" | "text">, finding: Finding): string | null {
  const match = finding.match === undefined ? null : JSON.stringify(finding.match);
  if (finding.line === undefined) {
    return match;
  }
  const text = lineText(ctx, finding).trim();
  const quoted = text.length > MAX_QUOTED_LENGTH ? `${text.slice(0, MAX_QUOTED_LENGTH)}…` : text;
  // A removed line is not in the file any more. Its number is the one it had before.
  const kind = finding.removed === true ? "removed line" : "line";
  const where = finding.endLine === undefined ? `${kind} ${finding.line}` : `${kind}s ${finding.line}-${finding.endLine}`;
  // A match that is the whole line would only repeat it.
  const named = match !== null && finding.match !== text ? `${where}, ${match}` : where;
  return quoted === "" ? named : `${named}: ${quoted}`;
}

/** The text of the line a finding names: in the file, in what a command printed, or among the removed lines. */
function lineText(ctx: Pick<Ctx, "file" | "text">, finding: Finding): string {
  if (finding.removed === true) {
    const removed = ctx.file?.removed.find((line) => line.line === finding.line);
    return removed?.text ?? "";
  }
  const lines = ctx.file?.lines ?? ctx.text.split("\n");
  return lines[(finding.line ?? 1) - 1] ?? "";
}
