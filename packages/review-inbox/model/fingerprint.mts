/**
 * Recognizing the same finding across runs, while line numbers drift.
 *
 * The line number is deliberately not part of it. A finding survives code
 * moving above it, and stops surviving the moment its own line is rewritten,
 * which is exactly the signal that the fix landed.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Trim, then collapse every internal whitespace run to one space. */
export function normalize(snippet: string): string {
  return snippet.trim().replace(/\s+/g, " ");
}

export function fingerprintOf(
  rule: string | undefined,
  file: string,
  snippet: string,
): string {
  const parts = `${rule ?? "adhoc"}:${file}:${normalize(snippet)}`;
  return createHash("sha256").update(parts).digest("hex");
}

/**
 * The anchor line as the working tree has it.
 *
 * An unreadable file or an out-of-range line is not an error: the finding is
 * still worth recording, it just fingerprints on an empty snippet and will
 * behave like a file-level finding.
 */
export function snippetAt(repo: string, file: string, line: number): string {
  try {
    const lines = readFileSync(join(repo, file), "utf8").split(/\r?\n/);
    return lines[line - 1] ?? "";
  } catch {
    return "";
  }
}
