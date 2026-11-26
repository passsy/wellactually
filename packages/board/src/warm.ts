/**
 * A pool of detector workers that outlives the hook.
 *
 * A hook is a fresh process, so its workers start cold: each one compiles the
 * isolate engine and warms it up again, and a detector takes several times
 * as long as it does once warm. The first hook without a warm pool starts
 * one in the background and runs on its own threads as before. Every later
 * hook hands its event to that pool over a socket in the board's folder and
 * gets the same results, in about a millisecond per detector.
 *
 * A worker gives each detector a fresh isolate, as in a hook, so nothing a
 * detector does carries over to the next one. What a long-lived process
 * would keep is memory that earlier events passed through, so the pool ends
 * after `WARM_IDLE_MS` without a request, or once it is `WARM_MAX_AGE_MS`
 * old, and the next hook starts a fresh one.
 *
 * The socket's folder is readable by its user only. Its name comes from the
 * worker script, so a new version of the plugin starts its own pool and the
 * old one ends when it is idle.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Ctx } from "@wellactually/detector-sdk";
import type { DetectorRun } from "@wellactually/core/node";
import { boardHome, readCached } from "./board.ts";
import { DetectorPool, MAX_WORKERS, type Runner, type Task, WARM_MS_PER_WORKER, warmWorkers } from "./pool.ts";

export const WARM_IDLE_MS = 10 * 60_000;
export const WARM_MAX_AGE_MS = 60 * 60_000;
/** How long a hook waits for the warm pool to take a connection. */
const CONNECT_MS = 200;
/** How long a hook waits for its answer beyond the board's budget: another hook's event may be ahead of it. */
const ANSWER_GRACE_MS = 3000;
/** While a pool is starting, other hooks do not start another one. */
const STARTING_MS = 10_000;
/** The worker script of the plugin, built and from source. */
const WORKER_SCRIPTS = new Set(["wellactually-worker.mjs", "worker.ts"]);

/** Where the warm pool for this worker script listens, and the files beside it. */
export function warmPaths(file: string): { socket: string; pid: string; starting: string } {
  const stat = fs.statSync(file);
  const id = crypto.createHash("sha256").update([path.resolve(file), stat.mtimeMs, stat.size, process.version, boardHome()].join("\0")).digest("hex").slice(0, 12);
  const dir = path.join(boardHome(), "run");
  return {
    // A Unix socket path may be about 100 characters, so the name is short.
    socket: process.platform === "win32" ? `\\\\.\\pipe\\wellactually-${id}` : path.join(dir, `${id}.sock`),
    pid: path.join(dir, `${id}.pid`),
    starting: path.join(dir, `${id}.starting`),
  };
}

interface Request {
  ctx: Ctx;
  tasks: Task[];
  budgetMs: number;
  skipped: string;
}

function failed(error: string): DetectorRun {
  return { findings: [], error, dropped: [], ms: 0 };
}

function makeDir(file: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    fs.chmodSync(dir, 0o700);
  }
}

/** Whether something answers on the socket. */
function connects(socket: string, timeoutMs: number = CONNECT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = net.connect(socket);
    const settle = (value: boolean): void => {
      clearTimeout(timer);
      connection.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    connection.once("connect", () => settle(true));
    connection.once("error", () => settle(false));
  });
}

/** Sends one line and resolves to the line that comes back, or rejects when none does in time. */
function ask(socket: string, line: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const connection = net.connect(socket);
    let answer = "";
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new Error("the warm pool did not answer in time"));
    }, timeoutMs);
    connection.setEncoding("utf8");
    connection.once("connect", () => connection.write(`${line}\n`));
    connection.on("data", (chunk: string) => {
      answer += chunk;
    });
    connection.once("end", () => {
      clearTimeout(timer);
      answer.endsWith("\n") ? resolve(answer.slice(0, -1)) : reject(new Error("the warm pool closed the connection"));
    });
    connection.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Serves detectors on `socket` with workers that run `file`, until the pool
 * is idle or old enough to be replaced. Resolves when it has ended.
 */
