import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "@wellactually/sdk";
import {
  type HookPayload,
  type Lockfile,
  DetectorPool,
  PARALLEL_FROM,
  boardHome,
  eventsOf,
  forgetShown,
  frame,
  readConfig,
  readLockfile,
  readShown,
  recordDetections,
  runBoard,
  sweepShown,
  switchedOff,
  writeShown,
} from "@wellactually/core/node";
import { excerpt, type HookLogEntry, someFindings } from "./hook-log.ts";
import { noteToolUse } from "./rater.ts";

const MAX_FILE_BYTES = 512 * 1024;

/**
 * Handles one hook call: turns the payload into a context, runs the advisory board
 * and prints what the agent should read.
 *
 * It never touches the network. Syncing is a separate process started at
 * session start, so a slow registry cannot slow down an edit.
 *
 * What it did goes into `log`, when one is given, for the hook log.
 */
export async function runHook(stdin: string, log?: HookLogEntry): Promise<string> {
  const payload = JSON.parse(stdin) as HookPayload;
  const event = payload.hook_event_name ?? "";
  if (log) {
    Object.assign(log, { hook: event, tool: payload.tool_name, session: payload.session_id, transcript: payload.transcript_path, cwd: payload.cwd });
  }
  const note = (text: string): string => {
    if (log) {
      log.note = text;
    }
    return "";
  };

  if (event === "SessionStart") {
    startBackgroundSync();
    // A session that crashed never reaches SessionEnd, so one starting tidies up after it.
    const swept = sweepShown();
    return note(swept > 0 ? `started the background sync and swept ${swept} old sessions` : "started the background sync");
  }
  if (event === "PostCompact" || event === "SessionEnd") {
    // A compaction drops the advice from the context, so it may arrive in full again.
    forgetShown(payload.session_id ?? "unknown");
    return note("forgot what this session was shown");
  }
  if (event === "PreToolUse" && payload.tool_name?.endsWith("rate_principle")) {
    if (payload.tool_use_id && payload.transcript_path) {
      await noteToolUse(payload.tool_use_id, payload.transcript_path);
    }
    return note("noted the model for a rating");
  }

  const events = eventsOf(payload, readText);
  if (events.length === 0) {
    return note("nothing in this call is an event detectors see");
  }
  const lockfile = readLockfile();
  if (lockfile.entries.length === 0) {
    return note("the advisory board on this machine is empty; run `wellactually sync`");
  }

  // Worker threads are only started when an event concerns enough detectors to need them.
  // WELLACTUALLY_WORKERS=0 keeps everything on one thread, a number sets how many there may be.
  const setting = process.env.WELLACTUALLY_WORKERS;
  const pool = setting === "0" ? null : new DetectorPool(workerFile(), Number(setting) > 0 ? Number(setting) : undefined);
  try {
    return await runEvents(payload, events, lockfile, pool, log);
  } finally {
    await pool?.close();
  }
}

async function runEvents(payload: HookPayload, events: Ctx[], lockfile: Lockfile, pool: DetectorPool | null, log?: HookLogEntry): Promise<string> {
  const event = payload.hook_event_name ?? "";
  const sessionId = payload.session_id ?? "unknown";
  const agentId = payload.agent_id;
  const shown = readShown(sessionId, agentId);
  const parts: string[] = [];
  const failures = new Map<string, string>();
  const cwd = payload.cwd ?? process.cwd();
  const parallelFrom = Number(process.env.WELLACTUALLY_PARALLEL_FROM) || PARALLEL_FROM;

  // Most payloads are one event. A Codex patch is one per file it changes, a shell command one per file it wrote.
  for (const ctx of events) {
    // What is switched off belongs to the project the file is in, which need not be the one the session started in.
    const off = new Set(switchedOff(ctx.file ? path.dirname(ctx.file.path) : cwd).keys());
    const run = await runBoard(ctx, lockfile, off, pool, parallelFrom);
    log?.events.push({
      event: ctx.event,
      file: ctx.file?.path,
      written: ctx.event === "write" ? ctx.file?.written.map((written) => written.line) : undefined,
      command: excerpt(ctx.command),
      text: ctx.file ? undefined : excerpt(ctx.event === "command" ? null : ctx.text),
      detectors: run.detectors.map((detector) => ({
        id: detector.id,
        version: detector.version,
        ms: Math.round(detector.ms),
        findings: someFindings(detector.findings),
        dropped: detector.dropped.length > 0 ? detector.dropped : undefined,
        error: detector.error ?? undefined,
      })),
      skipped: run.skipped.filter((skipped) => skipped.reason !== "globs"),
      unmatched: run.skipped.filter((skipped) => skipped.reason === "globs").length,
    });

    // Counted per event a principle fired in, whether or not its advice is shown again.
    // Principles added from a local directory belong to no registry and are not counted.
    if (readConfig().stats) {
      recordDetections(run.firings.filter((firing) => !firing.principle.id.startsWith("local/")).map((firing) => firing.principle.hash));
    }

    const text = frame(ctx, run.firings, shown);
    if (text) {
      parts.push(text);
    }
    for (const firing of run.firings) {
      if (firing.findings.some((finding) => finding.depth !== "pointer")) {
        shown.add(firing.principle.hash);
      }
    }
    for (const failure of run.failures) {
      failures.set(failure.id, failure.error);
    }
  }

  // A principle that cannot run says so once per session instead of failing silently on every edit.
  const newFailures = [...failures].filter(([id]) => !shown.has(`failure:${id}`));
  if (newFailures.length > 0) {
    parts.push(
      [
        "<wellactually-notice>",
        "These principles on the user's advisory board could not run. Tell the user once; it does not affect your task.",
        ...newFailures.map(([id, error]) => `- ${id}: ${error}`),
        "</wellactually-notice>",
      ].join("\n"),
    );
  }
  if (parts.length === 0) {
    return "";
  }
  for (const [id] of newFailures) {
    shown.add(`failure:${id}`);
  }
  writeShown(sessionId, shown, agentId);

  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: parts.join("\n\n") },
  });
}

/**
 * The script a worker thread runs: the small one built for it, next to the
 * command. Without it the command itself, which serves detectors when it is
 * started as a thread, only slower to load.
 */
function workerFile(): string {
  const main = process.argv[1] as string;
  const beside = [path.join(path.dirname(main), "wellactually-worker.mjs"), path.join(path.dirname(main), "worker.ts")];
  return beside.find((file) => fs.existsSync(file)) ?? main;
}

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
  return content.includes("\0") ? null : content;
}

/** Starts `wellactually sync` detached, so the session does not wait for the registry. */
function startBackgroundSync(): void {
  if (!readConfig().token) {
    return;
  }
  // The file this process was started from: main.ts in a checkout, the single bundled file in the plugin.
  const main = process.argv[1] as string;
  const log = fs.openSync(path.join(ensureHome(), "sync.log"), "a");
  const child = spawn(process.execPath, [main, "sync"], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
}

function ensureHome(): string {
  const home = boardHome();
  fs.mkdirSync(home, { recursive: true });
  return home;
}

/** Appends a hook failure to the log. The hook itself must not break the session it runs in. */
export function logHookFailure(error: unknown): void {
  const line = `${new Date().toISOString()} ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`;
  fs.appendFileSync(path.join(ensureHome(), "hook.log"), line);
}
