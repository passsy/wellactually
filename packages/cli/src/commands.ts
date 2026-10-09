import fs from "node:fs";
import path from "node:path";
import {
  apiOf,
  applies,
  buildPrinciple,
  diskFiles,
  projectRootOf,
  toPosix,
  checkPrinciple,
  isPrincipleId,
  PRINCIPLE_ID_RULE,
  fileCtx,
  frame,
  probeRepo,
  readLockfile,
  readPrincipleDir,
  runDetector,
  textCtx,
  writeCached,
  writeFileMap,
  writeLockfile,
  type BuiltPrinciple,
  type CheckReport,
  type DetectorRun,
  type ProbeReport,
  type SwitchResult,
} from "@wellactually/core/node";
import type { Ctx } from "@wellactually/sdk";
import { fetchHistory, publishDraft, pullSource, type DraftResult, type History } from "./registry.ts";

/**
 * The verbs behind both the command line and the MCP server.
 *
 * Each returns data. Rendering it for a terminal or for an agent is the
 * caller's job, which is what keeps the two front ends saying the same thing.
 */

export interface TestResult {
  id: string | null;
  title: string | null;
  report: CheckReport;
}

/** A principle's id is the name of its folder. */
function idOf(dir: string): string {
  return path.basename(path.resolve(dir));
}

/** The check a principle directory has to pass, including that its folder name can be an id. */
async function checkDir(dir: string) {
  const { built, report } = await checkPrinciple(readPrincipleDir(path.resolve(dir)));
  const id = idOf(dir);
  if (isPrincipleId(id)) {
    return { id, built, report };
  }
  const problem = `the folder name "${id}" is the principle's id and must be ${PRINCIPLE_ID_RULE}; rename the folder`;
  return { id, built, report: { ...report, ok: false, problems: [problem, ...report.problems] } };
}

export async function testPrinciple(dir: string): Promise<TestResult> {
  const { id, built, report } = await checkDir(dir);
  return { id, title: built?.manifest.title ?? null, report };
}

export interface TryInput {
  /** A file to show the detector as if the agent had just written it. */
  file?: string;
  /** Treat `file` as read rather than written. */
  read?: boolean;
  prompt?: string;
  command?: string;
}

export interface TryResult {
  /** False when the detector's events or globs exclude this input, so it never ran. */
  applies: boolean;
  run: DetectorRun | null;
  /** What the agent would be shown, empty when nothing fired. */
  injected: string;
}

export async function tryPrinciple(dir: string, input: TryInput): Promise<TryResult> {
  const built = await buildPrinciple(readPrincipleDir(path.resolve(dir)));
  const ctx = tryCtx(input);
  if (!applies(built.manifest, ctx)) {
    return { applies: false, run: null, injected: "" };
  }
  const run = await runDetector(built.bundle, ctx, undefined, diskFiles(), apiOf(built.manifest));
  const injected = frame(ctx, run.findings.length > 0 ? [{ principle: asLocal(built, idOf(dir)), findings: run.findings }] : []);
  return { applies: true, run, injected };
}

function tryCtx(input: TryInput): Ctx {
  const here = projectRootOf(process.cwd());
  if (input.prompt !== undefined) {
    return textCtx("prompt", input.prompt, here === null ? null : toPosix(here));
  }
  if (input.command !== undefined) {
    return textCtx("command", input.command, here === null ? null : toPosix(here));
  }
  if (input.file === undefined) {
    throw new Error("pass a file, --prompt or --command");
  }
  // Like the hook: the project root is the repository the file is in, when it is in one.
  const absolute = path.resolve(input.file);
  const root = projectRootOf(path.dirname(absolute));
  const relative = path.relative(root ?? process.cwd(), absolute);
  const shown = relative.startsWith("..") ? path.basename(absolute) : toPosix(relative);
  return fileCtx(input.read ? "read" : "write", shown, fs.readFileSync(absolute, "utf8"), undefined, { root: root === null ? null : toPosix(root), absolute: toPosix(absolute) });
}

export async function probePrinciple(dir: string, repo: string): Promise<ProbeReport> {
  const built = await buildPrinciple(readPrincipleDir(path.resolve(dir)));
  return probeRepo(built, path.resolve(repo));
}

export async function publishPrinciple(dir: string, note = ""): Promise<DraftResult> {
  const id = idOf(dir);
  if (!isPrincipleId(id)) {
    throw new Error(`The folder name "${id}" is the principle's id and must be ${PRINCIPLE_ID_RULE}. Rename the folder, then publish again.`);
  }
  return publishDraft(id, readPrincipleDir(path.resolve(dir)), note);
}

export async function principleHistory(id: string): Promise<History> {
  return fetchHistory(id);
}

const CHANGE_MARKS = { added: "A", modified: "M", removed: "D" } as const;

/** A principle's history in the shape of `git log --name-status`. */
export function renderHistory(result: History): string {
  const lines: string[] = [];
  for (const entry of result.history) {
    const label = entry.status === "draft" ? " (draft, not released)" : "";
    lines.push(`version ${entry.version}${label}  ${entry.hash.slice(0, 12)}`);
    lines.push(`Date:   ${entry.date.slice(0, 16).replace("T", " ")}`);
    lines.push("");
    lines.push(`    ${entry.note || (entry.changed.length === 0 ? "First release" : "(no note)")}`);
    if (entry.changed.length > 0) {
      lines.push("");
      for (const file of entry.changed) {
        lines.push(`${CHANGE_MARKS[file.change]}       ${file.path}`);
      }
    }
    lines.push("");
  }
  lines.push(`${result.id} is ${result.visibility}. Get a version with: wellactually pull ${result.id}@<version>`);
  return lines.join("\n");
}

