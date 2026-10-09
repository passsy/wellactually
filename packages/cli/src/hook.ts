import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  type HookPayload,
  boardHome,
  eventsOf,
  frame,
  readConfig,
  readLockfile,
  readShown,
  recordDetections,
  runBoard,
  switchedOff,
  writeShown,
} from "@wellactually/core/node";

const MAX_FILE_BYTES = 512 * 1024;

/**
 * Handles one hook call: turns the payload into a context, runs the advisory board
 * and prints what the agent should read.
 *
 * It never touches the network. Syncing is a separate process started at
 * session start, so a slow registry cannot slow down an edit.
 */
export async function runHook(stdin: string): Promise<string> {
  const payload = JSON.parse(stdin) as HookPayload;
  const event = payload.hook_event_name ?? "";

  if (event === "SessionStart") {
    startBackgroundSync();
    return "";
  }

  const events = eventsOf(payload, readText);
  if (events.length === 0) {
    return "";
  }
  const lockfile = readLockfile();
  if (lockfile.entries.length === 0) {
    return "";
  }

  const sessionId = payload.session_id ?? "unknown";
  const shown = readShown(sessionId);
  const parts: string[] = [];
  const failures = new Map<string, string>();
  const cwd = payload.cwd ?? process.cwd();

  // Most payloads are one event. A Codex patch is one per file it changes.
  for (const ctx of events) {
    // What is switched off belongs to the project the file is in, which need not be the one the session started in.
    const off = new Set(switchedOff(ctx.file ? path.dirname(ctx.file.path) : cwd).keys());
    const run = await runBoard(ctx, lockfile, off);

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
  writeShown(sessionId, shown);

  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: parts.join("\n\n") },
  });
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
