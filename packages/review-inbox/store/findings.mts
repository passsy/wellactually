/**
 * Reading and writing the files that are the source of truth.
 *
 * One file per finding, not one file per target. Two agents working the same
 * review touch different files, a merge of a shared review directory
 * conflicts per finding instead of wholesale, and every write is a rename
 * over a temp file in the same directory, so a reader never sees half a
 * finding.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PRIORITY, type Finding, type TargetMeta } from "../model/types.mts";
import type { TargetPaths } from "./paths.mts";

import {
  withRecords,
  readRecord,
  findingRecords,
  occurrenceRecords,
} from "./records.mts";
import { view, saveView } from "./presentation.mts";

let writeCounter = 0;

function writeJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.${writeCounter++}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** The number in "T4", or 0 for an id that does not carry one. */
function numberOf(id: string): number {
  const digits = /(\d+)$/.exec(id);
  return digits ? Number(digits[1]) : 0;
}

const PRIORITY_RANK = new Map(PRIORITY.map((each, index) => [each, index]));

/** p0 first, then by id, which is the order reports read in. */
export function byPriority(a: Finding, b: Finding): number {
  const rank =
    (PRIORITY_RANK.get(a.priority) ?? PRIORITY.length) -
    (PRIORITY_RANK.get(b.priority) ?? PRIORITY.length);
  if (rank !== 0) return rank;
  return a.id.localeCompare(b.id) || numberOf(a.id) - numberOf(b.id);
}

export function ensureTarget(paths: TargetPaths): void {
  mkdirSync(paths.findings, { recursive: true });
  mkdirSync(paths.occurrences, { recursive: true });
}

export function findingPath(paths: TargetPaths, id: string): string {
  return join(paths.findings, `${id}.json`);
}

export function readFinding(paths: TargetPaths, id: string): Finding | null {
  return withRecords(paths, () => {
    const record = readRecord(paths, id);
    return record ? view(record, occurrenceRecords(paths)) : null;
  });
}
export function listFindings(paths: TargetPaths): Finding[] {
  return withRecords(paths, () => {
    const occurrences = occurrenceRecords(paths);
    return findingRecords(paths)
      .filter((f) => f.closure?.reason !== "superseded")
      .map((f) => view(f, occurrences))
      .sort(byPriority);
  });
}
export function writeFinding(paths: TargetPaths, finding: Finding): void {
  withRecords(paths, () => {
    saveView(paths, finding);
    finding.record = readRecord(paths, finding.id)!;
  });
}
export function claimFinding(paths: TargetPaths, finding: Finding): boolean {
  return withRecords(paths, () => {
    if (readRecord(paths, finding.id)) return false;
    saveView(paths, finding);
    return true;
  });
}

export function readMeta(paths: TargetPaths): TargetMeta {
  return readJson<TargetMeta>(paths.meta) ?? {};
}

export function writeMeta(paths: TargetPaths, meta: TargetMeta): void {
  ensureTarget(paths);
  writeJson(paths.meta, meta);
}

/**
 * The letter a level signs its findings with.
 *
 * The review skill hands out one letter per level so an id says where it came
 * from. The server only owns the number, which is what makes it unique.
 */
const LEVEL_LETTERS: Record<string, string> = {
  "0": "G",
  "1": "A",
  "2": "H",
  "3": "T",
  "4": "L",
  "5": "R",
};

/** Findings that belong to no level, such as the general pass, sign with G. */
export function letterFor(level: string | undefined): string {
  if (level === undefined) return "G";
  const trimmed = level.trim();
  const known = LEVEL_LETTERS[trimmed];
  if (known) return known;
  return /^[A-Za-z]$/.test(trimmed) ? trimmed.toUpperCase() : "G";
}

/**
 * The next free id for a letter.
 *
 * Numbers are per letter, so level 3's fourth finding is T4 whatever the
 * other levels did, and a gap left by nothing is never reused.
 */
export function allocateFindingId(paths: TargetPaths, letter: string): string {
  const used = listFindings(paths)
    .filter((finding) => finding.id.startsWith(letter))
    .map((finding) => numberOf(finding.id));
  return `${letter}${Math.max(0, ...used) + 1}`;
}

/** Every target under a repository's review directory. */
export function listTargets(reviewDir: string): string[] {
  if (!existsSync(reviewDir)) return [];
  return readdirSync(reviewDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(reviewDir, name, "findings")))
    .sort();
}

/** Read-only live activity for the card; no full investigation bodies cross the UI boundary. */
export function reviewActivity(
  paths: TargetPaths,
): {
  updatedAt: string;
  phase: "review" | "verification";
  complete: boolean;
} | null {
  const dir = join(paths.dir, "sessions");
  if (!existsSync(dir)) return null;
  type Session = {
    updatedAt: string;
    phase: "review" | "verification";
    queues: { items: { completed?: unknown }[] }[];
  };
  const latest = readdirSync(dir)
    .map((id) => readJson<Session>(join(dir, id, "session.json")))
    .filter((s): s is Session => s !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return latest
    ? {
        updatedAt: latest.updatedAt,
        phase: latest.phase,
        complete:
          latest.phase === "verification" &&
          latest.queues.every((q) => q.items.every((i) => i.completed)),
      }
    : null;
}
