/**
 * The code a finding is about, captured when the finding is written.
 *
 * A `file:line` is a coordinate, not evidence. Whoever reads the report later
 * is on another branch, or another machine, and asking them to go look the
 * line up is asking them to trust the reviewer's summary of it.
 *
 * Two views, because a review needs both. The source says what the code is;
 * the diff says what the author did to it. A finding often anchors to a line
 * the author never touched, which is exactly when only the first one exists.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Authorship, SourceContext } from "./types.mts";
import { classifyAuthorship } from "./authorship.mts";

/** Lines kept either side of the anchor. Enough to see the block it sits in. */
export const CONTEXT_RADIUS = 5;

/** The marked span of a location: one line, or a block. */
export interface Span {
  line: number;
  endLine?: number;
}

/** The last marked line, which is the first one unless a block was marked. */
export function lastLine(span: Span): number {
  return Math.max(span.line, span.endLine ?? span.line);
}

/**
 * What every location on a finding carries: the code, the change to it, and
 * whose work the marked lines are.
 */
export function captureAt(
  repo: string,
  file: string,
  span: Span,
  base: string | undefined,
): { context?: SourceContext; diff?: string; authorship?: Authorship } {
  const context = captureContext(repo, file, span);
  const diff = base ? captureDiff(repo, base, file, span) : undefined;
  const authorship = base
    ? classifyAuthorship(repo, base, file, span)
    : undefined;
  return {
    ...(context ? { context } : {}),
    ...(diff ? { diff } : {}),
    ...(authorship ? { authorship } : {}),
  };
}

export function captureContext(
  repo: string,
  file: string,
  span: Span,
): SourceContext | undefined {
  let lines: string[];
  try {
    lines = readFileSync(join(repo, file), "utf8").split(/\r?\n/);
  } catch {
    return undefined;
  }
  if (span.line > lines.length) return undefined;
  // The window surrounds the whole marked block, not just where it starts.
  const start = Math.max(1, span.line - CONTEXT_RADIUS);
  const end = Math.min(lines.length, lastLine(span) + CONTEXT_RADIUS);
  return { start, lines: lines.slice(start - 1, end) };
}

/**
 * A base as the review means it.
 *
 * `main...HEAD` is what the review skill compares, and it is what a reviewer
 * types. A bare ref gets the same treatment, so "origin/main" and
 * "origin/main...HEAD" behave the same and neither shows changes that landed
 * on the base branch after the work started.
 */
function range(base: string): string {
  return base.includes("..") ? base : `${base}...HEAD`;
}

/**
 * Every hunk the marked span touches, or nothing.
 *
 * Nothing is the common, correct answer for a finding on unchanged code, so
 * it is not worth reporting as a failure anywhere.
 */
export function captureDiff(
  repo: string,
  base: string,
  file: string,
  span: Span,
): string | undefined {
  let patch: string;
  try {
    patch = execFileSync("git", ["diff", range(base), "--", file], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
  return hunksAround(patch, span);
}

/**
 * Cuts the hunks a span overlaps out of a unified patch.
 *
 * Hand-parsed rather than shelled out to, because the only thing needed is
 * the `@@ -a,b +c,d @@` header, and a hunk header is the one part of the
 * format that has never moved.
 *
 * A block can straddle several hunks, and dropping all but the first would
 * hide half of what the author did to it.
 */
export function hunksAround(patch: string, span: Span): string | undefined {
  const kept: string[][] = [];
  let current: string[] | null = null;
  const end = lastLine(span);

  for (const each of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(each);
    if (header) {
      const start = Number(header[1]);
      const count = header[2] === undefined ? 1 : Number(header[2]);
      const overlaps = span.line < start + Math.max(count, 1) && end >= start;
      current = overlaps ? [each] : null;
      if (current) kept.push(current);
      continue;
    }
    current?.push(each);
  }

  if (kept.length === 0) return undefined;
  return kept.map((hunk) => hunk.join("\n").replace(/\s+$/, "")).join("\n");
}
