import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  boardHome,
  fileCtx,
  frame,
  readConfig,
  readLockfile,
  readShown,
  recordDetections,
  runBoard,
  textCtx,
  writeShown,
} from "@wellactually/core/node";
import type { Ctx, WrittenLine } from "@wellactually/sdk";

/** The fields of a Claude Code or Codex hook payload this host reads. */
interface HookPayload {
  hook_event_name?: string;
  tool_name?: string;
  session_id?: string;
  cwd?: string;
  prompt?: string;
  tool_input?: {
    file_path?: string;
    content?: string;
    new_string?: string;
    edits?: { new_string?: string }[];
    command?: string;
    cmd?: string;
  };
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
const SHELL_TOOLS = new Set(["Bash", "exec_command"]);
const MAX_FILE_BYTES = 512 * 1024;

/**
 * Handles one hook call: turns the payload into a context, runs the board
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

  const ctx = contextOf(payload);
  if (!ctx) {
    return "";
  }
  const lockfile = readLockfile();
  if (lockfile.entries.length === 0) {
    return "";
  }

  const sessionId = payload.session_id ?? "unknown";
  const shown = readShown(sessionId);
  const run = await runBoard(ctx, lockfile);

  // Counted per hook call a principle fired in, whether or not its advice is shown again.
  // Principles added from a local directory belong to no registry and are not counted.
  if (readConfig().stats) {
    recordDetections(run.firings.filter((firing) => !firing.principle.id.startsWith("local/")).map((firing) => firing.principle.hash));
  }

  const parts: string[] = [];
  const text = frame(ctx, run.firings, shown);
  if (text) {
    parts.push(text);
  }
  // A principle that cannot run says so once per session instead of failing silently on every edit.
  const newFailures = run.failures.filter((failure) => !shown.has(`failure:${failure.id}`));
  if (newFailures.length > 0) {
    parts.push(
      [
        "<wellactually-notice>",
        "These principles on the user's board could not run. Tell the user once; it does not affect your task.",
        ...newFailures.map((failure) => `- ${failure.id}: ${failure.error}`),
        "</wellactually-notice>",
      ].join("\n"),
    );
  }
  if (parts.length === 0) {
    return "";
  }

  for (const firing of run.firings) {
    if (firing.findings.some((finding) => finding.depth !== "pointer")) {
      shown.add(firing.principle.hash);
    }
  }
  for (const failure of newFailures) {
    shown.add(`failure:${failure.id}`);
  }
  writeShown(sessionId, shown);

  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: parts.join("\n\n") },
  });
}

function contextOf(payload: HookPayload): Ctx | null {
  const event = payload.hook_event_name ?? "";
  const tool = payload.tool_name ?? "";
  const input = payload.tool_input ?? {};

  if (event === "UserPromptSubmit") {
    return payload.prompt ? textCtx("prompt", payload.prompt) : null;
  }
  if (event === "PreToolUse" && SHELL_TOOLS.has(tool)) {
    const command = input.command ?? input.cmd;
    return command ? textCtx("command", command) : null;
  }
  if (event !== "PostToolUse" || !input.file_path) {
    return null;
  }

  const cwd = payload.cwd ?? process.cwd();
  const absolute = path.resolve(cwd, input.file_path);
  const content = readText(absolute);
  if (content === null) {
    return null;
  }
  const relative = path.relative(cwd, absolute).split(path.sep).join("/");

  if (tool === "Read") {
    return fileCtx("read", relative, content);
  }
  if (!WRITE_TOOLS.has(tool)) {
    return null;
  }
  if (tool === "Write") {
    return fileCtx("write", relative, content);
  }
  const fragments = tool === "Edit" ? [input.new_string ?? ""] : (input.edits ?? []).map((edit) => edit.new_string ?? "");
  return fileCtx("write", relative, content, locate(content, fragments));
}

/**
 * The lines of `content` the agent just wrote, given the text it inserted.
 *
 * The file on disk is the truth after the edit. A fragment is found there as
 * a whole first; when it is not, for instance because a formatter ran, its
 * lines are matched one by one.
 */
function locate(content: string, fragments: string[]): WrittenLine[] {
  const lines = content.split("\n");
  const written = new Map<number, string>();
  for (const fragment of fragments) {
    if (fragment.trim() === "") {
      continue;
    }
    const at = content.indexOf(fragment);
    if (at !== -1) {
      const first = content.slice(0, at).split("\n").length;
      const count = fragment.split("\n").length;
      for (let line = first; line < first + count && line <= lines.length; line++) {
        written.set(line, lines[line - 1] ?? "");
      }
      continue;
    }
    for (const wanted of fragment.split("\n")) {
      const trimmed = wanted.trim();
      if (trimmed === "") {
        continue;
      }
      const index = lines.findIndex((line, lineIndex) => !written.has(lineIndex + 1) && line.trim() === trimmed);
      if (index !== -1) {
        written.set(index + 1, lines[index] ?? "");
      }
    }
  }
  return [...written.entries()].sort(([a], [b]) => a - b).map(([line, text]) => ({ line, text }));
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