export interface PullResult {
  id: string;
  version: number;
  status: "draft" | "released";
  dir: string;
  files: string[];
}

/**
 * Brings a principle from the registry into a directory, ready for `wellactually test` and `wellactually publish`.
 *
 * This is the other half of editing in the browser: whatever was saved there
 * is what arrives here. An existing directory is only replaced with `force`,
 * because replacing it discards local edits.
 */
export async function pullPrinciple(id: string, dir: string | undefined, force: boolean): Promise<PullResult> {
  const source = await pullSource(id);
  const target = path.resolve(dir ?? source.id.split("/")[1] ?? "principle");
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    if (!force) {
      throw new Error(`${target} already has files. Pass --force to replace them with the registry's version.`);
    }
    for (const name of Object.keys(readPrincipleDir(target))) {
      fs.rmSync(path.join(target, name));
    }
  }
  writeFileMap(target, source.files);
  return { id: source.id, version: source.version, status: source.status, dir: target, files: Object.keys(source.files).sort() };
}

export function renderPull(result: PullResult): string {
  const what = result.status === "draft" ? `the draft of version ${result.version}` : `version ${result.version}`;
  return `Pulled ${what} of ${result.id} into ${result.dir} (${result.files.length} files).\nEdit it, then: wellactually test ${result.dir} && wellactually publish ${result.dir}`;
}

function asLocal(built: BuiltPrinciple, id: string) {
  return { ...built, id: `local/${id}`, version: 0 };
}

/**
 * Puts a principle from a directory on this machine's advisory board, without a registry.
 *
 * It has to pass the same check a published one does. The advisory board pins the
 * hash, so editing the directory changes nothing until it is added again.
 */
export async function addLocal(dir: string): Promise<TestResult> {
  const { id, built, report } = await checkDir(dir);
  if (!built || !report.ok) {
    return { id, title: built?.manifest.title ?? null, report };
  }
  const principle = asLocal(built, id);
  writeCached(principle);
  const lockfile = readLockfile();
  const entries = lockfile.entries.filter((entry) => entry.id !== principle.id);
  entries.push({ id: principle.id, version: 0, hash: principle.hash, enabled: true });
  writeLockfile({ ...lockfile, entries });
  return { id: principle.id, title: built.manifest.title, report };
}

/** Takes a local principle off the advisory board. Registry entries are removed on the website. */
export function removeLocal(id: string): boolean {
  const lockfile = readLockfile();
  const wanted = id.startsWith("local/") ? id : `local/${id}`;
  const entries = lockfile.entries.filter((entry) => entry.id !== wanted);
  if (entries.length === lockfile.entries.length) {
    return false;
  }
  writeLockfile({ ...lockfile, entries });
  return true;
}

export function renderReport(result: TestResult): string {
  const lines: string[] = [];
  if (result.id) {
    lines.push(`${result.id}  ${result.title ?? ""}`.trimEnd());
  }
  let file = "";
  for (const item of result.report.tests) {
    if (item.file !== file) {
      file = item.file;
      lines.push(`  ${file}`);
    }
    lines.push(`    ${item.passed ? "✓" : "✗"} ${item.name}`);
    if (!item.passed) {
      lines.push(...item.message.split("\n").map((line) => `        ${line}`));
    }
  }
  if (result.report.tests.length > 0) {
    lines.push(`  Slowest detector run ${result.report.slowestMs.toFixed(1)} ms.`);
  }
  for (const warning of result.report.warnings) {
    lines.push(`  ! ${warning}`);
  }
  if (result.report.ok) {
    lines.push("Ready to publish.");
  } else {
    lines.push("Not ready:");
    for (const problem of result.report.problems) {
      lines.push(`  - ${problem}`);
    }
  }
  return lines.join("\n");
}

/** What to tell whoever switched a principle off or on. */
export function renderSwitch(result: SwitchResult, on: boolean): string {
  const where = result.scope === "global" ? "everywhere on this machine" : "in this project";
  if (!on) {
    return `${result.id} is off ${where}. Recorded in ${result.file}.`;
  }
  if (result.stillOff.length > 0) {
    const other = result.stillOff.includes("global") ? "everywhere on this machine" : "in this project";
    return `${result.id} is no longer switched off ${where}, but it is still off ${other}. Switch it on there too to make it run.`;
  }
  return `${result.id} runs again ${where}.`;
}

export function renderProbe(report: ProbeReport): string {
  const lines = [
    `Scanned ${report.scanned} files, ${report.matched} matched the globs, ${report.fired} fired (${report.findings} findings). Slowest run ${report.slowestMs.toFixed(1)} ms.`,
    report.verdict,
  ];
  for (const sample of report.samples) {
    lines.push(`  ${sample.path}${sample.line ? `:${sample.line}` : ""}  ${sample.evidence}`);
  }
  for (const failure of report.errors.slice(0, 10)) {
    lines.push(`  ✗ ${failure.path}  ${failure.error}`);
  }
  return lines.join("\n");
}

export function renderTry(result: TryResult): string {
  if (!result.applies || !result.run) {
    return "The events and globs that detector.ts exports do not select this input, so the detector does not run.";
  }
  const { run } = result;
  if (run.error) {
    return `The detector failed: ${run.error}`;
  }
  const lines = [`${run.findings.length} findings in ${run.ms.toFixed(1)} ms.`];
  for (const dropped of run.dropped) {
    lines.push(`Dropped: ${dropped}`);
  }
  if (result.injected) {
    lines.push("", "The agent would be shown:", "", result.injected);
  }
  return lines.join("\n");
}
