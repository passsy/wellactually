import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { boardHome } from "./board.ts";

/** How often one principle fired on one day, on this machine. */
export interface DetectionCount {
  /** The day in UTC, as YYYY-MM-DD. */
  day: string;
  hash: string;
  count: number;
}

const LOG = "detections.log";
const SENDING = /^detections\.sending\.[a-z0-9]+$/;

/**
 * Notes that these principles fired in one hook call.
 *
 * The hook never talks to the network, so it only appends a line per
 * principle. `wellactually sync` sends the totals later. A line holds a day and a
 * hash: nothing about the file, the prompt or the evidence leaves the machine.
 */
export function recordDetections(hashes: string[], day: string = new Date().toISOString().slice(0, 10)): void {
  if (hashes.length === 0) {
    return;
  }
  fs.mkdirSync(boardHome(), { recursive: true });
  fs.appendFileSync(path.join(boardHome(), LOG), hashes.map((hash) => `${day} ${hash}\n`).join(""));
}

function count(lines: string[]): DetectionCount[] {
  const totals = new Map<string, number>();
  for (const line of lines) {
    if (/^\d{4}-\d{2}-\d{2} [a-f0-9]{64}$/.test(line)) {
      totals.set(line, (totals.get(line) ?? 0) + 1);
    }
  }
  return [...totals.entries()].map(([line, total]) => ({ day: line.slice(0, 10), hash: line.slice(11), count: total }));
}

/**
 * Hands everything recorded so far to `send`, and forgets it when `send` succeeds.
 *
 * The log is moved aside first, so a hook that fires meanwhile starts a new
 * one and nothing is counted twice. When `send` fails, the lines stay on disk
 * and go out with the next call. Resolves to the number of detections sent.
 */
export async function drainDetections(send: (counts: DetectionCount[]) => Promise<void>): Promise<number> {
  const home = boardHome();
  const log = path.join(home, LOG);
  if (fs.existsSync(log)) {
    // A fresh name each time: moving onto a file an earlier, failed call left behind would lose its lines.
    fs.renameSync(log, path.join(home, `detections.sending.${Date.now().toString(36)}${randomBytes(4).toString("hex")}`));
  }
  // Includes what an earlier call moved aside and then failed to send.
  const pending = fs.existsSync(home) ? fs.readdirSync(home).filter((name) => SENDING.test(name)) : [];
  const counts = count(pending.flatMap((name) => fs.readFileSync(path.join(home, name), "utf8").split("\n")));
  if (counts.length > 0) {
    await send(counts);
  }
  for (const name of pending) {
    fs.rmSync(path.join(home, name), { force: true });
  }
  return counts.reduce((sum, entry) => sum + entry.count, 0);
}
