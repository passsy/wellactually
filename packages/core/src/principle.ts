import { TEST_ROOT, type Ctx, type EventName, type Finding } from "@wellactually/sdk";
import { buildBundle, buildTestBundle, BundleError, byteLength, detectorEntry, type FileMap } from "./bundle.ts";
import { applies, fileCtx, textCtx } from "./ctx.ts";
import { languagesOf, ManifestError, parsePrinciple, readSettings, type Manifest } from "./manifest.ts";
import { mapProject, type ProjectFiles } from "./project.ts";
import { readExports, runTestBundle, type DetectorRun } from "./sandbox.ts";
import { scanAdvice } from "./scan.ts";

/** A principle that compiled: everything a host needs to run it. */
export interface BuiltPrinciple {
  manifest: Manifest;
  advice: string;
  /** The detector as one script for the isolate. */
  bundle: string;
  /** Identifies this exact manifest, advice and bundle. An advisory board pins it. */
  hash: string;
}

/** One `detect(event)` call a test made, as the host saw it. */
export interface DetectCall {
  event: EventName;
  /** The path of the file from the project root, for file events. */
  path: string | null;
  /** The folder of the principle that was the project, when the test named one. */
  project: string | null;
  /** The file content, the prompt or the command, cut off when long. */
  text: string;
  /** The lines that counted as written. Null when the event has no file. */
  written: number[] | null;
  /** False when the detector's events or globs did not select the event, so it never ran. */
  ran: boolean;
  findings: Finding[];
  ms: number;
}

export interface TestResult {
  /** The test file. */
  file: string;
  name: string;
  passed: boolean;
  /** Why it failed. Empty when it passed. */
  message: string;
  calls: DetectCall[];
}

export interface CheckReport {
  /** True when the principle may be published. */
  ok: boolean;
  /** What stops it from being published. */
  problems: string[];
  /** What a human should look at. Warnings never block. */
  warnings: string[];
  tests: TestResult[];
  /** The slowest detector run, as a share of the time limit a detector gets. */
  slowestMs: number;
}

export interface Checked {
  /** Null when the principle did not build. */
  built: BuiltPrinciple | null;
  report: CheckReport;
}

const MAX_FILES = 60;
const MAX_TOTAL_BYTES = 512 * 1024;
const MAX_DETECT_CALLS = 300;
const MAX_SHOWN_TEXT = 4000;

/** Refuses a principle that is too large to be one principle. The registry applies it to uploads. */
export function assertFileMapSize(files: FileMap, knownTotal?: number): void {
  const count = Object.keys(files).length;
  if (count > MAX_FILES) {
    throw new ManifestError(`a principle may hold at most ${MAX_FILES} files, this one has ${count}`);
  }
  const total = knownTotal ?? Object.values(files).reduce((sum, content) => sum + byteLength(content), 0);
  if (total > MAX_TOTAL_BYTES) {
    throw new ManifestError(`a principle may hold at most ${MAX_TOTAL_BYTES / 1024} KB, this one has ${Math.ceil(total / 1024)} KB`);
  }
}

/** Compiles a principle. Throws `ManifestError` or `BundleError` with a message for the author. */
export async function buildPrinciple(files: FileMap): Promise<BuiltPrinciple> {
  const source = files["principle.md"];
  if (source === undefined) {
    throw new ManifestError("principle.md is missing");
  }
  const { title, summary, advice } = parsePrinciple(source);
  const bundle = await buildBundle(files);
  let exported: { events?: unknown; globs?: unknown };
  try {
    exported = await readExports(bundle);
  } catch (error) {
    throw new BundleError((error as Error).message);
  }
  const { events, globs } = readSettings(exported);
  const manifest: Manifest = { title, summary, languages: languagesOf(globs), events, globs };
  return { manifest, advice, bundle, hash: await hashPrinciple(manifest, advice, bundle) };
}

