import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Ctx, Written } from "@wellactually/sdk";
import { fileCtx, hasDetector } from "@wellactually/core/node";
import { describeFinding } from "../../../packages/cli/src/hook/finding.ts";
import { parsePatch } from "../../../packages/cli/src/hook/turn.ts";
import { type Lockfile, readCached, readLockfile, runBoard } from "../../../packages/cli/src/board/board.ts";
import { findProjectRoot, toPosix } from "../../../packages/cli/src/board/files.ts";
import { collectInput, type CollectedInput, type InputOptions } from "./inputs.ts";
import { switchedOff } from "../../../packages/cli/src/board/switches.ts";

/**
 * What a review compares: `base` against `head`, or against the working tree
 * when `head` is null. The working tree includes files git does not track yet.
 */
export interface ReviewTarget {
  base: string | null;
  head: string | null;
  kind?: "git" | "patch" | "snapshot";
  /** The target in words, for the report. */
  label: string;
}

/** One file of the change, as the detectors see it. */
export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "renamed" | "deleted" | "current";
  /** The path before a rename. */
  from?: string;
  written: Written[];
  removed: Written[];
}

/** Where a detector fired in the change. */
export interface ReviewHit {
  file: string;
  line: number | null;
  /** The finding in words, as an agent is shown it. */
  text: string;
}

/** A principle the review checks the change against. */
export interface ReviewPrinciple {
  id: string;
  version: number;
  title: string;
  summary: string;
  tags: string[];
  detector: boolean;
  /** Where its detector fired in the change. Empty for a principle without a detector. */
  hits: ReviewHit[];
  /** The file with its full advice, relative to the review directory. */
  file: string;
}

export interface ReviewPlan {
  /** Version 2 requires evidence-backed questions and their verification for every principle. */
  reviewProtocol?: 2;
  root: string;
  /** Frozen reviewed file contents, separate from live caller context. */
  source?: string;
  before?: string;
  target: ReviewTarget;
  files: { path: string; status: ChangedFile["status"]; from?: string }[];
  /** Changed files left out of diff.patch, with the reason. */
  omitted: { file: string; reason: string }[];
  /** Changed files no detector could look at, with the reason. */
  unchecked: { file: string; reason: string }[];
  principles: ReviewPrinciple[];
  /** Principles left out, with the reason: switched off, or not downloaded. */
  skipped: { id: string; reason: string }[];
  /** Detectors that failed on a file of the change. */
  failures: { id: string; file: string; error: string }[];
  /** The diff in parts a reviewer reads one by one. */
  parts: DiffPart[];
  /** The estimated size of what a reviewer reads, in tokens. */
  tokens: { diff: number; advice: number };
  /** Where the plan, the diff and the advice were written. */
  dir: string;
}

/** The whole advisory board gets this long per file of the change. The hook gets 1.5 s per event, a review is not waited on per file. */
export const REVIEW_BUDGET_MS = 10_000;
const MAX_FILE_BYTES = 512 * 1024;
const MANIFESTS = new Set([
  "package.json",
  "pubspec.yaml",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "Gemfile",
  "composer.json",
  "build.gradle",
  "build.gradle.kts",
  "pom.xml",
  "Package.swift",
  "deno.json",
  "mix.exs",
]);

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}

function gitOrNull(root: string, args: string[]): string | null {
  try {
    return git(root, args).trim();
  } catch {
    return null;
  }
}

