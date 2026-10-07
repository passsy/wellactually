import type { Ctx, EventName, Finding } from "@wellactually/sdk";
import { buildBundle, BundleError, byteLength, detectorEntry, type FileMap } from "./bundle.ts";
import { applies, fileCtx, textCtx } from "./ctx.ts";
import { languagesOf, ManifestError, parsePrinciple, readSettings, type Manifest } from "./manifest.ts";
import { DEFAULT_LIMITS, readExports, runDetector } from "./sandbox.ts";
import { scanAdvice } from "./scan.ts";

/** A principle that compiled: everything a host needs to run it. */
export interface BuiltPrinciple {
  manifest: Manifest;
  advice: string;
  /** The detector as one script for the isolate. */
  bundle: string;
  /** Identifies this exact manifest, advice and bundle. A board pins it. */
  hash: string;
}

export type CaseKind = "fires" | "quiet";

export interface CaseSpec {
  /** The file name under `cases/`. */
  name: string;
  kind: CaseKind;
  event: EventName;
  /** The project-relative path the detector sees, for file events. */
  path: string;
  content: string;
  /** Lines a `fires` case must report, when the author pinned them. */
  lines: number[] | null;
}

export interface CaseResult {
  name: string;
  kind: CaseKind;
  event: EventName;
  passed: boolean;
  /** One sentence saying what happened, written for the author. */
  message: string;
  findings: Finding[];
  ms: number;
}

export interface CheckReport {
  /** True when the principle may be published. */
  ok: boolean;
  /** What stops it from being published. */
  problems: string[];
  /** What a human should look at. Warnings never block. */
  warnings: string[];
  cases: CaseResult[];
  /** The slowest case, as a share of the time limit a detector gets. */
  slowestMs: number;
}

export interface Checked {
  /** Null when the principle did not build. */
  built: BuiltPrinciple | null;
  report: CheckReport;
}

const MIN_FIRING_CASES = 1;
const MIN_QUIET_CASES = 1;
const MAX_FILES = 60;
const MAX_TOTAL_BYTES = 512 * 1024;
const EXPECT_FILE = "cases/expect.json";

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
 * Builds a principle, runs its cases in the isolate and applies the publish gates.
 *
 * The CLI calls this for `wellactually test`. The registry calls it again on every
 * upload, because a report that came from the author's machine is a claim
 * and one that came from here is a result.
 */
export async function checkPrinciple(files: FileMap): Promise<Checked> {
  const report: CheckReport = { ok: false, problems: [], warnings: [], cases: [], slowestMs: 0 };

  let built: BuiltPrinciple;
  try {
    assertFileMapSize(files);
    built = await buildPrinciple(files);
  } catch (error) {
    if (error instanceof ManifestError || error instanceof BundleError) {
      report.problems.push(error.message);
      return { built: null, report };
    }
    throw error;
  }

  report.warnings.push(...scanAdvice(built.advice));

  let specs: CaseSpec[];
  try {
    specs = readCases(files);
  } catch (error) {
    report.problems.push((error as Error).message);
    return { built, report };
  }

  for (const spec of specs) {
    const result = await runCase(built, spec);
    report.cases.push(result);
    report.slowestMs = Math.max(report.slowestMs, result.ms);
  }

  const firing = specs.filter((spec) => spec.kind === "fires").length;
  const quiet = specs.filter((spec) => spec.kind === "quiet").length;
  if (firing < MIN_FIRING_CASES) {
    report.problems.push(`needs at least ${MIN_FIRING_CASES} case named cases/fires-*, found ${firing}`);
  }
  if (quiet < MIN_QUIET_CASES) {
    report.problems.push(
      `needs at least ${MIN_QUIET_CASES} case named cases/quiet-*, found ${quiet}. A detector nobody has seen stay quiet is the one that fires on every file.`,
    );
  }
  if (firing > 0 && !report.cases.some((result) => result.kind === "fires" && result.passed)) {
    report.problems.push("no cases/fires-* case passes, so nothing shows that the detector ever fires");
  }
  const failed = report.cases.filter((result) => !result.passed);
  if (failed.length > 0) {
    report.problems.push(`${failed.length} of ${report.cases.length} cases failed`);
  }

  report.ok = report.problems.length === 0;
  return { built, report };
}

interface Expectation {
  lines?: number[];
  path?: string;
  event?: EventName;
}

/**
 * Reads the cases out of a principle's files.
 *
 * A case is one file under `cases/`. Its name says what to expect: `fires-*`
 * must produce a finding, `quiet-*` must produce none. Its suffix says what
 * kind of event it is: `.prompt.txt` is something the user typed,
 * `.command.txt` is a shell command, `.read.<ext>` is a file the agent only
 * read, and everything else is a file the agent wrote in full.
 *
 * `cases/expect.json` is optional. It maps a case file to the lines a firing
 * case must report, and to the path the detector should see when the globs
 * care about directories.
 */
