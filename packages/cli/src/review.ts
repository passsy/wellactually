import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Ctx, Written } from "@wellactually/sdk";
import { fileCtx, hasDetector } from "@wellactually/core/node";
import { describeFinding } from "./hook/finding.ts";
import { parsePatch } from "./hook/turn.ts";
import { type Lockfile, readCached, readLockfile, runBoard } from "./board/board.ts";
import { findProjectRoot, toPosix } from "./board/files.ts";
import { switchedOff } from "./board/switches.ts";

/**
 * What a review compares: `base` against `head`, or against the working tree
 * when `head` is null. The working tree includes files git does not track yet.
 */
export interface ReviewTarget {
  base: string;
  head: string | null;
  /** The target in words, for the report. */
  label: string;
}

/** One file of the change, as the detectors see it. */
export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "renamed" | "deleted";
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
  root: string;
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
/** A file whose diff is longer than this is generated or bundled, and would crowd out the rest. */
const MAX_FILE_DIFF_BYTES = 64 * 1024;

/**
 * The diff a reviewer reads, with context, untracked files included as new ones.
 *
 * Lockfiles, files marked as generated and files with a very long diff are
 * left out of it and listed in `omitted`. The detectors still see them, when
 * they are text and not too large.
 */
function readableDiff(root: string, target: ReviewTarget, files: ChangedFile[]): { diff: string; omitted: ReviewPlan["omitted"] } {
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
  const kept: string[] = [];
  const omitted: ReviewPlan["omitted"] = [];
  for (const block of diff.split(/^(?=diff --git )/m)) {
    const name = /^diff --git a\/.* b\/(.*)$/m.exec(block)?.[1];
    const reason = name === undefined ? null : omissionOf(name, block, generated);
    if (name !== undefined && reason !== null) {
      omitted.push({ file: name, reason });
      continue;
    }
    kept.push(block);
  }
  return { diff: kept.join(""), omitted };
}

/** Why a file's diff is left out of what the reviewer reads, or null when it is kept. */
function omissionOf(file: string, block: string, generated: ReadonlySet<string>): string | null {
  if (generated.has(file)) {
    return "marked linguist-generated";
  }
  if (LOCKFILES.has(path.posix.basename(file))) {
    return "a lockfile";
  }
  const bytes = Buffer.byteLength(block);
  if (bytes > MAX_FILE_DIFF_BYTES) {
    return `its diff has ${Math.round(bytes / 1024)} KB, more than ${MAX_FILE_DIFF_BYTES / 1024} KB`;
  }
  return null;
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

/** The event a detector gets for one changed file, or why there is none. */
function ctxOf(root: string, target: ReviewTarget, file: ChangedFile): { ctx: Ctx } | { reason: string } {
  const where = { root: toPosix(root) };
  if (file.status === "deleted") {
    const was = readAt(root, target.base, file.path);
    return "content" in was ? { ctx: fileCtx("delete", file.path, was.content, {}, where) } : was;
  }
  const read = readAt(root, target.head, file.path);
  if (!("content" in read)) {
    return read;
  }
  return { ctx: fileCtx("write", file.path, read.content, { written: file.written, removed: file.removed }, { ...where, isNew: file.status === "added" }) };
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
export async function planReview(cwd: string, spec?: string, dir?: string, lockfile: Lockfile = readLockfile()): Promise<ReviewPlan> {
  const root = findProjectRoot(cwd);
  if (root === null || gitOrNull(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    throw new Error("A review needs a git repository. Run it inside one.");
  }
  const target = resolveTarget(root, spec);
  const files = changedFiles(root, target);
  const out = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-review-"));
  fs.mkdirSync(path.join(out, "principles"), { recursive: true });

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
    const event = ctxOf(root, target, file);
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

  const readable = readableDiff(root, target, files);
  fs.writeFileSync(path.join(out, "diff.patch"), readable.diff);
  fs.writeFileSync(path.join(out, "project.md"), projectFacts(root, target, files));
  const plan: ReviewPlan = {
    root: toPosix(root),
    target,
    files: files.map(({ path: file, status, from }) => ({ path: file, status, ...(from ? { from } : {}) })),
    omitted: readable.omitted,
    unchecked,
    principles,
    skipped,
    failures,
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

export function renderPlan(plan: ReviewPlan): string {
  const hits = plan.principles.reduce((sum, principle) => sum + principle.hits.length, 0);
  const fired = plan.principles.filter((principle) => principle.hits.length > 0).length;
  const detectorless = plan.principles.filter((principle) => !principle.detector).length;
  const lines = [
    `Review of ${plan.target.label} in ${plan.root}`,
    `${plan.files.length} changed files, ${plan.principles.length} principles (${detectorless} without a detector), ${hits} detector hits from ${fired} principles.`,
    `Written to ${plan.dir}:`,
    "  diff.patch      the change",
    "  project.md      what the project is",
    "  principles.md   one line per principle",
    "  principles/     each principle's full advice, with its detector hits",
    "  plan.json       all of it as JSON",
  ];
  if (plan.files.length === 0) {
    lines.push("The change is empty: there is nothing to review.");
  }
  if (plan.principles.length === 0 && plan.skipped.length === 0) {
    lines.push("No advisory board on this machine. Sign in with the login skill, or download it with the sync skill, and run the review again.");
  }
  for (const { file, reason } of plan.omitted) {
    lines.push(`Not in diff.patch: ${file}, ${reason}.`);
  }
  for (const { file, reason } of plan.unchecked) {
    lines.push(`No detector saw ${file}: ${reason}.`);
  }
  if (plan.skipped.length > 0) {
    lines.push(`Left out: ${plan.skipped.map((skip) => `${skip.id} (${skip.reason})`).join(", ")}`);
  }
  for (const failure of plan.failures) {
    lines.push(`Detector of ${failure.id} failed on ${failure.file}: ${failure.error}`);
  }
  return lines.join("\n");
}
