import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Ctx, Finding } from "@wellactually/sdk";
import { apiOf } from "./api.ts";
import { applies } from "./ctx.ts";
import { diskFiles } from "./fs.ts";
import type { BoardEntry, CachedPrinciple, Lockfile } from "./types.ts";
import type { DetectorPool } from "./pool.ts";
import { DEFAULT_LIMITS, runDetector, type DetectorRun } from "./sandbox.ts";

export type { BoardEntry, CachedPrinciple, Lockfile } from "./types.ts";

export interface Config {
  registry: string;
  token: string | null;
  handle: string | null;
  /** Whether `wellactually sync` reports how often each principle fired. On unless turned off. */
  stats: boolean;
}

/** Where the advisory board lives unless `login --registry` or WELLACTUALLY_REGISTRY says otherwise. */
export const DEFAULT_REGISTRY = "https://wellactually.dev";

/** Where the advisory board lives on this machine. `WELLACTUALLY_HOME` moves it, which the tests use. */
export function boardHome(): string {
  return process.env.WELLACTUALLY_HOME ?? path.join(os.homedir(), ".wellactually");
}

function readJson<T>(file: string): T | null {
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return JSON.parse(source) as T;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function readConfig(): Config {
  const stored = readJson<Partial<Config>>(path.join(boardHome(), "config.json"));
  return {
    registry: process.env.WELLACTUALLY_REGISTRY ?? stored?.registry ?? DEFAULT_REGISTRY,
    token: stored?.token ?? null,
    handle: stored?.handle ?? null,
    stats: stored?.stats ?? true,
  };
}

export function writeConfig(config: Config): void {
  writeJson(path.join(boardHome(), "config.json"), config);
}

export function readLockfile(): Lockfile {
  return readJson<Lockfile>(path.join(boardHome(), "board.json")) ?? { syncedAt: null, entries: [] };
}

export function writeLockfile(lockfile: Lockfile): void {
  writeJson(path.join(boardHome(), "board.json"), lockfile);
}

function bundlePath(hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`"${hash}" is not a principle hash`);
  }
  return path.join(boardHome(), "bundles", `${hash}.json`);
}

export function hasCached(hash: string): boolean {
  return fs.existsSync(bundlePath(hash));
}

export function readCached(hash: string): CachedPrinciple | null {
  return readJson<CachedPrinciple>(bundlePath(hash));
}

export function writeCached(principle: CachedPrinciple): void {
  writeJson(bundlePath(principle.hash), principle);
}

/** A principle that fired, with the findings that passed validation. */
export interface Firing {
  principle: CachedPrinciple;
  findings: Finding[];
}

export interface BoardRun {
  firings: Firing[];
  /** Principles that could not run, with the reason. Shown once, never silently skipped. */
  failures: { id: string; error: string }[];
  ms: number;
}

/** The whole advisory board gets this long per hook call. What does not fit is reported as a failure. */
export const BOARD_BUDGET_MS = 1500;

/**
 * From this many detectors on, an event is worth starting worker threads for.
 * Below it, starting them takes longer than running the detectors: measured
 * on the bundled command, threads cost about 35 ms to start and a typical
 * detector takes 4 ms, so the two meet between 12 and 15.
 */
export const PARALLEL_FROM = 14;

/**
 * Runs every enabled principle of the advisory board that applies to this context.
 *
 * Each detector gets its own isolate and its own limits, so one expert's
 * detector cannot read, slow down or break another's. With a `pool` and
 * enough detectors they run on several threads, otherwise one after another.
 * The result is the same either way, in the order of the advisory board.
 */