/** The branch a pull request of this repository would go into: origin's default branch, else main or master. */
function defaultBranch(root: string): string | null {
  const remoteHead = gitOrNull(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead) {
    return remoteHead;
  }
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (gitOrNull(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`])) {
      return candidate;
    }
  }
  return null;
}

/**
 * Turns what the user asked to review into two points to compare.
 *
 * - nothing: the local changes when there are any, else the branch against the default branch
 * - `a...b`: what `b` changed since it left `a`, as a pull request shows it
 * - `a..b`: `a` against `b`
 * - one ref: what the current commit changed since it left that ref
 */
export function resolveTarget(root: string, spec?: string): ReviewTarget {
  if (spec === undefined || spec === "") {
    const status = git(root, ["status", "--porcelain"]).trim();
    if (status !== "") {
      return { base: "HEAD", head: null, label: "local changes against HEAD" };
    }
    const branch = defaultBranch(root);
    if (branch === null) {
      throw new Error("There are no local changes, and no default branch to compare this branch with. Name what to review, such as main...HEAD.");
    }
    return { base: mergeBase(root, branch, "HEAD"), head: "HEAD", label: `HEAD against ${branch}` };
  }
  if (spec === "local") return { base: git(root, ["rev-parse", "HEAD"]).trim(), head: null, label: "uncommitted tracked and untracked changes" };
  if (spec.includes("...")) {
    const [left, right] = spec.split("...");
    const head = right || "HEAD";
    return { base: mergeBase(root, left || "HEAD", head), head, label: `${head} since it left ${left}` };
  }
  if (spec.includes("..")) {
    const [left, right] = spec.split("..");
    return { base: left || "HEAD", head: right || "HEAD", label: `${left} against ${right || "HEAD"}` };
  }
  return { base: mergeBase(root, spec, "HEAD"), head: "HEAD", label: `HEAD since it left ${spec}` };
}

function mergeBase(root: string, a: string, b: string): string {
  const base = gitOrNull(root, ["merge-base", a, b]);
  if (!base) {
    throw new Error(`${a} and ${b} have no common commit. Check that both exist, and fetch them first on a fresh checkout.`);
  }
  return base;
}

function rangeArgs(target: ReviewTarget): string[] {
  if (target.base === null) throw new Error("Git comparison needs a base");
  return target.head === null ? [target.base] : [target.base, target.head];
}

/** The text of a file at `ref`, or on disk when `ref` is null, or why it cannot be had. */
function readAt(root: string, ref: string | null, file: string): { content: string } | { reason: string } {
  let content: string;
  try {
    if (ref === null) {
      const full = path.join(root, file);
      if (fs.statSync(full).size > MAX_FILE_BYTES) {
        return { reason: `larger than ${MAX_FILE_BYTES / 1024} KB` };
      }
      content = fs.readFileSync(full, "utf8");
    } else {
      content = git(root, ["show", `${ref}:${file}`]);
    }
  } catch (error) {
    return { reason: `could not be read: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` };
  }
  if (content.length > MAX_FILE_BYTES) {
    return { reason: `larger than ${MAX_FILE_BYTES / 1024} KB` };
  }
  if (content.includes("\0")) {
    return { reason: "binary" };
  }
  return { content };
}

/** The text of a file at `ref`, or null when it cannot be had. For context the review can do without. */
function contentAt(root: string, ref: string | null, file: string): string | null {
  const read = readAt(root, ref, file);
  return "content" in read ? read.content : null;
}

/** Every file the target changes, with the lines it wrote and removed. Whitespace-only changes and moves do not count as writing. */
export function changedFiles(root: string, target: ReviewTarget): ChangedFile[] {
  const diff = ["-c", "core.quotepath=false", "diff", "--no-color", "--no-ext-diff", "-M"];
  const status = git(root, [...diff, "--name-status", "-z", ...rangeArgs(target)]);
  // The hook's parser, so a detector sees the same lines in a review as while the agent writes.
  const lines = new Map(parsePatch(git(root, [...diff, "-w", "-U0", ...rangeArgs(target)])).map(({ path: file, written, removed }) => [file, { written, removed }]));
  const files: ChangedFile[] = [];
  const parts = status.split("\0").filter((part) => part !== "");
  for (let index = 0; index < parts.length; ) {
    const code = parts[index++] as string;
    const kind = code[0];
    if (kind === "R" || kind === "C") {
      const from = parts[index++] as string;
      const to = parts[index++] as string;
      const change = lines.get(to) ?? { written: [], removed: [] };
      files.push({ path: to, status: kind === "R" ? "renamed" : "added", ...(kind === "R" ? { from } : {}), ...change });
      continue;
    }
    const file = parts[index++] as string;
    const change = lines.get(file) ?? { written: [], removed: [] };
    if (kind === "D") {
      files.push({ path: file, status: "deleted", written: [], removed: [] });
    } else if (kind === "A") {
      files.push({ path: file, status: "added", ...change });
    } else {
      files.push({ path: file, status: "modified", ...change });
    }
  }
  if (target.head === null) {
    const untracked = git(root, ["-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter((file) => file !== "");
    for (const file of untracked) {
      const content = contentAt(root, null, file);
      const all = content === null ? [] : content.split("\n").map((text, index) => ({ line: index + 1, text }));
      files.push({ path: file, status: "added", written: all, removed: [] });
    }
  }
  return files;
}

/** Lockfiles change with every dependency bump and say nothing a reviewer reads line by line. */
const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "pubspec.lock", "Cargo.lock", "go.sum", "poetry.lock", "uv.lock", "Gemfile.lock", "composer.lock", "Podfile.lock"]);
/** What code generators write at the top of what they generate: build_runner and freezed, Go, and the `@generated` convention. */
const GENERATED_HEADER = /GENERATED CODE - DO NOT MODIFY|Code generated .* DO NOT EDIT|@generated\b/;
/** How far down a generated header may be. */
const HEADER_LINES = 10;

/** One file's part of the diff. */
interface DiffBlock {
  file: string;
  text: string;
}

/**
 * The diff a reviewer reads, with context, untracked files included as new ones.
 *
 * Only generated code is left out of it, and listed in `omitted`: lockfiles,
 * files marked as generated and files that say so in their first lines.
 * Boring code can have bugs too. The detectors still see every file, when it
 * is text and not too large.
 */
function readableDiff(root: string, target: ReviewTarget, files: ChangedFile[]): { blocks: DiffBlock[]; omitted: ReviewPlan["omitted"] } {
  let diff = git(root, ["-c", "core.quotepath=false", "diff", "--no-color", "--no-ext-diff", "-M", ...rangeArgs(target)]);
  if (target.head === null) {
    const tracked = new Set(git(root, ["-c", "core.quotepath=false", "diff", "--name-only", "-z", ...rangeArgs(target)]).split("\0"));
    for (const file of files) {
      if (tracked.has(file.path) || file.status !== "added") {
        continue;
      }
      try {
        git(root, ["diff", "--no-color", "--no-index", "--", "/dev/null", file.path]);
      } catch (error) {
        // `git diff --no-index` exits with 1 when the files differ, which they always do here.
        const stdout = (error as { stdout?: string }).stdout;
        if (typeof stdout === "string") {
          diff += stdout;
        }
      }
    }
  }
  const generated = generatedFiles(root, files);
  const blocks: DiffBlock[] = [];
  const omitted: ReviewPlan["omitted"] = [];
  for (const text of diff.split(/^(?=diff --git )/m)) {
    const name = /^diff --git a\/.* b\/(.*)$/m.exec(text)?.[1];
    if (name === undefined) {
      continue;
    }
    const content = target.head === null ? contentAt(root, null, name) : contentAt(root, target.head, name);
    const reason = omissionOf(name, content, generated);
    if (reason !== null) {
      omitted.push({ file: name, reason });
      continue;
    }
    blocks.push({ file: name, text });
  }
  return { blocks, omitted };
}

/** Why a file's diff is left out of what the reviewer reads, or null when it is kept. */
function omissionOf(file: string, content: string | null, generated: ReadonlySet<string>): string | null {
  if (generated.has(file)) {
    return "marked linguist-generated";
  }
  if (LOCKFILES.has(path.posix.basename(file))) {
    return "a lockfile";
  }
  const top = content?.split("\n", HEADER_LINES).join("\n") ?? "";
  if (GENERATED_HEADER.test(top)) {
    return "generated, as its first lines say";
  }
  return null;
}

/** The diff of each part is at most this large, so any agent reads a part in one go: Codex cuts the middle out of output over 10k tokens. */
export const PART_BYTES = 30 * 1024;

/** A slice of the diff for one read: whole files, or whole hunks of one long file. */
export interface DiffPart {
  /** Relative to the review directory. */
  file: string;
  bytes: number;
  files: string[];
}

/** A diff is about this many bytes per token, a little less than prose, so estimates err on the large side. */
const BYTES_PER_TOKEN = 3;

export function tokensOf(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

/** A long file's diff cut at its hunks, each piece with the file's header, none larger than `max` unless one hunk is. */
function splitAtHunks(block: DiffBlock, max: number): DiffBlock[] {
  const [header, ...hunks] = block.text.split(/^(?=@@ )/m);
  const pieces: DiffBlock[] = [];
  let current = "";
  for (const hunk of hunks) {
    if (current !== "" && Buffer.byteLength(header + current + hunk) > max) {
      pieces.push({ file: block.file, text: header + current });
      current = "";
    }
    current += hunk;
  }
  pieces.push({ file: block.file, text: header + current });
  return pieces;
}

/**
 * Packs the diff into parts of at most `max` bytes along the folder tree: a
 * folder that fits stays together, a larger one is split at its subfolders,
 * and only a single file that is too large is split at its hunks. Neighbours
 * that fit together share a part, so a small change stays one part.
 */
export function packDiff(blocks: DiffBlock[], max: number = PART_BYTES): DiffBlock[][] {
  const size = (group: DiffBlock[]): number => group.reduce((sum, block) => sum + Buffer.byteLength(block.text), 0);
  const pack = (members: DiffBlock[], depth: number): DiffBlock[][] => {
    if (size(members) <= max) {
      return [members];
    }
    if (members.length === 1) {
      return splitAtHunks(members[0] as DiffBlock, max).map((piece) => [piece]);
    }
    // The members of this folder by their next path segment, a file being its own segment.
    const children = new Map<string, DiffBlock[]>();
    for (const block of members) {
      const segments = block.file.split("/");
      const key = depth < segments.length - 1 ? `${segments[depth]}/` : (segments[depth] as string);
      children.set(key, [...(children.get(key) ?? []), block]);
    }
    if (children.size === 1) {
      return pack(members, depth + 1);
    }
    const groups = [...children.values()].flatMap((child) => pack(child, depth + 1));
    // Siblings that fit together share a part.
    const merged: DiffBlock[][] = [];
    for (const group of groups) {
      const last = merged.at(-1);
      if (last !== undefined && size(last) + size(group) <= max) {
        last.push(...group);
      } else {
        merged.push([...group]);
      }
    }
    return merged;
  };
  const sorted = [...blocks].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return sorted.length === 0 ? [] : pack(sorted, 0);
}

/** Writes the parts into `dir/<into>` with an index, and returns them. */
function writeParts(dir: string, into: string, parts: DiffBlock[][]): DiffPart[] {
  fs.mkdirSync(path.join(dir, into), { recursive: true });
  const written: DiffPart[] = [];
  parts.forEach((part, index) => {
    const file = `${into}/part-${String(index + 1).padStart(2, "0")}.patch`;
    const text = part.map((block) => block.text).join("");
    fs.writeFileSync(path.join(dir, file), text);
    written.push({ file, bytes: Buffer.byteLength(text), files: [...new Set(part.map((block) => block.file))] });
  });
  const index = ["# Parts of the change", "", "Read every part in full. Each holds whole folders or files, or whole hunks of one long file.", ""];
  for (const part of written) {
    index.push(`- ${part.file}: ${Math.round(part.bytes / 1024)} KB: ${part.files.join(", ")}`);
  }
  fs.writeFileSync(path.join(dir, into, "index.md"), `${index.join("\n")}\n`);
  return written;
}

/** The changed files the repository marks as generated with `linguist-generated` in `.gitattributes`, as GitHub reads it. */
function generatedFiles(root: string, files: ChangedFile[]): Set<string> {
  if (files.length === 0) {
    return new Set();
  }
  const out = gitOrNull(root, ["check-attr", "-z", "linguist-generated", "--", ...files.map((file) => file.path)]) ?? "";
  const parts = out.split("\0");
  const generated = new Set<string>();
  for (let index = 0; index + 2 < parts.length; index += 3) {
    if (parts[index + 2] === "set" || parts[index + 2] === "true") {
      generated.add(parts[index] as string);
    }
  }
  return generated;
}

/** What the planner needs to know about the project to tell which principles cannot apply to it. */
function projectFacts(root: string, target: ReviewTarget, files: ChangedFile[]): string {
  const ref = target.head ?? "HEAD";
  const tracked = git(root, ["-c", "core.quotepath=false", "ls-tree", "-r", "--name-only", ref]).split("\n").filter((file) => file !== "");
  const top = [...new Set(tracked.map((file) => (file.includes("/") ? `${file.slice(0, file.indexOf("/"))}/` : file)))].sort();
  const manifests = tracked.filter((file) => {
    const isManifest = MANIFESTS.has(path.posix.basename(file));
    const isVendored = file.includes("node_modules/");
    const isShallow = file.split("/").length <= 4;
    return isManifest && !isVendored && isShallow;
  });
  const extensions = new Map<string, number>();
  for (const file of tracked) {
    const ext = path.posix.extname(file) || "(none)";
    extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
  }
  const common = [...extensions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const lines = [
    "# The project",
    "",
    `Top level: ${top.join(", ")}`,
    "",
    `Project files: ${manifests.length > 0 ? manifests.join(", ") : "none found"}`,
    "",
    `File types in the repository: ${common.map(([ext, count]) => `${ext} ${count}`).join(", ")}`,
    "",
    `Files this change touches: ${files.map((file) => file.path).join(", ")}`,
  ];
  for (const manifest of manifests.slice(0, 8)) {
    const content = contentAt(root, target.head, manifest);
    if (content !== null) {
      lines.push("", `## ${manifest}`, "", "```", content.split("\n").slice(0, 60).join("\n"), "```");
    }
  }
  const readme = tracked.find((file) => /^readme(\.md)?$/i.test(file));
  const readmeText = readme === undefined ? null : contentAt(root, target.head, readme);
  if (readme !== undefined && readmeText !== null) {
    const firstLines = readmeText.split("\n").slice(0, 40).join("\n");
    lines.push("", `## ${readme}, first lines`, "", firstLines);
  }
  return `${lines.join("\n")}\n`;
}

