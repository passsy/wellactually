import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * One hook call as the log records it: what the agent reported, which
 * detectors ran on which event, and what each of them found.
 *
 * It is there for when someone asks why a hook did not fire or a detector
 * did not detect. Texts are cut short, the full ones are in the agent's
 * own transcript, which `transcript` points at.
 */
export interface HookLogEntry {
  time: string;
  hook: string;
  tool?: string;
  session?: string;
  transcript?: string;
  cwd?: string;
  /** Why no detector ran, when none did. */
  note?: string;
  events: HookLogEvent[];
  /** How many characters of advice the agent was shown. */
  shown: number;
  ms: number;
}

export interface HookLogEvent {
  event: string;
  file?: string;
  /** The lines the agent wrote, on a write. */
  written?: number[];
  command?: string;
  /** The start of the prompt, or of what a command printed. */
  text?: string;
  detectors: {
    id: string;
    version: number;
    ms: number;
    findings: unknown[];
    dropped?: string[];
    error?: string;
  }[];
  /** Principles that did not run because they are switched off or missing from the cache. */
  skipped: { id: string; reason: string }[];
  /** How many principles are not about this event or its file, by their events and globs. */
  unmatched: number;
}

/** Logs are kept this long. */
export const LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** One file per hour holds at most this much, so a busy hour cannot fill the disk. */
export const LOG_MAX_FILE_BYTES = 2 * 1024 * 1024;
const EXCERPT = 300;
const MAX_FINDINGS = 20;

export function excerpt(text: string | null | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  return text.length > EXCERPT ? `${text.slice(0, EXCERPT)}… (${text.length} characters)` : text;
}

/** The findings of one detector, at most a few of them, so one noisy detector cannot fill the log. */
export function someFindings(findings: unknown[]): unknown[] {
  return findings.length > MAX_FINDINGS ? [...findings.slice(0, MAX_FINDINGS), `and ${findings.length - MAX_FINDINGS} more`] : findings;
}

/**
 * Hands the entry to a detached process that writes it, so the hook can
 * return to the agent without waiting for the disk.
 */
export function scheduleHookLog(dir: string, entry: HookLogEntry): void {
  try {
    const main = process.argv[1] as string;
    const writer = [path.join(path.dirname(main), "wellactually-log.mjs"), path.join(path.dirname(main), "log-writer.ts")].find((file) => fs.existsSync(file));
    const args = writer ? [writer, dir] : [main, "hook-log", dir];
    const child = spawn(process.execPath, args, { detached: true, stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(`${JSON.stringify(entry)}\n`);
    child.unref();
  } catch {
    // The log is for troubleshooting. Without it the hook still works.
  }
}

/**
 * Appends one line to the file of the current hour and deletes the files
 * older than a day. A file that is full takes nothing more until the next hour.
 */
export function writeHookLog(dir: string, line: string, now: Date = new Date()): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (!/^hooks-.*\.jsonl$/.test(name)) {
      continue;
    }
    const file = path.join(dir, name);
    try {
      if (now.getTime() - fs.statSync(file).mtimeMs > LOG_MAX_AGE_MS) {
        fs.rmSync(file, { force: true });
      }
    } catch {
      // Another hook removed it first.
    }
  }
  const file = path.join(dir, `hooks-${now.toISOString().slice(0, 13)}.jsonl`);
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    // The first entry of this hour.
  }
  const text = line.endsWith("\n") ? line : `${line}\n`;
  if (size + Buffer.byteLength(text) > LOG_MAX_FILE_BYTES) {
    return;
  }
  fs.appendFileSync(file, text);
}

/** Reads the entry from standard input and writes it. What the detached process runs. */
export async function writeHookLogFromStdin(dir: string): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const line = Buffer.concat(chunks).toString("utf8").trim();
  if (line) {
    writeHookLog(dir, line);
  }
}
