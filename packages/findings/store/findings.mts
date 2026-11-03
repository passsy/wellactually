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
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  PRIORITY,
  type Finding,
  type Observation,
  type ReviewCandidate,
  type TargetMeta,
} from "../model/types.mts";
import type { TargetPaths } from "./paths.mts";
import { upgrade } from "./legacy.mts";

let writeCounter = 0;

function writeJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.${writeCounter++}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

/**
 * A whole file, appearing at once.
 *
 * For the two views, which are rebuilt from every finding after every write.
 * The content is derived, so two servers publishing the same directory write
 * the same bytes; what is not safe is writing them in place, because the
 * report is a file someone has open in a browser and a plain write hands them
 * whatever had been flushed when they hit reload.
 */
export function writeView(path: string, text: string): void {
  const temp = `${path}.${process.pid}.${writeCounter++}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name));
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
  mkdirSync(paths.candidates, { recursive: true });
  mkdirSync(paths.observations, { recursive: true });
}

export function findingPath(paths: TargetPaths, id: string): string {
  return join(paths.findings, `${id}.json`);
}

export function readFinding(paths: TargetPaths, id: string): Finding | null {
  const finding = readJson<Finding>(findingPath(paths, id));
  return finding && upgrade(finding);
}

export function listFindings(paths: TargetPaths): Finding[] {
  return jsonFiles(paths.findings)
    .map((path) => readJson<Finding>(path))
    .filter((finding): finding is Finding => finding !== null)
    .map(upgrade)
    .sort(byPriority);
}

export function writeFinding(paths: TargetPaths, finding: Finding): void {
  ensureTarget(paths);
  writeJson(findingPath(paths, finding.id), finding);
}

/**
 * Takes an id by creating its file, or says that someone else got there.
 *
 * Allocating an id means reading the directory and adding one to the highest
 * number in it, which two processes do to the same answer. That is not an
 * exotic interleaving: every session starts its own server, only one of them
 * wins the UI port, and all of them write to the same review directory. The
 * rename that makes an ordinary write atomic replaces whatever is there, so
 * the loser of that race lost a finding and nothing said so. Measured with two
 * processes writing ten findings each: ten files on disk.
 *
 * `link` is the fix because it is atomic and it refuses to overwrite. The file
 * is written under a temp name first, so a reader still never sees half a
 * finding, and the id is only taken if the link succeeds.
 */
export function claimFinding(paths: TargetPaths, finding: Finding): boolean {
  ensureTarget(paths);
  const path = findingPath(paths, finding.id);
  const temp = `${path}.${process.pid}.${writeCounter++}.tmp`;
  writeFileSync(temp, `${JSON.stringify(finding, null, 2)}\n`);
  try {
    linkSync(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
}

/** The same claim, for the separate sequence observations are numbered in. */
export function claimObservation(
  paths: TargetPaths,
  observation: Observation,
): boolean {
  ensureTarget(paths);
  const path = observationPath(paths, observation.id);
  const temp = `${path}.${process.pid}.${writeCounter++}.tmp`;
  writeFileSync(temp, `${JSON.stringify(observation, null, 2)}\n`);
  try {
    linkSync(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
}

export function readMeta(paths: TargetPaths): TargetMeta {
  return readJson<TargetMeta>(paths.meta) ?? {};
}

export function writeMeta(paths: TargetPaths, meta: TargetMeta): void {
  ensureTarget(paths);
  writeJson(paths.meta, meta);
}

export function listObservations(paths: TargetPaths): Observation[] {
  return jsonFiles(paths.observations)
    .map((path) => readJson<Observation>(path))
    .filter((each): each is Observation => each !== null)
    .sort((a, b) => numberOf(a.id) - numberOf(b.id));
}

export function observationPath(paths: TargetPaths, id: string): string {
  return join(paths.observations, `${id}.json`);
}

export function readObservation(
  paths: TargetPaths,
  id: string,
): Observation | null {
  return readJson<Observation>(observationPath(paths, id));
}

export function writeObservation(
  paths: TargetPaths,
  observation: Observation,
): void {
  ensureTarget(paths);
  writeJson(observationPath(paths, observation.id), observation);
}

export function candidatePath(paths: TargetPaths, id: string): string {
  return join(paths.candidates, `${id}.json`);
}

export function readCandidate(
  paths: TargetPaths,
  id: string,
): ReviewCandidate | null {
  return readJson<ReviewCandidate>(candidatePath(paths, id));
}

export function listCandidates(paths: TargetPaths): ReviewCandidate[] {
  return jsonFiles(paths.candidates)
    .map((path) => readJson<ReviewCandidate>(path))
    .filter((candidate): candidate is ReviewCandidate => candidate !== null)
    .sort((a, b) => numberOf(a.id) - numberOf(b.id));
}

export function writeCandidate(
  paths: TargetPaths,
  candidate: ReviewCandidate,
): void {
  ensureTarget(paths);
  writeJson(candidatePath(paths, candidate.id), candidate);
}

export function claimCandidate(
  paths: TargetPaths,
  candidate: ReviewCandidate,
): boolean {
  ensureTarget(paths);
  const path = candidatePath(paths, candidate.id);
  const temp = `${path}.${process.pid}.${writeCounter++}.tmp`;
  writeFileSync(temp, `${JSON.stringify(candidate, null, 2)}\n`);
  try {
    linkSync(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
}

export function allocateCandidateId(paths: TargetPaths): string {
  const used = listCandidates(paths)
    .map((candidate) => numberOf(candidate.id))
    .filter((number) => Number.isFinite(number));
  return `C${String((used.length ? Math.max(...used) : 0) + 1)}`;
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

export function allocateObservationId(paths: TargetPaths): string {
  const used = listObservations(paths).map((each) => numberOf(each.id));
  return `O${Math.max(0, ...used) + 1}`;
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
export function reviewActivity(paths: TargetPaths): { updatedAt: string; phase: "review" | "verification"; complete: boolean } | null {
  const dir = join(paths.dir, "sessions");
  if (!existsSync(dir)) return null;
  type Session = { updatedAt: string; phase: "review" | "verification"; queues: { items: { completed?: unknown }[] }[] };
  const latest = readdirSync(dir).map(id => readJson<Session>(join(dir, id, "session.json"))).filter((s): s is Session => s !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return latest ? { updatedAt: latest.updatedAt, phase: latest.phase, complete: latest.phase === "verification" && latest.queues.every(q => q.items.every(i => i.completed)) } : null;
}
