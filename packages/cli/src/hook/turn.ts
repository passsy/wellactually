import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Written } from "@wellactually/sdk";
import { boardHome } from "../board/board.ts";

/** A file that changed in a git repository since the last look, with the lines that are new in it. */
export interface TurnWrite {
  /** The absolute path of the file. */
  file: string;
  written: Written[];
  isNew: boolean;
}

/** What a look at the repositories of a session found. */
export interface TurnDiff {
  writes: TurnWrite[];
  /** The repositories that were compared. A file in one of them that is not in `writes` did not change. */
  roots: string[];
  /** Repositories that could not be compared, with the reason. What changed in them is not reported. */
  failures: { root: string; reason: string }[];
}

/** How long one git call may take. A repository that takes longer is not looked at again in this session. */
export const GIT_TIMEOUT_MS = 3000;
/** A lock older than this was left by a hook that died. */
const STALE_LOCK_MS = 30_000;

/** What is remembered about one repository of one session: the tree it had at the last look. */
interface Baseline {
  root: string;
  tree: string;
  /** The commit HEAD pointed at, null before the first commit. */
  head: string | null;
}

/**
 * Remembers what every git repository the session works in looks like now,
 * so that the next look can tell what changed in between.
 *
 * A snapshot is a tree in a private index and a private object directory
 * under the advisory board's home, with the repository's own objects as
 * alternates. Nothing is written into the repository, and `git status`
 * there stays as it was.
 *
 * `dirs` are the folders the session is known to work in. The repositories
 * the session has looked at before are snapshotted again, so changes a
 * person made between two turns are not taken for the agent's.
 */
export function snapshotRepos(sessionId: string, dirs: readonly string[]): void {
  const roots = new Set([...knownRoots(sessionId), ...dirs.map(gitRootOf).filter((root): root is string => root !== null)]);
  for (const root of roots) {
    bestEffort(() =>
      withLock(sessionId, root, () => {
        const repo = repoOf(sessionId, root);
        if (repo === null) {
          return;
        }
        const tree = writeTree(repo, ["add", "--all"]);
        writeBaseline(sessionId, { root, tree, head: headOf(repo) });
      }),
    );
  }
}

/** A snapshot that fails leaves the last one in place, and the next look compares against that. */
function bestEffort(work: () => void): void {
  try {
    work();
  } catch {
    // Nothing to do: diffRepos reports a repository it cannot compare.
  }
}

/**
 * Snapshots the repository of `dir` unless the session already has one of it.
 *
 * A session can start in a folder, or a plugin be installed in the middle of
 * a session, without a prompt that took the first snapshot.
 */
export function ensureSnapshot(sessionId: string, dir: string): void {
  const root = gitRootOf(dir);
  if (root !== null && readBaseline(sessionId, root) === null && !isSlow(sessionId, root)) {
    snapshotRepos(sessionId, [dir]);
  }
}

/**
 * Takes files the agent wrote with a file tool into the snapshot, so they are
 * not reported a second time by the next look after a shell command.
 *
 * A file in a repository the session has no snapshot of yet starts one.
 */
export function absorbWrites(sessionId: string, files: readonly string[]): void {
  const byRoot = new Map<string, string[]>();
  for (const file of files) {
    const root = gitRootOf(path.dirname(file));
    if (root !== null) {
      byRoot.set(root, [...(byRoot.get(root) ?? []), file]);
    }
  }
  for (const [root, written] of byRoot) {
    const baseline = readBaseline(sessionId, root);
    if (baseline === null) {
      ensureSnapshot(sessionId, root);
      continue;
    }
    bestEffort(() =>
      withLock(sessionId, root, () => {
        const repo = repoOf(sessionId, root);
        if (repo === null) {
          return;
        }
        const tree = writeTree(repo, ["add", "--all", "--", ...written.map((file) => path.relative(root, file))]);
        writeBaseline(sessionId, { ...baseline, tree });
      }),
    );
  }
}

/**
 * What changed in the session's repositories since the last look, and moves
 * the snapshot on, so every change is reported once.
 *
 * Only added lines count: a change that only removes is nothing an agent
 * wrote. Files that changed because HEAD moved, like a checkout or a pull,
 * came from the history and are left out.
 */
