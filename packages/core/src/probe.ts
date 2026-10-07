import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { applies, fileCtx } from "./ctx.ts";
import type { BuiltPrinciple } from "./principle.ts";
import { runDetector } from "./sandbox.ts";

export interface ProbeSample {
  path: string;
  line: number | null;
  evidence: string;
}

export interface ProbeReport {
  /** Files in the repository that were readable text. */
  scanned: number;
  /** Files the principle's globs selected, which is what the rate is measured against. */
  matched: number;
  /** Matched files with at least one finding. */
  fired: number;
  /** `fired / matched`, 0 when nothing matched. */
  rate: number;
  findings: number;
  /** The first findings, for the author to judge. */
  samples: ProbeSample[];
  /** Files on which the detector failed, with the reason. */
  errors: { path: string; error: string }[];
  slowestMs: number;
  /** False when the detector fires on too large a share of the files it looks at. */
  ok: boolean;
  verdict: string;
}

/** A detector that fires on more than this share of matched files is a heuristic that is wrong. */
export const MAX_FIRE_RATE = 0.5;
/** Below this many matched files a rate says nothing. */
const MIN_FILES_FOR_VERDICT = 10;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SAMPLES = 20;

/**
 * Runs a principle over every file of a repository as if the agent had just written it.
 *
 * Cases prove a detector on the inputs its author thought of. A probe shows
 * what it does on code nobody wrote for it.
 */
export async function probeRepo(built: BuiltPrinciple, dir: string, maxFiles = 5000): Promise<ProbeReport> {
  const event = built.manifest.events.includes("write") ? "write" : "read";
  const report: ProbeReport = {
    scanned: 0,
    matched: 0,
    fired: 0,
    rate: 0,
    findings: 0,
    samples: [],
    errors: [],
    slowestMs: 0,
    ok: true,
    verdict: "",
  };

  if (!built.manifest.events.includes("write") && !built.manifest.events.includes("read")) {
    report.verdict = "This principle does not listen to file events, so there is nothing to probe in a repository.";
    return report;
  }

  for (const relative of listFiles(dir).slice(0, maxFiles)) {
    const content = readText(path.join(dir, relative));
    if (content === null) {
      continue;
    }
    report.scanned++;
    const ctx = fileCtx(event, relative, content);
    if (!applies(built.manifest, ctx)) {
      continue;
    }
    report.matched++;
    const run = await runDetector(built.bundle, ctx);
    report.slowestMs = Math.max(report.slowestMs, run.ms);
    if (run.error) {
      report.errors.push({ path: relative, error: run.error });
      continue;
    }
    if (run.findings.length === 0) {
      continue;
    }
    report.fired++;
    report.findings += run.findings.length;
    for (const finding of run.findings) {
      if (report.samples.length >= MAX_SAMPLES) {
        break;
      }
      report.samples.push({ path: relative, line: finding.line ?? null, evidence: finding.evidence });
    }
  }

  report.rate = report.matched === 0 ? 0 : report.fired / report.matched;
  const percent = `${Math.round(report.rate * 100)}%`;
  if (report.errors.length > 0) {
    report.ok = false;
    report.verdict = `The detector failed on ${report.errors.length} files.`;
    return report;
  }
  if (report.matched < MIN_FILES_FOR_VERDICT) {
    report.verdict = `Only ${report.matched} files matched the globs, too few to judge a fire rate.`;
    return report;
  }
  if (report.rate > MAX_FIRE_RATE) {
    report.ok = false;
    report.verdict = `Fires on ${percent} of the ${report.matched} files it looks at. Above ${MAX_FIRE_RATE * 100}% a detector is describing the language, not a problem. Add quiet cases from the samples and narrow it.`;
    return report;
  }
  report.verdict = `Fires on ${percent} of the ${report.matched} files it looks at.`;
  return report;
}

/** Tracked files when `dir` is a git repository, every file below it otherwise. */
function listFiles(dir: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    const tracked = out.split("\0").filter((file) => file !== "");
    if (tracked.length > 0) {
      return tracked;
    }
  } catch {
    // Not a git repository: walk the directory instead.
  }
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "build" || entry.name === "dist") {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile()) {
        files.push(path.relative(dir, full).split(path.sep).join("/"));
      }
    }
  };
  walk(dir);
  return files;
}

/** The file as text, or null when it is missing, too large or binary. */
function readText(file: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
    return null;
  }
  const content = fs.readFileSync(file, "utf8");
  if (content.includes("\0")) {
    return null;
  }
  return content;
}
