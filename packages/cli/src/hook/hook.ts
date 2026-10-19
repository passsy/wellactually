import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "@wellactually/sdk";
import { ADVICE_BUDGET, adviceBytes } from "@wellactually/core/node";
import { type EventFirings, type Lockfile, PARALLEL_FROM, boardHome, forgetShown, frameEvents, readConfig, readLockfile, readShown, runBoard, sweepShown, writeShown } from "../board/board.ts";
import { recordDetections } from "../board/detections.ts";
import { type HookPayload, eventsOf } from "./payload.ts";
import { DetectorPool } from "../board/pool.ts";
import { switchedOff } from "../board/switches.ts";
import { type TurnDiff, absorbWrites, diffRepos, ensureSnapshot, forgetSnapshots, snapshotRepos, sweepSnapshots } from "./turn.ts";
import { excerpt, type HookLogEntry, someFindings } from "./hook-log.ts";
import { noteToolUse } from "../registry/rater.ts";

const MAX_FILE_BYTES = 512 * 1024;

/**
 * Handles one hook call: turns the payload into a context, runs the advisory board
 * and prints what the agent should read.
 *
 * It never touches the network. Syncing is a separate process started at
 * session start, so a slow registry cannot slow down an edit.
 *
 * What it did goes into `log`, when one is given, for the hook log. `frame`
 * turns the firings into what the agent reads; the evaluator passes a candidate
 * wording here to measure it against the one that ships.
 */
export async function runHook(stdin: string, log?: HookLogEntry, frame: typeof frameEvents = frameEvents): Promise<string> {
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
    sweepSnapshots();
    return note(swept > 0 ? `started the background sync and swept ${swept} old sessions` : "started the background sync");
  }
  if (event === "PostCompact" || event === "SessionEnd") {
    // A compaction drops the advice from the context, so it may arrive in full again.
    forgetShown(payload.session_id ?? "unknown");
    if (event === "SessionEnd" && payload.session_id) {
      forgetSnapshots(payload.session_id);
    }
    return note("forgot what this session was shown");
  }
  if (event === "PreToolUse" && payload.tool_name?.endsWith("rate_principle")) {
    if (payload.tool_use_id && payload.transcript_path) {
      await noteToolUse(payload.tool_use_id, payload.transcript_path);
    }
    return note("noted the model for a rating");
  }

  const lockfile = readLockfile();
  if (lockfile.entries.length === 0) {
    return note("the advisory board on this machine is empty; download it with the plugin's sync skill");
  }
  const turn = followRepos(payload);
  if (log && turn && turn.failures.length > 0) {
    log.repos = turn.failures;
  }
  const events = eventsOf(payload, readText, turn);
  if (event === "PostToolUse" && payload.session_id && !SHELL_TOOLS.has(payload.tool_name ?? "")) {
    // A file tool reported its file already, so the next look after a shell command must not report it again.
    const written = events.flatMap((ctx) => (ctx.event === "write" && ctx.file ? [ctx.file.path] : []));
    if (written.length > 0) {
      absorbWrites(payload.session_id, written);
    }
  }
  if (events.length === 0) {
    return note("nothing in this call is an event detectors see");
  }

  // Worker threads are only started when an event concerns enough detectors to need them.
  // WELLACTUALLY_WORKERS=0 keeps everything on one thread, a number sets how many there may be.
  const setting = process.env.WELLACTUALLY_WORKERS;
  const pool = setting === "0" ? null : new DetectorPool(workerFile(), Number(setting) > 0 ? Number(setting) : undefined);
  try {
    return await runEvents(payload, events, lockfile, pool, frame, log);
  } finally {
    await pool?.close();
  }
}

async function runEvents(payload: HookPayload, events: Ctx[], lockfile: Lockfile, pool: DetectorPool | null, frame: typeof frameEvents, log?: HookLogEntry): Promise<string> {
  const event = payload.hook_event_name ?? "";
  const sessionId = payload.session_id ?? "unknown";
  const agentId = payload.agent_id;
  const shown = readShown(sessionId, agentId);
  const parts: string[] = [];
  const fired: EventFirings[] = [];
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
        thrown: detector.thrown,
      })),
      skipped: run.skipped.filter((skipped) => skipped.reason !== "globs"),
      unmatched: run.skipped.filter((skipped) => skipped.reason === "globs").length,
    });

    fired.push({ ctx, firings: run.firings });
    for (const failure of run.failures) {
      failures.set(failure.id, failure.error);
    }
  }

  // A principle that cannot run says so once per session instead of failing silently on every edit.
  const newFailures = [...failures].filter(([id]) => !shown.has(`failure:${id}`));
  const notice =
    newFailures.length > 0
      ? [
          "<wellactually-notice>",
          "These principles on the user's advisory board could not run. Tell the user once; it does not affect your task.",
          ...newFailures.map(([id, error]) => `- ${id}: ${error}`),
          "</wellactually-notice>",
        ].join("\n")
      : "";

  // One block for the whole call, small enough that the host shows all of it.
  const framed = frame(fired, shown, ADVICE_BUDGET - adviceBytes(notice));
  if (framed.text) {
    parts.push(framed.text);
  }
  for (const hash of framed.full) {
    shown.add(hash);
  }
  if (log && framed.shown.length < fired.filter((entry) => entry.firings.length > 0).length) {
    log.note = `left out ${fired.filter((entry) => entry.firings.length > 0).length - framed.shown.length} events to stay within ${ADVICE_BUDGET} bytes`;
  }
  // Counted per event a principle was shown in, whether in full or as its summary.
  // What was left out never reached the agent. Principles added from a local directory belong to no registry.
  if (readConfig().stats) {
    for (const { firings } of framed.shown) {
      recordDetections(firings.filter((firing) => !firing.principle.id.startsWith("local/")).map((firing) => firing.principle.hash));
    }
  }
  if (notice) {
    parts.push(notice);
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

const SHELL_TOOLS = new Set(["Bash", "exec_command"]);

/**
 * Keeps track of the git repositories the session works in, so that what a
 * shell command changed there reaches detectors as written files.
 *
 * A prompt starts a turn and snapshots them, so what a person changed
 * between turns is not taken for the agent's. Before a shell command runs,
 * a repository without a snapshot gets one. After it ran, the difference is
 * what the command wrote.
 */
function followRepos(payload: HookPayload): TurnDiff | undefined {
  const sessionId = payload.session_id;
  const event = payload.hook_event_name ?? "";
  const shell = SHELL_TOOLS.has(payload.tool_name ?? "");
  if (!sessionId || process.env.WELLACTUALLY_GIT === "0") {
    return undefined;
  }
  const cwd = payload.cwd ?? process.cwd();
  if (event === "UserPromptSubmit") {
    snapshotRepos(sessionId, [cwd]);
  } else if (event === "PreToolUse" && shell) {
    ensureSnapshot(sessionId, cwd);
  } else if (event === "PostToolUse" && shell) {
    return diffRepos(sessionId, cwd);
  }
  return undefined;
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