export function diffRepos(sessionId: string, cwd: string): TurnDiff {
  ensureSnapshot(sessionId, cwd);
  const result: TurnDiff = { writes: [], roots: [], failures: [] };
  for (const root of knownRoots(sessionId)) {
    const baseline = readBaseline(sessionId, root);
    if (baseline === null) {
      continue;
    }
    try {
      const done = withLock(sessionId, root, () => {
        const repo = repoOf(sessionId, root);
        if (repo === null) {
          throw new Error("is no longer a git repository");
        }
        const tree = writeTree(repo, ["add", "--all"]);
        const head = headOf(repo);
        const fromHistory = head === baseline.head || baseline.head === null || head === null ? new Set<string>() : new Set(git(repo, ["diff", "--name-only", "--no-renames", baseline.head, head]).split("\n"));
        const patch = tree === baseline.tree ? "" : git(repo, ["diff-tree", "-r", "-p", "-U0", "--no-renames", "--no-ext-diff", "--no-color", "--diff-filter=AM", baseline.tree, tree]);
        writeBaseline(sessionId, { root, tree, head });
        return parsePatch(patch).filter((change) => !fromHistory.has(change.path));
      });
      if (done === null) {
        result.failures.push({ root, reason: isSlow(sessionId, root) ? "git was too slow on it earlier in this session" : "another hook of this session is looking at it" });
        continue;
      }
      result.roots.push(root);
      result.writes.push(...done.filter((change) => change.written.length > 0).map((change) => ({ file: path.join(root, change.path), written: change.written, isNew: change.isNew })));
    } catch (error) {
      result.failures.push({ root, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

/** Forgets the snapshots of a session that ended. */
export function forgetSnapshots(sessionId: string): void {
  fs.rmSync(sessionDir(sessionId), { recursive: true, force: true });
}

/** A session not heard from in this long is over. */
const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Removes the snapshots of sessions that ended without saying so. Resolves to how many. */
export function sweepSnapshots(now: number = Date.now()): number {
  let names: string[];
  try {
    names = fs.readdirSync(turnsDir());
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const dir = path.join(turnsDir(), name);
    try {
      if (now - fs.statSync(dir).mtimeMs > SNAPSHOT_MAX_AGE_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // Another hook removed it first.
    }
  }
  return removed;
}

interface PatchedFile {
  /** From the root of the repository. */
  path: string;
  written: Written[];
  isNew: boolean;
}

/**
 * The files of a `git diff -U0` patch, each with the lines that are in it
 * after the change and were not before.
 */
export function parsePatch(patch: string): PatchedFile[] {
  const files: PatchedFile[] = [];
  let current: PatchedFile | null = null;
  let line = 0;
  for (const text of patch.split("\n")) {
    if (text.startsWith("diff --git ")) {
      current = { path: "", written: [], isNew: false };
      files.push(current);
      continue;
    }
    if (current === null) {
      continue;
    }
    if (text.startsWith("new file mode")) {
      current.isNew = true;
      continue;
    }
    if (text.startsWith("+++ ")) {
      current.path = unquote(text.slice(4)).replace(/^b\//, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (text.startsWith("+")) {
      current.written.push({ line, text: text.slice(1) });
      line++;
    }
  }
  return files.filter((file) => file.path !== "" && file.path !== "/dev/null");
}

/** A path as git prints it, which quotes it in C style when it holds unusual characters. */
function unquote(text: string): string {
  if (!text.startsWith('"')) {
    return text;
  }
  const bytes: number[] = [];
  const body = text.slice(1, -1);
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11, '"': 34, "\\": 92 };
  for (let index = 0; index < body.length; index++) {
    const char = body[index] as string;
    if (char !== "\\") {
      bytes.push(...Buffer.from(char));
      continue;
    }
    const next = body[index + 1] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(Number.parseInt(body.slice(index + 1, index + 4), 8));
      index += 3;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      index += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** A repository as this module talks to it: the folders of the session's own index and objects. */
interface Repo {
  root: string;
  env: NodeJS.ProcessEnv;
}

/**
 * The private index and object directory of a session in a repository,
 * created on first use from the repository's own index, so git only has to
 * hash the files that differ from it.
 */
function repoOf(sessionId: string, root: string): Repo | null {
  const dir = repoDir(sessionId, root);
  const objects = path.join(dir, "objects");
  const index = path.join(dir, "index");
  let gitObjects: string;
  let gitIndex: string;
  try {
    [gitObjects, gitIndex] = git({ root, env: process.env }, ["rev-parse", "--path-format=absolute", "--git-path", "objects", "--git-path", "index"]).split("\n") as [string, string];
  } catch {
    return null;
  }
  fs.mkdirSync(objects, { recursive: true });
  if (!fs.existsSync(index) && fs.existsSync(gitIndex)) {
    fs.copyFileSync(gitIndex, index);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: index,
    GIT_OBJECT_DIRECTORY: objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: gitObjects,
    // A hook must never wait for a person, nor take git's lock on the repository's own index.
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
  return { root, env };
}

/** Updates the private index with `args` and writes it as a tree. */
function writeTree(repo: Repo, args: string[]): string {
  git(repo, args);
  return git(repo, ["write-tree"]);
}

function headOf(repo: Repo): string | null {
  try {
    return git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]) || null;
  } catch {
    return null;
  }
}

function git(repo: Repo, args: string[]): string {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: repo.root,
    env: repo.env,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).trimEnd();
}

/**
 * The root of the git repository a folder is in, by looking for `.git`
 * upwards. The home directory and the root of the disk are never a
 * repository here, even when somebody keeps a `.git` there.
 */
export function gitRootOf(dir: string): string | null {
  let current = path.resolve(dir);
  while (true) {
    if (current === os.homedir() || current === path.parse(current).root) {
      return null;
    }
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    current = path.dirname(current);
  }
}

/**
 * Runs `work` while holding the session's lock on a repository. Resolves to
 * null when another hook holds it: the changes stay in the working tree and
 * the next look reports them.
 *
 * A repository on which git ran out of time is marked slow and skipped for
 * the rest of the session, so it costs that wait once.
 */
function withLock<T>(sessionId: string, root: string, work: () => T): T | null {
  if (isSlow(sessionId, root)) {
    return null;
  }
  const dir = repoDir(sessionId, root);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, "lock");
  try {
    fs.mkdirSync(lock);
  } catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs < STALE_LOCK_MS) {
        return null;
      }
      fs.rmSync(lock, { recursive: true, force: true });
      fs.mkdirSync(lock);
    } catch {
      return null;
    }
  }
  try {
    return work();
  } catch (error) {
    if ((error as { code?: string }).code === "ETIMEDOUT" || (error as { signal?: string }).signal === "SIGTERM") {
      fs.writeFileSync(path.join(dir, "slow"), "");
      throw new Error(`git took longer than ${GIT_TIMEOUT_MS} ms, so this session no longer looks at it`);
    }
    throw error;
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function isSlow(sessionId: string, root: string): boolean {
  return fs.existsSync(path.join(repoDir(sessionId, root), "slow"));
}

function knownRoots(sessionId: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(sessionDir(sessionId));
  } catch {
    return [];
  }
  // Sorted, so the files of several repositories reach detectors in the same order every time.
  return names
    .map((name) => readJson(path.join(sessionDir(sessionId), name, "baseline.json"))?.root)
    .filter((root): root is string => typeof root === "string")
    .sort();
}

function readBaseline(sessionId: string, root: string): Baseline | null {
  return readJson(path.join(repoDir(sessionId, root), "baseline.json"));
}

function writeBaseline(sessionId: string, baseline: Baseline): void {
  const file = path.join(repoDir(sessionId, baseline.root), "baseline.json");
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(baseline));
  fs.renameSync(`${file}.tmp`, file);
  // The session's folder tells the sweep when it was last used.
  const now = new Date();
  fs.utimesSync(sessionDir(sessionId), now, now);
}

function readJson(file: string): Baseline | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Baseline;
  } catch {
    return null;
  }
}

function turnsDir(): string {
  return path.join(boardHome(), "turns");
}

function sessionDir(sessionId: string): string {
  return path.join(turnsDir(), sessionId.replace(/[^A-Za-z0-9_-]/g, "_"));
}

function repoDir(sessionId: string, root: string): string {
  return path.join(sessionDir(sessionId), createHash("sha256").update(root).digest("hex").slice(0, 16));
}