export function readCases(files: FileMap): CaseSpec[] {
  let expectations: Record<string, Expectation> = {};
  const expectSource = files[EXPECT_FILE];
  if (expectSource !== undefined) {
    try {
      expectations = JSON.parse(expectSource) as Record<string, Expectation>;
    } catch {
      throw new ManifestError(`${EXPECT_FILE} is not valid JSON`);
    }
  }

  const specs: CaseSpec[] = [];
  for (const [file, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    if (!file.startsWith("cases/") || file === EXPECT_FILE) {
      continue;
    }
    const name = file.slice("cases/".length);
    const kind: CaseKind | null = name.startsWith("fires-") ? "fires" : name.startsWith("quiet-") ? "quiet" : null;
    if (!kind) {
      throw new ManifestError(`cases/${name} must be named fires-* or quiet-*`);
    }
    const expectation = expectations[name] ?? {};
    const inferred = inferEvent(name);
    specs.push({
      name,
      kind,
      event: expectation.event ?? inferred.event,
      path: expectation.path ?? inferred.path,
      content,
      lines: expectation.lines ?? null,
    });
  }
  for (const name of Object.keys(expectations)) {
    if (!(`cases/${name}` in files)) {
      throw new ManifestError(`${EXPECT_FILE} names "${name}", which is not a file under cases/`);
    }
  }
  return specs;
}

function inferEvent(name: string): { event: EventName; path: string } {
  if (/\.prompt\.(txt|md)$/.test(name)) {
    return { event: "prompt", path: name };
  }
  if (/\.command\.(txt|sh)$/.test(name)) {
    return { event: "command", path: name };
  }
  const read = /^(.*)\.read(\.[^.]+)$/.exec(name);
  if (read) {
    return { event: "read", path: `${read[1]}${read[2]}` };
  }
  return { event: "write", path: name };
}

export function caseCtx(spec: CaseSpec): Ctx {
  if (spec.event === "prompt" || spec.event === "command") {
    return textCtx(spec.event, spec.content.trimEnd());
  }
  return fileCtx(spec.event, spec.path, spec.content);
}

async function runCase(built: BuiltPrinciple, spec: CaseSpec): Promise<CaseResult> {
  const ctx = caseCtx(spec);
  const base = { name: spec.name, kind: spec.kind, event: spec.event };

  if (!applies(built.manifest, ctx)) {
    const reason = built.manifest.events.includes(spec.event)
      ? `the globs do not match ${spec.path}`
      : `detector.ts does not list the ${spec.event} event in its events`;
    if (spec.kind === "quiet") {
      return { ...base, passed: true, message: `Quiet: ${reason}, so the detector does not run.`, findings: [], ms: 0 };
    }
    return { ...base, passed: false, message: `Expected a finding, but ${reason}, so the detector never runs.`, findings: [], ms: 0 };
  }

  const run = await runDetector(built.bundle, ctx, DEFAULT_LIMITS);
  const result = { ...base, findings: run.findings, ms: run.ms };
  if (run.error) {
    return { ...result, passed: false, message: `The detector failed: ${run.error}` };
  }
  if (run.dropped.length > 0) {
    return { ...result, passed: false, message: `The host dropped ${run.dropped.join("; ")}.` };
  }

  if (spec.kind === "quiet") {
    if (run.findings.length === 0) {
      return { ...result, passed: true, message: "Quiet, as expected." };
    }
    return { ...result, passed: false, message: `Expected nothing, got ${describeFindings(run.findings)}.` };
  }

  if (run.findings.length === 0) {
    return { ...result, passed: false, message: "Expected a finding, got nothing." };
  }
  if (spec.lines) {
    const reported = run.findings.map((finding) => finding.line).filter((line) => line !== undefined);
    const wanted = [...spec.lines].sort((a, b) => a - b);
    const got = [...reported].sort((a, b) => a - b);
    if (JSON.stringify(wanted) !== JSON.stringify(got)) {
      return {
        ...result,
        passed: false,
        message: `Expected findings on lines ${wanted.join(", ")}, got ${got.length > 0 ? got.join(", ") : "none with a line"}.`,
      };
    }
  }
  return { ...result, passed: true, message: `Fired: ${describeFindings(run.findings)}.` };
}

function describeFindings(findings: Finding[]): string {
  return findings
    .slice(0, 3)
    .map((finding) => `${finding.line ? `line ${finding.line} ` : ""}${JSON.stringify(finding.evidence.slice(0, 60))}`)
    .join(", ")
    .concat(findings.length > 3 ? ` and ${findings.length - 3} more` : "");
}

/** Whether a principle directory has the two files that make it one. */
export function looksLikePrinciple(files: FileMap): boolean {
  return "principle.md" in files && detectorEntry(files) !== null;
}