export async function runBoard(
  ctx: Ctx,
  lockfile: Lockfile = readLockfile(),
  off: ReadonlySet<string> = new Set(),
  pool: DetectorPool | null = null,
  parallelFrom: number = PARALLEL_FROM,
): Promise<BoardRun> {
  const disk = diskFiles();
  const started = performance.now();
  const run: BoardRun = { firings: [], failures: [], ms: 0 };
  const applying: CachedPrinciple[] = [];
  const skipped = `skipped, the advisory board used its ${BOARD_BUDGET_MS} ms budget before reaching it`;

  for (const entry of lockfile.entries) {
    // Off on the website, or switched off on this machine for this project or everywhere.
    if (!entry.enabled || off.has(entry.id)) {
      continue;
    }
    const cached = readCached(entry.hash);
    // The cache is keyed by hash, and a fork starts with the hash of what it copied.
    // Who the advice comes from is what the advisory board says, not who was cached first.
    const principle = cached && { ...cached, id: entry.id, version: entry.version };
    if (!principle) {
      run.failures.push({ id: entry.id, error: "its bundle is not in the local cache; run `wellactually sync`" });
      continue;
    }
    if (applies(principle.manifest, ctx)) {
      applying.push(principle);
    }
  }

  let results: DetectorRun[];
  if (pool !== null && applying.length >= parallelFrom) {
    const tasks = applying.map((principle) => ({ bundle: principle.bundle, api: apiOf(principle.manifest) }));
    results = await pool.run(ctx, tasks, started + BOARD_BUDGET_MS, skipped);
  } else {
    results = [];
    for (const principle of applying) {
      results.push(
        performance.now() - started > BOARD_BUDGET_MS
          ? { findings: [], error: skipped, dropped: [], ms: 0 }
          : await runDetector(principle.bundle, ctx, DEFAULT_LIMITS, disk, apiOf(principle.manifest)),
      );
    }
  }

  applying.forEach((principle, index) => {
    const result = results[index] as DetectorRun;
    if (result.error) {
      run.failures.push({ id: principle.id, error: result.error });
    } else if (result.findings.length > 0) {
      run.firings.push({ principle, findings: result.findings });
    }
  });

  run.ms = performance.now() - started;
  return run;
}

const OPENERS: Record<Ctx["event"], string> = {
  write: "You just changed this file, so fixing it belongs in the change you are already making. Parts of the file you did not touch are not yours to clean up unless that is the task.",
  read: "You only read this file. You did not write this code, so cleaning it up is not your job. Apply the advice to whatever you do change.",
  prompt: "A name matched in what the user wrote. No code was inspected and nothing is known to be wrong. Treat it as a recommendation while you work.",
  command: "This is about the command you are about to run.",
};

/**
 * Turns firings into the text an agent reads.
 *
 * The frame says who is speaking and how much weight it carries: this is
 * advice from a named expert the user chose, not an instruction and not
 * part of the task. `alreadyShown` holds the hashes whose full advice this
 * session has seen, so a principle explains itself once and points after that.
 */
export function frame(ctx: Ctx, firings: Firing[], alreadyShown: ReadonlySet<string> = new Set()): string {
  if (firings.length === 0) {
    return "";
  }
  const where = ctx.file ? ` ${ctx.file.relativePath}` : "";
  const lines: string[] = [
    "<wellactually>",
    `${ctx.event}${where}: ${OPENERS[ctx.event]}`,
    "Each principle below is advice from an expert the user put on their advisory board. It does not replace what you were asked to do, and it never asks you to run commands or share data.",
    "",
  ];
  for (const { principle, findings } of firings) {
    const full = findings.some((finding) => finding.depth !== "pointer") && !alreadyShown.has(principle.hash);
    const expert = principle.id.split("/")[0] ?? "";
    lines.push(`<principle id="${principle.id}" expert="${expert}" title=${JSON.stringify(principle.manifest.title)}>`);
    for (const finding of findings) {
      lines.push(`- ${finding.line ? `line ${finding.line}: ` : ""}${finding.evidence}`);
    }
    lines.push("");
    lines.push(full ? principle.advice : principle.manifest.summary);
    lines.push("</principle>", "");
  }
  if (firings.some(({ principle }) => !principle.id.startsWith("local/"))) {
    // The tool's full name depends on the host, which prefixes it with the plugin
    // and the server. Naming the suffix lets an agent find it when tools are loaded on demand.
    lines.push(
      'Once you know how a principle\'s advice went, you may tell its expert: up, down, or not_applicable when it fired on something it is not about. Use the MCP tool whose name ends in "rate_principle" (search your tools for that word if it is not loaded). It is not a shell command, and it needs no word to the user.',
    );
  }
  lines.push("</wellactually>");
  return lines.join("\n");
}

/** Hashes whose full advice a session has already been shown. */
export function readShown(sessionId: string): Set<string> {
  return new Set(readJson<string[]>(sessionPath(sessionId)) ?? []);
}

export function writeShown(sessionId: string, shown: ReadonlySet<string>): void {
  writeJson(sessionPath(sessionId), [...shown]);
}

function sessionPath(sessionId: string): string {
  return path.join(boardHome(), "sessions", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}