function fileOf(id: string): string {
  return `principles/${id.replace(/[^A-Za-z0-9_.-]/g, "__")}.md`;
}

/**
 * Prepares a review of `target` in `dir`: the diff, the project, every
 * principle on the advisory board with its full advice, and where the
 * detectors fired in the change.
 *
 * Every principle that is not switched off is in the plan, with or without a
 * detector. Deciding which ones cannot apply to this project is the
 * reviewing agent's job, because nothing in a principle says so reliably.
 */
export async function planReview(cwd: string, spec?: string, dir?: string, lockfile: Lockfile = readLockfile(), label?: string): Promise<ReviewPlan> {
  const root = findProjectRoot(cwd);
  if (root === null || gitOrNull(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    throw new Error("A review needs a git repository. Run it inside one.");
  }
  const resolved = resolveTarget(root, spec);
  const target = { ...resolved, base: git(root, ["rev-parse", resolved.base as string]).trim(), head: resolved.head === null ? null : git(root, ["rev-parse", resolved.head]).trim() };
  const files = changedFiles(root, target);
  return prepareCollected({ root, target: { ...target, kind: "git", label: label ?? target.label }, files,
    readable: readableDiff(root, target, files), context: projectFacts(root, target, files),
    read: (file, previous) => readAt(root, previous ? target.base : target.head, file) }, dir, lockfile);
}

export async function planInputReview(root: string, options: InputOptions = {}, dir?: string, lockfile: Lockfile = readLockfile()): Promise<ReviewPlan> {
  return prepareCollected(collectInput(root, options), dir, lockfile);
}

async function prepareCollected(input: CollectedInput, dir: string | undefined, lockfile: Lockfile): Promise<ReviewPlan> {
  const { root, target, files } = input;
  const out = dir ? path.resolve(dir) : fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-review-"));
  if (path.resolve(out) === path.resolve(root)) throw new Error("Review output must not overwrite the project root");
  if (fs.existsSync(path.join(out, "plan.json"))) throw new Error("Review directory is already prepared; choose a new output directory");
  for (const sub of ["principles", "verdicts", "verified"]) {
    fs.mkdirSync(path.join(out, sub), { recursive: true });
  }

  const source = path.join(out, "source");
  const captured = new Map<string, { content: string } | { reason: string }>();
  const previous = new Map<string, { content: string } | { reason: string }>();
  for (const file of files) {
    const now = input.read(file.path, false), was = input.read(file.path, true);
    captured.set(file.path, now); previous.set(file.path, was);
    if ("content" in now) {
      const dest = path.join(source, file.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, now.content);
    }
    if ("content" in was) {
      const dest = path.join(out, "before", file.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, was.content);
    }
  }
  const off = new Set(switchedOff(root).keys());
  const skipped: ReviewPlan["skipped"] = [];
  const principles: ReviewPrinciple[] = [];
  const advice = new Map<string, string>();
  const runnable: Lockfile = { syncedAt: lockfile.syncedAt, entries: [] };
  for (const entry of lockfile.entries) {
    if (off.has(entry.id)) {
      skipped.push({ id: entry.id, reason: "switched off with the disable skill" });
      continue;
    }
    const cached = readCached(entry.hash);
    if (!cached) {
      skipped.push({ id: entry.id, reason: "not downloaded, run the sync skill" });
      continue;
    }
    const detector = hasDetector(cached.manifest);
    // A principle without a detector is never switched on, it has no switch. Its advice is what a review is for.
    if (detector && !entry.enabled) {
      skipped.push({ id: entry.id, reason: "switched off on the website" });
      continue;
    }
    if (detector) {
      runnable.entries.push(entry);
    }
    const { manifest } = cached;
    principles.push({ id: entry.id, version: entry.version, title: manifest.title, summary: manifest.summary, tags: manifest.tags ?? [], detector, hits: [], file: fileOf(entry.id) });
    advice.set(entry.id, cached.advice);
  }

  const failures: ReviewPlan["failures"] = [];
  const byId = new Map(principles.map((principle) => [principle.id, principle]));
  const unchecked: ReviewPlan["unchecked"] = [];
  for (const file of files) {
    if (runnable.entries.length === 0) {
      break;
    }
    const value = (file.status === "deleted" ? previous : captured).get(file.path) ?? { reason: "source missing" };
    const event = "content" in value
      ? { ctx: fileCtx(file.status === "deleted" ? "delete" : "write", file.path, value.content,
        file.status === "deleted" ? {} : { written: file.written, removed: file.removed },
        { root: toPosix(root), isNew: file.status === "added" }) }
      : value;
    if (!("ctx" in event)) {
      unchecked.push({ file: file.path, reason: event.reason });
      continue;
    }
    const { ctx } = event;
    const run = await runBoard(ctx, runnable, new Set(), null, Number.POSITIVE_INFINITY, REVIEW_BUDGET_MS);
    for (const failure of run.failures) {
      failures.push({ id: failure.id, file: file.path, error: failure.error });
    }
    for (const { principle, findings } of run.firings) {
      const reviewed = byId.get(principle.id);
      for (const finding of findings) {
        reviewed?.hits.push({ file: finding.file ?? file.path, line: finding.line ?? null, text: describeFinding(ctx, finding) ?? `the file ${file.path}` });
      }
    }
  }

  for (const principle of principles) {
    const hits = principle.hits.map((hit) => `- ${hit.file}: ${hit.text}`);
    const body = [
      `<principle id="${principle.id}" title=${JSON.stringify(principle.title)} tags="${principle.tags.join(", ")}" detector="${principle.detector ? "yes" : "no"}">`,
      "",
      advice.get(principle.id) ?? "",
      "",
      ...(hits.length > 0 ? ["Its detector fired in this change. Each hit is a candidate: confirm it or dismiss it with a reason.", "", ...hits, ""] : []),
      "</principle>",
    ];
    fs.writeFileSync(path.join(out, principle.file), `${body.join("\n")}\n`);
  }

  const readable = input.readable;
  const diffText = readable.blocks.map((block) => block.text).join("");
  fs.writeFileSync(path.join(out, "diff.patch"), diffText);
  const parts = writeParts(out, "diff", packDiff(readable.blocks));
  copySteps(out);
  fs.writeFileSync(path.join(out, "project.md"), input.context);
  const plan: ReviewPlan = {
    reviewProtocol: 2,
    root: toPosix(root),
    source: toPosix(source),
    before: toPosix(path.join(out, "before")),
    target,
    files: files.map(({ path: file, status, from }) => ({ path: file, status, ...(from ? { from } : {}) })),
    omitted: readable.omitted,
    unchecked,
    principles,
    skipped,
    failures,
    parts,
    tokens: { diff: tokensOf(Buffer.byteLength(diffText)), advice: principles.reduce((sum, principle) => sum + adviceTokens(out, principle.file), 0) },
    dir: toPosix(out),
  };
  fs.writeFileSync(path.join(out, "principles.md"), renderIndex(plan));
  fs.writeFileSync(path.join(out, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

/** One line per principle, for the agent to decide which cannot apply to the project and how to group the rest. */
function renderIndex(plan: ReviewPlan): string {
  const lines = ["# The principles", "", "id | detector hits | tags | title: summary", ""];
  for (const principle of plan.principles) {
    const hits = principle.detector ? String(principle.hits.length) : "no detector";
    lines.push(`- ${principle.id} | ${hits} | ${principle.tags.join(", ") || "no tags"} | ${principle.title}: ${principle.summary}`);
  }
  return `${lines.join("\n")}\n`;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function renderPlan(plan: ReviewPlan): string {
  const hits = plan.principles.reduce((sum, principle) => sum + principle.hits.length, 0);
  const fired = plan.principles.filter((principle) => principle.hits.length > 0).length;
  const lines = [
    `Review of ${plan.target.label} in ${plan.root}`,
    `${count(plan.files.length, plan.target.kind === "snapshot" ? "selected file" : "changed file")} in ${count(plan.parts.length, "part")}, about ${plan.tokens.diff} tokens of ${plan.target.kind === "snapshot" ? "source" : "diff"}.`,
    `${count(plan.principles.length, "principle")}, about ${plan.tokens.advice} tokens of advice, ${count(hits, "detector hit")} from ${count(fired, "principle")}.`,
    `Review directory: ${plan.dir}`,
  ];
  if (plan.files.length === 0) {
    lines.push(plan.target.kind === "snapshot" ? "No reviewable source files in the selected scope; inspect exclusions in plan.json." : "The change is empty: there is nothing to review.");
  }
  if (plan.principles.length === 0 && plan.skipped.length === 0) {
    lines.push("No advisory board on this machine. Sign in with the login skill, or on a CI runner set WELLACTUALLY_TOKEN to a token from the website, and run the review again.");
  }
  const notes = [
    plan.omitted.length > 0 ? `${count(plan.omitted.length, "file")} left out${plan.target.kind === "snapshot" ? "" : " as generated"}` : null,
    plan.unchecked.length > 0 ? `${count(plan.unchecked.length, "file")} no detector could read` : null,
    plan.skipped.length > 0 ? `${count(plan.skipped.length, "principle")} left out` : null,
    plan.failures.length > 0 ? `${count(plan.failures.length, "detector failure")}` : null,
  ].filter((note) => note !== null);
  if (notes.length > 0) {
    lines.push(`${notes.join(", ")}, each with its reason in plan.json.`);
  }
  return lines.join("\n");
}

/** The estimated tokens of a principle's advice file in the review directory. */
function adviceTokens(dir: string, file: string): number {
  return tokensOf(fs.statSync(path.join(dir, file)).size);
}

/** The instructions of each step of the review, which ship beside the review skill. */
const STEP_FILES = ["splitter.md", "reviewer.md", "verifier.md", "testing.md", "findings.md"];

/** The folder of the review skill: beside the command in the plugin, or in this repository. */
function stepsSource(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++) {
    for (const candidate of [".", "skills/review", "skills/wellactually-review"]) {
      if (fs.existsSync(path.join(dir, candidate, "reviewer.md"))) {
        return path.join(dir, candidate);
      }
    }
    dir = path.dirname(dir);
  }
  return null;
}

/** Copies the step instructions into the review directory, so every subagent finds them next to its inputs. */
function copySteps(out: string): void {
  const source = stepsSource();
  if (source === null) {
    return;
  }
  fs.mkdirSync(path.join(out, "steps"), { recursive: true });
  for (const file of STEP_FILES) {
    fs.copyFileSync(path.join(source, file), path.join(out, "steps", file));
  }
}

/**
 * What a reviewer may be handed, by default. An agent starts a subagent with
 * about 85k tokens of its own system prompt and tools, so its advice and its
 * diff fit a 200k window with room left for the files it opens.
 */
export const DEFAULT_BUDGET = 100_000;

/** One reviewer's work: which parts of the diff it reads, with which principles. */
export interface ReviewJob {
  id: string;
  parts: string[];
  principles: string[];
  /** The change set it reviews, or null for the whole change. */
  set: string | null;
}

export interface ReviewRoute {
  route: "single" | "sets";
  budget: number;
  tokens: { diff: number; advice: number };
  /** The principles in groups that each fit half the budget, so every reviewer has room for its diff. */
  groups: string[][];
  /** A change set's diff may have this many bytes. */
  setBytes: number;
  /** The reviewers to start, when the route is single. With change sets, they come once the sets are built. */
  jobs: ReviewJob[];
}

interface Scope {
  inScope: string[];
  outOfScope: { id: string; reason: string }[];
}

function readJson<T>(dir: string, file: string): T {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) {
    throw new Error(`${file} is missing in ${dir}. Run the step that writes it first.`);
  }
  return JSON.parse(fs.readFileSync(full, "utf8")) as T;
}

/**
 * Decides how the review runs, from what the reviewers would read and not
 * from what a model thinks it has room for, which no model can tell.
 *
 * The principles the router kept are grouped so a group's advice fits half
 * the budget. The whole change goes to one reviewer per group when it fits
 * beside the largest group, else the change is cut into change sets first.
 */
export function routeReview(dir: string, budget: number = DEFAULT_BUDGET): ReviewRoute {
  const plan = readJson<ReviewPlan>(dir, "plan.json");
  const scope = fs.existsSync(path.join(dir, "scope.json"))
    ? readJson<Scope>(dir, "scope.json")
    : { inScope: plan.principles.map((principle) => principle.id), outOfScope: [] };
  if (!fs.existsSync(path.join(dir, "scope.json"))) {
    fs.writeFileSync(path.join(dir, "scope.json"), `${JSON.stringify(scope, null, 2)}\n`);
  }
  const byId = new Map(plan.principles.map((principle) => [principle.id, principle]));
  const placed = new Set([...scope.inScope, ...scope.outOfScope.map((out) => out.id)]);
  // A principle the router forgot is checked, not dropped.
  const kept = [...scope.inScope.filter((id) => byId.has(id)), ...plan.principles.filter((principle) => !placed.has(principle.id)).map((principle) => principle.id)];
  const groups: string[][] = [];
  let groupTokens = 0;
  for (const id of kept) {
    const tokens = adviceTokens(dir, (byId.get(id) as ReviewPrinciple).file);
    const last = groups.at(-1);
    if (last === undefined || groupTokens + tokens > budget / 2) {
      groups.push([id]);
      groupTokens = tokens;
    } else {
      last.push(id);
      groupTokens += tokens;
    }
  }
  const advice = kept.reduce((sum, id) => sum + adviceTokens(dir, (byId.get(id) as ReviewPrinciple).file), 0);
  const largest = Math.max(0, ...groups.map((group) => group.reduce((sum, id) => sum + adviceTokens(dir, (byId.get(id) as ReviewPrinciple).file), 0)));
  const room = budget - largest;
  const route: ReviewRoute["route"] = plan.tokens.diff <= room ? "single" : "sets";
  const jobs: ReviewJob[] =
    route === "single" ? groups.map((principles, index) => ({ id: groups.length === 1 ? "all" : `all-g${index + 1}`, parts: plan.parts.map((part) => part.file), principles, set: null })) : [];
  const result: ReviewRoute = { route, budget, tokens: { diff: plan.tokens.diff, advice }, groups, setBytes: room * BYTES_PER_TOKEN, jobs };
  fs.writeFileSync(path.join(dir, "route.json"), `${JSON.stringify(result, null, 2)}\n`);
  if (route === "single") {
    fs.writeFileSync(path.join(dir, "jobs.json"), `${JSON.stringify(jobs, null, 2)}\n`);
  }
  return result;
}

export function renderRoute(route: ReviewRoute): string {
  const lines = [`${route.tokens.advice} tokens of advice in ${count(route.groups.length, "group")}, ${route.tokens.diff} tokens of diff, a budget of ${route.budget} per reviewer.`];
  if (route.route === "single") {
    lines.push(`Route: single. ${count(route.jobs.length, "reviewer")} for the whole change, listed in jobs.json.`);
  } else {
    lines.push(`Route: sets. Cut the change into change sets of at most ${Math.floor(route.setBytes / 1024)} KB of diff each, then run the command with --sets.`);
  }
  return lines.join("\n");
}

interface ChangeSets {
  sets: { name: string; files: string[]; why?: string }[];
  crossing?: string[];
}

/**
 * Builds the change sets the splitter chose: each set's diff in parts, and
 * one reviewer per set and principle group in jobs.json. Every file of the
 * diff must be in exactly one set, so nothing falls between them.
 */
export function buildSets(dir: string): ReviewJob[] {
  const plan = readJson<ReviewPlan>(dir, "plan.json");
  const route = readJson<ReviewRoute>(dir, "route.json");
  const chosen = readJson<ChangeSets>(dir, "sets.json");
  const blocks = new Map<string, DiffBlock[]>();
  for (const part of plan.parts) {
    const text = fs.readFileSync(path.join(dir, part.file), "utf8");
    for (const piece of text.split(/^(?=diff --git )/m)) {
      const name = /^diff --git a\/.* b\/(.*)$/m.exec(piece)?.[1];
      if (name !== undefined) {
        blocks.set(name, [...(blocks.get(name) ?? []), { file: name, text: piece }]);
      }
    }
  }
  const seen = new Map<string, string>();
  const problems: string[] = [];
  for (const set of chosen.sets) {
    for (const file of set.files) {
      if (!blocks.has(file)) {
        problems.push(`${file} in "${set.name}" is not in the diff`);
      } else if (seen.has(file)) {
        problems.push(`${file} is in "${seen.get(file)}" and in "${set.name}"`);
      } else {
        seen.set(file, set.name);
      }
    }
  }
  for (const file of blocks.keys()) {
    if (!seen.has(file)) {
      problems.push(`${file} is in no set`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`The change sets need fixing:\n- ${problems.join("\n- ")}`);
  }
  const jobs: ReviewJob[] = [];
  chosen.sets.forEach((set, index) => {
    const id = `set-${String(index + 1).padStart(2, "0")}`;
    const parts = writeParts(dir, `sets/${id}`, packDiff(set.files.flatMap((file) => blocks.get(file) ?? [])));
    // Even without applicable principles, large changes need per-set discovery and testing.
    const groups = route.groups.length === 0 ? [[]] : route.groups;
    groups.forEach((principles, group) => {
      jobs.push({ id: groups.length === 1 ? id : `${id}-g${group + 1}`, parts: parts.map((part) => part.file), principles, set: id });
    });
  });
  fs.writeFileSync(path.join(dir, "jobs.json"), `${JSON.stringify(jobs, null, 2)}\n`);
  return jobs;
}

export function renderSets(jobs: ReviewJob[]): string {
  const sets = new Set(jobs.map((job) => job.set)).size;
  return `${count(sets, "change set")}, ${count(jobs.length, "reviewer")} listed in jobs.json.`;
}

/** A budget as the user writes it: 100000, 100k or 1m. */
export function parseBudget(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(text.trim());
  if (!match) {
    throw new Error(`"${text}" is no budget. Write a number of tokens, such as 100k or 1m.`);
  }
  const scale = { "": 1, k: 1000, m: 1_000_000 }[(match[2] as string).toLowerCase() as "" | "k" | "m"];
  return Math.round(Number(match[1]) * scale);
}

export type ReviewStage = "review" | "test" | "verify" | "report";

interface Investigation {
  status: "complete" | "limited" | "not_applicable";
  reason: string;
  questions: { question: string; answer: string; evidence: string[] }[];
  limits: string[];
}

interface VerdictFile {
  job: string;
  verdicts: { principle: string; verdict: string; findings?: unknown[]; investigation?: Investigation }[];
  outside: unknown[];
}

/** Checks completion from artifacts, rather than an agent's successful exit or reported count. */
export function checkReview(dir: string, stage: string): { stage: ReviewStage; jobs: number; units: number; candidates: number } {
  const stages: ReviewStage[] = ["review", "test", "verify", "report"];
  const through = stages.indexOf(stage as ReviewStage);
  if (through < 0) {
    throw new Error(`Unknown review stage "${stage}". Use review, test, verify or report.`);
  }
  const route = readJson<ReviewRoute>(dir, "route.json");
  const jobs = readJson<ReviewJob[]>(dir, "jobs.json");
  const problems: string[] = [];
  if (!["single", "sets"].includes(route.route) || !Array.isArray(jobs) || (jobs.length === 0 && (route.route !== "single" || !Array.isArray(route.groups) || route.groups.length !== 0))) {
    throw new Error("Review routing is incomplete: zero jobs require a single route with no principle groups.");
  }
  const planFile = fs.existsSync(path.join(dir, "plan.json")) ? readJson<ReviewPlan>(dir, "plan.json") : null;
  const investigationRecords: unknown[] = [];
  const auditRecords: unknown[] = [];
  const inquiries = new Map<string, { job: string; principle: string; limited: boolean }[]>();
  const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(nonempty);
  const candidates = new Map<string, string[]>();
  const verifiedCandidates = new Map<string, string>();
  const units = jobs.length === 0 ? ["all"] : [...new Set(jobs.map((job) => job.set ?? "all"))];
  if (route.route === "sets") {
    units.push("crossing");
  }
  const expectedFiles = new Set(jobs.map((job) => job.id));
  if (route.route === "sets") {
    expectedFiles.add("crossing");
  }
  if (expectedFiles.size !== jobs.length + (route.route === "sets" ? 1 : 0)) {
    problems.push("jobs.json has duplicate or reserved job ids");
  }
  const load = <T>(file: string): T | null => {
    try {
      const value = readJson<T>(dir, file);
      if (value === null) {
        throw new Error("must contain an artifact, not null");
      }
      return value;
    } catch (error) {
      problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  const requireText = (file: string): void => {
    try {
      if (fs.readFileSync(path.join(dir, file), "utf8").trim() === "") {
        problems.push(`${file} is empty`);
      }
    } catch {
      problems.push(`${file} is missing or unreadable`);
    }
  };
  if (fs.existsSync(path.join(dir, "plan.json")) && fs.existsSync(path.join(dir, "scope.json"))) {
    const plan = load<ReviewPlan>("plan.json");
    const scope = load<Scope>("scope.json");
    if (plan !== null && scope !== null) {
      const excluded = new Set(scope.outOfScope.map((entry) => entry.id));
      for (const principle of plan.principles) {
        if (excluded.has(principle.id)) {
          continue;
        }
        for (const unit of units.filter((unit) => unit !== "crossing")) {
          if (!jobs.some((job) => (job.set ?? "all") === unit && job.principles.includes(principle.id))) {
            problems.push(`jobs.json is missing principle ${principle.id} in ${unit}`);
          }
        }
      }
    }
  }
  const findingScopes = ["introduced", "newly_exposed", "incomplete_fix", "pre_existing", "current"];
  const checkScope = (finding: unknown, file: string): void => {
    if (fs.existsSync(path.join(dir, "plan.json"))) {
      const plan = load<ReviewPlan>("plan.json");
      if (plan?.target.kind === "snapshot" && finding !== null && typeof finding === "object" && (finding as { scope?: string }).scope !== "current") {
        problems.push(`${file}: snapshot findings must use scope current; no change baseline exists`);
      }
    }
    if (finding !== null && typeof finding === "object" && (finding as { evidence?: string }).evidence === "proven" && !(finding as { provenTest?: unknown }).provenTest) {
      problems.push(`${file} has a proven finding without provenTest reproduction evidence`);
    }
    if (finding === null || typeof finding !== "object" || !findingScopes.includes((finding as { scope: string }).scope)) {
      problems.push(`${file} has a finding without a valid scope`);
    }
  };
  const verdicts = (stem: string, unit: string, expected: string[], job: string): void => {
    const file = `verdicts/${stem}.json`;
    const value = load<VerdictFile>(file);
    if (value === null) {
      return;
    }
    if (value.job !== job || !Array.isArray(value.verdicts) || !Array.isArray(value.outside)) {
      problems.push(`${file} needs job "${job}", verdicts and outside arrays`);
      return;
    }
    const seen = new Set<string>();
    const refs = candidates.get(unit) ?? [];
    for (const verdict of value.verdicts) {
      if (seen.has(verdict.principle)) {
        problems.push(`${file} repeats principle ${verdict.principle}`);
      }
      seen.add(verdict.principle);
      if (!expected.includes(verdict.principle)) {
        problems.push(`${file} has unassigned principle ${verdict.principle}`);
      }
      if (!["not_applicable", "followed", "findings"].includes(verdict.verdict)) {
        problems.push(`${file} has an invalid verdict for ${verdict.principle}`);
      }
      if (planFile?.reviewProtocol === 2 || verdict.investigation !== undefined) {
        const inquiry = verdict.investigation;
        investigationRecords.push({ job, principle: verdict.principle, ...inquiry });
        const label = `${file} investigation for ${verdict.principle}`;
        if (!inquiry || !["complete", "limited", "not_applicable"].includes(inquiry.status) || !nonempty(inquiry.reason) || !Array.isArray(inquiry.questions) || !texts(inquiry.limits)) {
          problems.push(`${label} needs status, reason, questions and limits`);
        } else {
          if ((inquiry.status === "not_applicable") !== (verdict.verdict === "not_applicable")) problems.push(`${label} applicability must agree with its verdict`);
          if (inquiry.questions.length === 0) problems.push(`${label} needs answered questions and evidence`);
          for (const question of inquiry.questions) {
            if (!question || !nonempty(question.question) || !nonempty(question.answer) || !texts(question.evidence) || question.evidence.length === 0) problems.push(`${label} has an unanswered or unsupported question`);
          }
          if (inquiry.status === "limited" && inquiry.limits.length === 0) problems.push(`${label} must name its unresolved limits`);
          if (inquiry.status !== "limited" && inquiry.limits.length !== 0) problems.push(`${label} with unresolved limits must use limited status`);
        }
        const entries = inquiries.get(unit) ?? [];
        entries.push({ job, principle: verdict.principle, limited: inquiry?.status === "limited" });
        inquiries.set(unit, entries);
      }
      if (verdict.verdict === "findings" && (!Array.isArray(verdict.findings) || verdict.findings.length === 0)) {
        problems.push(`${file} has no findings for ${verdict.principle}`);
      }
      if (verdict.findings !== undefined && !Array.isArray(verdict.findings)) {
        problems.push(`${file} findings for ${verdict.principle} must be an array`);
      } else {
        verdict.findings?.forEach((finding, index) => {
          checkScope(finding, file);
          refs.push(`${stem}:${verdict.principle}:${index}`);
        });
      }
    }
    for (const id of expected) {
      if (!seen.has(id)) {
        problems.push(`${file} is missing principle ${id}`);
      }
    }
    value.outside.forEach((finding, index) => {
      checkScope(finding, file);
      refs.push(`${stem}:outside:${index}`);
    });
    candidates.set(unit, refs);
  };
  for (const job of jobs) {
    if (new Set(job.principles).size !== job.principles.length) {
      problems.push(`jobs.json repeats an assigned principle in ${job.id}`);
    }
    verdicts(job.id, job.set ?? "all", job.principles, job.id);
  }
  if (route.route === "sets") {
    verdicts("crossing", "crossing", [], "crossing");
  }
  if (through >= 1) {
    for (const unit of units) {
      const results = `probes/${unit}/results.md`;
      try {
        if (fs.readFileSync(path.join(dir, results), "utf8").trim() === "") {
          problems.push(`${results} is empty`);
        }
      } catch {
        problems.push(`${results} is missing or unreadable`);
      }
      const stem = `testing-${unit}`;
      expectedFiles.add(stem);
      verdicts(stem, unit, [], unit);
    }
  }
  const verdictDir = path.join(dir, "verdicts");
  if (fs.existsSync(verdictDir)) {
    for (const file of fs.readdirSync(verdictDir).filter((file) => file.endsWith(".json"))) {
      const stem = file.slice(0, -5);
      if (!expectedFiles.has(stem) && (through >= 1 || !stem.startsWith("testing-"))) {
        problems.push(`Unexpected verdicts/${file}; it is not an assigned job or testing unit`);
      }
    }
  }
  if (through >= 2) {
    for (const unit of units) {
      const expectedInquiries = inquiries.get(unit) ?? [];
      if (expectedInquiries.length) {
        const file = `investigations/${unit}.json`;
        const audit = load<{ job: string; principle: string; status: string; reason: string; limits: string[] }[]>(file);
        if (audit !== null) {
          if (!Array.isArray(audit)) problems.push(`${file} must be an array`);
          else {
            auditRecords.push(...audit.map((entry) => ({ unit, ...entry })));
            const seen = new Set<string>();
            for (const entry of audit) {
              const key = `${entry?.job}:${entry?.principle}`;
              const original = expectedInquiries.find((item) => item.job === entry?.job && item.principle === entry?.principle);
              if (!original || seen.has(key)) problems.push(`${file} has duplicate or unknown investigation ${key}`);
              seen.add(key);
              if (!entry || !["checked", "limited"].includes(entry.status) || !nonempty(entry.reason) || !texts(entry.limits)) problems.push(`${file} audit ${key} needs status, reason and limits`);
              else if ((entry.status === "limited") !== (entry.limits.length > 0) || (original?.limited && entry.status !== "limited")) problems.push(`${file} audit ${key} must retain unresolved limits`);
            }
            for (const item of expectedInquiries) if (!seen.has(`${item.job}:${item.principle}`)) problems.push(`${file} is missing investigation ${item.job}:${item.principle}`);
          }
        }
      }
      const file = `verified/${unit}.json`;
      const verified = load<{ candidate: string; status: string; promoted?: boolean; file?: string; line?: number; priority?: string; evidence?: string; problem?: string; fix?: string }[]>(file);
      if (verified === null) {
        continue;
      }
      if (!Array.isArray(verified)) {
        problems.push(`${file} must be an array`);
        continue;
      }
      const expected = new Set(candidates.get(unit) ?? []);
      if (expected.size === 0) {
        requireText(`challenges/${unit}.md`);
      }
      const seen = new Set<string>();
      for (const [index, entry] of verified.entries()) {
        if (!["confirmed", "plausible", "refuted"].includes(entry.status)) {
          problems.push(`${file} has an invalid verification status`);
        }
        if (entry.promoted === true && !entry.candidate && entry.file && typeof entry.line === "number" && entry.priority && entry.evidence && entry.problem && entry.fix) {
          checkScope(entry, file);
          verifiedCandidates.set(`${file}:${index}`, entry.status);
          continue;
        }
        if (!expected.has(entry.candidate)) {
          problems.push(`${file} has unknown candidate ${String(entry.candidate)}`);
        }
        if (seen.has(entry.candidate)) {
          problems.push(`${file} repeats candidate ${entry.candidate}`);
        }
        seen.add(entry.candidate);
        verifiedCandidates.set(entry.candidate, entry.status);
      }
      for (const ref of expected) {
        if (!seen.has(ref)) {
          problems.push(`${file} is missing candidate ${ref}`);
        }
      }
    }
  }
  if (through >= 2 && fs.existsSync(path.join(dir, "verified"))) {
    for (const file of fs.readdirSync(path.join(dir, "verified")).filter((file) => file.endsWith(".json"))) {
      if (!units.includes(file.slice(0, -5))) {
        problems.push(`Unexpected verified/${file}; it is not an assigned verification unit`);
      }
    }
  }
  if (through >= 3 && problems.length === 0) {
    const report = load<{ complete: boolean; verdicts: { principle: string; verdict: string }[]; findings: { candidate?: string; candidates?: string[] }[]; outside: { candidate?: string; candidates?: string[] }[]; dismissed: unknown[]; outOfScope: unknown[] }>("findings.json");
    if (report !== null) {
      if (investigationRecords.length) {
        const retained = report as unknown as { investigations?: unknown[]; investigationAudits?: unknown[] };
        const ordered = (entries: unknown[]): string => JSON.stringify(entries.map((entry) => JSON.stringify(entry)).sort());
        if (!Array.isArray(retained.investigations) || ordered(retained.investigations) !== ordered(investigationRecords)) problems.push("findings.json must retain every investigation answer and limit");
        if (!Array.isArray(retained.investigationAudits) || ordered(retained.investigationAudits) !== ordered(auditRecords)) problems.push("findings.json must retain every investigation audit and limit");
      }
      if (report.complete !== true) {
        problems.push("findings.json must declare complete: true after all steps pass");
      }
      for (const field of ["verdicts", "findings", "outside", "dismissed", "outOfScope"] as const) {
        if (!Array.isArray(report[field])) {
          problems.push(`findings.json needs a ${field} array`);
        }
      }
      if (Array.isArray(report.verdicts)) {
        const expected = new Set(jobs.flatMap((job) => job.principles));
        const seen = new Set<string>();
        for (const verdict of report.verdicts) {
          if (!["not_applicable", "followed", "findings"].includes(verdict.verdict)) {
            problems.push(`findings.json has an invalid verdict for ${verdict.principle}`);
          }
          if (seen.has(verdict.principle) || !expected.has(verdict.principle)) {
            problems.push(`findings.json has duplicate or unassigned principle ${verdict.principle}`);
          }
          seen.add(verdict.principle);
        }
        for (const id of expected) {
          if (!seen.has(id)) {
            problems.push(`findings.json is missing principle ${id}`);
          }
        }
      }
      if (Array.isArray(report.findings) && Array.isArray(report.outside)) {
        const retained = new Set<string>();
        for (const finding of [...report.findings, ...report.outside]) {
          checkScope(finding, "findings.json");
          const refs = finding.candidates ?? (finding.candidate ? [finding.candidate] : []);
          if (!Array.isArray(refs) || refs.length === 0) {
            problems.push("findings.json has a finding without source candidates");
            continue;
          }
          for (const ref of refs) {
            const status = verifiedCandidates.get(ref);
            if (status === undefined || status === "refuted") {
              problems.push(`findings.json retains unknown or refuted candidate ${ref}`);
            }
            if (retained.has(ref)) {
              problems.push(`findings.json repeats candidate ${ref}`);
            }
            retained.add(ref);
          }
        }
        for (const [ref, status] of verifiedCandidates) {
          if (status !== "refuted" && !retained.has(ref)) {
            problems.push(`findings.json is missing surviving candidate ${ref}`);
          }
        }
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`Review ${stage} is incomplete:\n- ${problems.join("\n- ")}`);
  }
  return { stage: stage as ReviewStage, jobs: jobs.length, units: units.length, candidates: [...candidates.values()].reduce((sum, refs) => sum + refs.length, 0) };
}