export async function serveWarm(file: string, socket: string, idleMs: number = WARM_IDLE_MS, maxAgeMs: number = WARM_MAX_AGE_MS): Promise<void> {
  const workers = warmWorkers();
  const pool = new DetectorPool(file, workers, Math.max(workers, MAX_WORKERS));
  // What a detector has taken lately, in ms: the pool grows to `WARM_MS_PER_WORKER` of work per worker.
  let perDetector = 1;
  // A cached bundle never changes under its hash, so each is read once.
  const bundles = new Map<string, string | null>();
  const bundleOf = (task: Task): string | null => {
    if (task.bundle) {
      return task.bundle;
    }
    const hash = task.hash ?? "";
    if (!bundles.has(hash)) {
      bundles.set(hash, readCached(hash)?.bundle ?? null);
    }
    return bundles.get(hash) ?? null;
  };
  const born = Date.now();
  let ending = false;
  let idle: NodeJS.Timeout | undefined;
  let finished: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    finished = resolve;
  });

  const end = (): void => {
    if (ending) {
      return;
    }
    ending = true;
    clearTimeout(idle);
    server.close();
    void pool.close().then(finished);
  };
  const rest = (): void => {
    clearTimeout(idle);
    idle = setTimeout(end, idleMs);
  };

  const answer = async (line: string): Promise<string> => {
    const request = JSON.parse(line) as Request;
    // The budget starts when the event arrives, so time spent behind another hook's event counts.
    const deadline = performance.now() + request.budgetMs;
    const runnable: Task[] = [];
    const where: number[] = [];
    const results: DetectorRun[] = request.tasks.map((task, index) => {
      const bundle = bundleOf(task);
      if (bundle === null) {
        return failed("its bundle is not in the local cache; download it with the plugin's sync skill");
      }
      runnable.push({ bundle, api: task.api });
      where.push(index);
      return failed("");
    });
    const ran = await pool.run(request.ctx, runnable, deadline, request.skipped, Math.ceil((runnable.length * perDetector) / WARM_MS_PER_WORKER));
    if (ran.length > 0) {
      perDetector = (perDetector + ran.reduce((sum, result) => sum + result.ms, 0) / ran.length) / 2;
    }
    ran.forEach((result, index) => {
      results[where[index] as number] = result;
    });
    return JSON.stringify(results);
  };

  const server = net.createServer((connection) => {
    let line = "";
    connection.setEncoding("utf8");
    connection.on("error", () => undefined);
    connection.on("data", (chunk: string) => {
      line += chunk;
      if (!line.endsWith("\n") || ending) {
        return;
      }
      clearTimeout(idle);
      answer(line.slice(0, -1)).then(
        (reply) => connection.end(`${reply}\n`),
        () => connection.destroy(),
      ).finally(() => {
        if (Date.now() - born > maxAgeMs) {
          end();
        } else {
          rest();
        }
      });
    });
  });

  makeDir(socket.startsWith("\\\\") ? path.join(boardHome(), "run", "pipe") : socket);
  const listening = await new Promise<boolean>((resolve) => {
    const listen = (retry: boolean): void => {
      server.once("error", async (error: NodeJS.ErrnoException) => {
        // A socket file left behind by a pool that crashed answers nobody, and is replaced.
        if (retry && error.code === "EADDRINUSE" && process.platform !== "win32" && !(await connects(socket))) {
          fs.rmSync(socket, { force: true });
          listen(false);
        } else {
          resolve(false);
        }
      });
      server.listen(socket, () => resolve(true));
    };
    listen(true);
  });
  if (!listening) {
    // Another pool took the socket first.
    await pool.close();
    return;
  }
  rest();
  await ended;
}

/**
 * The pool a hook runs detectors on: the warm one when it answers, otherwise
 * threads of its own, as before there was a warm one. A warm pool that stops
 * answering in the middle of a hook is not asked again by that hook.
 */
export class HookPool implements Runner {
  private cold: DetectorPool | null = null;
  private readonly file: string;
  private readonly size: number | undefined;
  private readonly socket: string | null;
  /** Whether the warm pool runs this hook's detectors. */
  warm: boolean;

  private constructor(file: string, size: number | undefined, socket: string | null, warm: boolean) {
    this.file = file;
    this.size = size;
    this.socket = socket;
    this.warm = warm;
  }

  /** Opens the pool for one hook, and starts a warm pool in the background when there is none. */
  static async open(file: string, size?: number): Promise<HookPool> {
    // Only the worker script knows `--warm`. Started with that, any other script would do whatever it does.
    if (!WORKER_SCRIPTS.has(path.basename(file))) {
      return new HookPool(file, size, null, false);
    }
    let paths: ReturnType<typeof warmPaths>;
    try {
      paths = warmPaths(file);
    } catch {
      return new HookPool(file, size, null, false);
    }
    if (await connects(paths.socket)) {
      return new HookPool(file, size, paths.socket, true);
    }
    startWarm(file, paths);
    return new HookPool(file, size, paths.socket, false);
  }

  async run(ctx: Ctx, tasks: Task[], deadline: number, skipped: string): Promise<DetectorRun[]> {
    if (this.warm && this.socket !== null) {
      const budgetMs = Math.max(0, deadline - performance.now());
      const request: Request = { ctx, tasks: tasks.map((task) => (task.hash ? { bundle: "", hash: task.hash, api: task.api } : task)), budgetMs, skipped };
      try {
        return JSON.parse(await ask(this.socket, JSON.stringify(request), budgetMs + ANSWER_GRACE_MS)) as DetectorRun[];
      } catch {
        this.warm = false;
      }
    }
    this.cold ??= new DetectorPool(this.file, this.size);
    return this.cold.run(ctx, tasks, deadline, skipped);
  }

  async close(): Promise<void> {
    await this.cold?.close();
  }
}

/** Starts a warm pool in its own process, unless one is starting already. */
function startWarm(file: string, paths: ReturnType<typeof warmPaths>): void {
  try {
    makeDir(paths.starting);
    try {
      if (Date.now() - fs.statSync(paths.starting).mtimeMs < STARTING_MS) {
        return;
      }
    } catch {
      // Nobody is starting one.
    }
    fs.writeFileSync(paths.starting, "");
    const child = spawn(process.execPath, [file, "--warm", paths.socket], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } catch {
    // Without a warm pool, every hook runs on its own threads, as before.
  }
}

/** What the worker script does when it is started as the warm pool: serve, then leave. */
export async function runWarm(file: string, socket: string): Promise<void> {
  const paths = warmPaths(file);
  makeDir(paths.pid);
  fs.writeFileSync(paths.pid, String(process.pid));
  const idle = Number(process.env.WELLACTUALLY_WARM_IDLE_MS) || WARM_IDLE_MS;
  try {
    await serveWarm(file, socket, idle);
  } finally {
    // Only this pool's own files: another pool may have the socket by now.
    let owner = "";
    try {
      owner = fs.readFileSync(paths.pid, "utf8");
    } catch {
      // Gone already.
    }
    if (owner === String(process.pid)) {
      fs.rmSync(paths.pid, { force: true });
      fs.rmSync(paths.starting, { force: true });
    }
  }
  process.exit(0);
}
