import os from "node:os";
import { parentPort, Worker } from "node:worker_threads";
import type { Ctx } from "@wellactually/sdk";
import { diskFiles } from "./fs.ts";
import { DEFAULT_LIMITS, detectorRunner, type DetectorRun } from "./sandbox.ts";

/**
 * Runs the detectors of an advisory board on several threads.
 *
 * One event can concern dozens of principles. Each detector is quick, but
 * each may also use its whole time limit, and one after another that adds up
 * to seconds the agent waits. So the work is spread over up to eight worker
 * threads. Every worker has its own isolate engine and takes one detector
 * after another from the same queue until it is empty.
 *
 * It also bounds what the isolate cannot: a detector's file question that
 * hangs, on a network drive for instance, is outside the engine and cannot be
 * interrupted from within. A worker that does not answer is stopped from
 * here, and its detector is reported like any other that ran out of time.
 */
export const MAX_WORKERS = 8;

/** How long a worker may take beyond the detector's own limit before it is given up on. */
const GRACE_MS = 400;
const START_MS = 5000;

type FromWorker = { ready: true } | { id: number; result: DetectorRun };
type ToWorker = { ctx: Ctx } | { id: number; bundle: string; api: number };

/** A detector to run: its bundle and the detector API version it was built against. */
export interface Task {
  bundle: string;
  api: number;
}

function failed(error: string): DetectorRun {
  return { findings: [], error, dropped: [], ms: 0 };
}

/**
 * What a worker thread does: load the engine once, then answer each detector it is sent.
 * The file a pool starts its workers from has to call this when it runs as one.
 */
export async function serveDetectors(): Promise<void> {
  const port = parentPort;
  if (!port) {
    throw new Error("serveDetectors() runs in a worker thread");
  }
  const run = await detectorRunner();
  const disk = diskFiles();
  let ctx: Ctx | null = null;
  port.on("message", (message: ToWorker) => {
    if ("ctx" in message) {
      ctx = message.ctx;
      return;
    }
    const result = ctx === null ? failed("the worker was given no event") : run(message.bundle, ctx, disk, message.api);
    port.postMessage({ id: message.id, result } satisfies FromWorker);
  });
  port.postMessage({ ready: true } satisfies FromWorker);
}

interface Member {
  worker: Worker;
  ready: Promise<boolean>;
}

export class DetectorPool {
  private members: Member[] = [];
  private readonly file: string;
  private readonly size: number;

  /** `file` is the script the workers run. It must call `serveDetectors()` when it is not the main thread. */
  constructor(file: string, size: number = MAX_WORKERS) {
    this.file = file;
    this.size = Math.max(1, Math.min(size, MAX_WORKERS, os.availableParallelism()));
  }

  private start(): Member {
    const worker = new Worker(this.file, { stdout: false, stderr: false });
    const ready = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), START_MS);
      const settle = (value: boolean): void => {
        clearTimeout(timer);
        resolve(value);
      };
      worker.once("message", () => settle(true));
      worker.once("error", () => settle(false));
      worker.once("exit", () => settle(false));
    });
    const member = { worker, ready };
    this.members.push(member);
    return member;
  }

  private drop(member: Member): void {
    this.members = this.members.filter((other) => other !== member);
    void member.worker.terminate();
  }

  /**
   * Runs every detector against `ctx` and resolves to one result per detector, in order.
   * A detector that is not started before `deadline` (from `performance.now()`) gets `skipped` as its error.
   */
  async run(ctx: Ctx, tasks: Task[], deadline: number, skipped: string): Promise<DetectorRun[]> {
    const results: (DetectorRun | undefined)[] = new Array<DetectorRun | undefined>(tasks.length).fill(undefined);
    while (this.members.length < Math.min(this.size, tasks.length)) {
      this.start();
    }
    let next = 0;

    const work = async (member: Member): Promise<void> => {
      if (!(await member.ready)) {
        this.drop(member);
        return;
      }
      member.worker.postMessage({ ctx } satisfies ToWorker);
      while (next < tasks.length) {
        const id = next++;
        if (performance.now() > deadline) {
          results[id] = failed(skipped);
          continue;
        }
        const answer = await new Promise<DetectorRun | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), DEFAULT_LIMITS.ms + GRACE_MS);
          const settle = (value: DetectorRun | null): void => {
            clearTimeout(timer);
            member.worker.off("message", onMessage);
            member.worker.off("error", onGone);
            member.worker.off("exit", onGone);
            resolve(value);
          };
          const onMessage = (message: FromWorker): void => {
            if ("id" in message && message.id === id) {
              settle(message.result);
            }
          };
          const onGone = (): void => settle(null);
          member.worker.on("message", onMessage);
          member.worker.once("error", onGone);
          member.worker.once("exit", onGone);
          member.worker.postMessage({ id, ...(tasks[id] as Task) } satisfies ToWorker);
        });
        if (answer === null) {
          // It hangs or it died. Either way this thread is not trusted with another detector.
          results[id] = failed(`the detector did not finish within ${DEFAULT_LIMITS.ms + GRACE_MS} ms and was stopped`);
          this.drop(member);
          return;
        }
        results[id] = answer;
      }
    };

    await Promise.all(this.members.map(work));
    // Whatever is left had no worker to run on.
    return results.map((result) => result ?? failed("no worker thread was left to run it"));
  }

  /** Stops the workers. The process cannot end while they live. */
  async close(): Promise<void> {
    const members = this.members;
    this.members = [];
    await Promise.all(members.map((member) => member.worker.terminate()));
  }
}