/** SHA-256 over manifest, advice and bundle. Uses Web Crypto, which Node, Workers and browsers all have. */
export async function hashPrinciple(manifest: Manifest, advice: string, bundle: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([manifest, advice, bundle]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Builds a principle, runs its tests in the isolate and applies the publish gates.
 *
 * The CLI calls this for `wellactually test`. The registry calls it again on every
 * upload, because a report that came from the author's machine is a claim
 * and one that came from here is a result.
 */
export async function checkPrinciple(files: FileMap): Promise<Checked> {
  const report: CheckReport = { ok: false, problems: [], warnings: [], tests: [], slowestMs: 0 };

  let built: BuiltPrinciple;
  let tests: string | null;
  try {
    assertFileMapSize(files);
    built = await buildPrinciple(files);
    tests = await buildTestBundle(files);
  } catch (error) {
    if (error instanceof ManifestError || error instanceof BundleError) {
      report.problems.push(error.message);
      return { built: null, report };
    }
    throw error;
  }

  report.warnings.push(...scanAdvice(built.advice));

  if (tests === null) {
    const hint = Object.keys(files).some((name) => name.startsWith("cases/"))
      ? " The cases/ folder is no longer read: write each case as a test, for example expect(detect(write(path, content))).toEqual([...])."
      : "";
    report.problems.push(`needs at least one test file named *.test.ts.${hint}`);
    return { built, report };
  }

  const { results, calls, error } = await runTests(built, files, tests);
  if (error) {
    report.problems.push(`The tests could not run: ${error}`);
    return { built, report };
  }
  report.tests = results;
  report.slowestMs = Math.max(0, ...calls.map((call) => call.ms));

  if (results.length === 0) {
    report.problems.push("the test files declare no test");
  }
  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    report.problems.push(`${failed.length} of ${results.length} tests failed`);
  }
  // Counted over tests that pass: a firing nobody asserted on shows nothing.
  const proven = results.filter((result) => result.passed).flatMap((result) => result.calls);
  if (!proven.some((call) => call.findings.length > 0)) {
    report.problems.push("no passing test makes the detector fire, so nothing shows that it ever does");
  }
  if (!proven.some((call) => call.ran && call.findings.length === 0)) {
    report.problems.push(
      "no passing test runs the detector on something it stays quiet on. A detector nobody has seen stay quiet is the one that fires on every file.",
    );
  }

  report.ok = report.problems.length === 0;
  return { built, report };
}

/**
 * Runs the test bundle and answers its `detect` calls with the real detector.
 */
async function runTests(built: BuiltPrinciple, files: FileMap, tests: string): Promise<{ results: TestResult[]; calls: DetectCall[]; error: string | null }> {
  const calls: DetectCall[] = [];
  const byTest = new Map<string, DetectCall[]>();
  let current: DetectCall[] = [];
  const key = (test: { file: string; name: string }): string => `${test.file}\n${test.name}`;

  const { results, error } = await runTestBundle(tests, {
    begin: (test) => {
      current = [];
      byTest.set(key(test), current);
    },
    detect: (call, run) => {
      if (calls.length >= MAX_DETECT_CALLS) {
        return { error: `a principle's tests may call detect() at most ${MAX_DETECT_CALLS} times` };
      }
      return answerDetect(built, files, call, run, (recorded) => {
        calls.push(recorded);
        current.push(recorded);
      });
    },
  });

  return { results: results.map((result) => ({ ...result, calls: byTest.get(key(result)) ?? [] })), calls, error };
}

/**
 * Answers one `detect(event, options)` call of a test with the real detector.
 *
 * Every call is answered the way the hook would: the detector's events and
 * globs first, then a fresh isolate under the normal limits, then the checks
 * every finding has to pass. This one function answers vitest on an author's
 * machine, `wellactually test`, the browser editor and the registry, which is
 * why a test means the same in all four.
 *
 * The project the event happens in is made of the principle's own files: the
 * folder the test named, plus the file of the event. It sits at `TEST_ROOT`.
 */
export function answerDetect(
  built: BuiltPrinciple,
  files: FileMap,
  call: unknown,
  run: (bundle: string, ctx: Ctx, project: ProjectFiles | null) => DetectorRun,
  record: (call: DetectCall) => void = () => {},
): { findings: Finding[] } | { error: string } {
  const { event, options } = (typeof call === "object" && call !== null ? call : {}) as { event?: unknown; options?: { project?: unknown } };
  const ctx = eventCtx(event);
  if (!ctx) {
    return { error: "detect() needs an event from write(), edit(), read(), prompt() or command()" };
  }
  const fixture = options?.project;
  if (fixture !== undefined && typeof fixture !== "string") {
    return { error: "detect(): `project` is the name of a folder of the principle, for example \"fixtures/flutter_app\"" };
  }
  const projectFiles = fixture === undefined ? {} : filesBelow(files, fixture);
  if (projectFiles === null) {
    return { error: `detect(): the principle has no folder "${fixture}" to use as the project` };
  }
  if (ctx.file) {
    // After a write or a read the file is on the disk, so it is in the project too.
    projectFiles[ctx.file.relativePath] = ctx.file.content;
  }

  const recorded: DetectCall = {
    event: ctx.event,
    path: ctx.file?.relativePath ?? null,
    project: fixture ?? null,
    text: ctx.text.length > MAX_SHOWN_TEXT ? `${ctx.text.slice(0, MAX_SHOWN_TEXT)}\n…` : ctx.text,
    written: ctx.file ? ctx.file.written.map((written) => written.line) : null,
    ran: applies(built.manifest, ctx),
    findings: [],
    ms: 0,
  };
  record(recorded);
  if (!recorded.ran) {
    return { findings: [] };
  }
  const result = run(built.bundle, ctx, mapProject(TEST_ROOT, projectFiles));
  recorded.ms = result.ms;
  if (result.error) {
    return { error: `The detector failed: ${result.error}` };
  }
  if (result.dropped.length > 0) {
    return { error: `The host dropped ${result.dropped.join("; ")}.` };
  }
  recorded.findings = result.findings;
  return { findings: result.findings };
}

/** The files of one folder of a principle, with paths from that folder. Null when the folder holds nothing. */
function filesBelow(files: FileMap, folder: string): FileMap | null {
  const prefix = `${folder.replaceAll("\\", "/").replace(/^\.?\/+|\/+$/g, "")}/`;
  if (prefix === "/" || prefix.split("/").includes("..")) {
    return null;
  }
  const below: FileMap = {};
  for (const [name, content] of Object.entries(files)) {
    if (name.startsWith(prefix)) {
      below[name.slice(prefix.length)] = content;
    }
  }
  return Object.keys(below).length === 0 ? null : below;
}

/**
 * Rebuilds the event a test passed to `detect`.
 *
 * It arrives as JSON from code the host does not trust. Only what defines an
 * event is taken from it (kind, path, content, which lines were written,
 * whether the file is new) and everything else is derived again, so a
 * detector under test sees an event with the same guarantees as one from a
 * session. The project root is always `TEST_ROOT`, whatever the event claims.
 */
function eventCtx(raw: unknown): Ctx | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const event = raw as { event?: unknown; text?: unknown; file?: { relativePath?: unknown; content?: unknown; written?: unknown; isNew?: unknown } | null };
  if (event.event === "prompt" || event.event === "command") {
    return typeof event.text === "string" ? textCtx(event.event, event.text) : null;
  }
  const relativePath = event.file?.relativePath;
  if ((event.event !== "write" && event.event !== "read") || typeof relativePath !== "string" || typeof event.file?.content !== "string") {
    return null;
  }
  if (relativePath === "" || relativePath.split("/").includes("..")) {
    return null;
  }
  const lines = event.file.content.split("\n");
  const written = (Array.isArray(event.file.written) ? event.file.written : [])
    .map((entry: unknown) => (entry as { line?: unknown } | null)?.line)
    .filter((line): line is number => typeof line === "number" && Number.isInteger(line) && line >= 1 && line <= lines.length)
    .map((line) => ({ line, text: lines[line - 1] ?? "" }));
  return fileCtx(event.event, relativePath, event.file.content, written, { isNew: event.file.isNew === true });
}

/** Whether a principle directory has the two files that make it one. */
export function looksLikePrinciple(files: FileMap): boolean {
  return "principle.md" in files && detectorEntry(files) !== null;
}
