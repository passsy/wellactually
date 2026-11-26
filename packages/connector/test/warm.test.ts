import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { API_VERSION } from "@wellactually/detector-sdk";
import { buildBundle, textCtx } from "@wellactually/core/node";
import { runBoard, writeCached } from "../../board/src/board.ts";
import { HookPool, warmPaths } from "../../board/src/warm.ts";

const worker = path.resolve(import.meta.dirname, "../src/worker.ts");
const sdk = `import { onPrompt } from "@wellactually/detector-sdk/v3";`;
const handlers = [{ event: "prompt" as const, globs: [] }];

/** A board of `count` detectors in a fresh home, half of which fire. */
async function board(count: number) {
  process.env.WELLACTUALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wa-warm-"));
  const manifest = { title: "T", summary: "", tags: [], events: ["prompt" as const], globs: [], handlers, api: API_VERSION };
  const fires = await buildBundle({ "detector.ts": `${sdk} onPrompt({ detect: (event) => [{ match: event.text }] });` });
  const quiet = await buildBundle({ "detector.ts": `${sdk} onPrompt({ detect: () => [] });` });
  const entries = Array.from({ length: count }, (_, index) => {
    const hash = index.toString(16).padStart(64, "0");
    writeCached({ id: `x/p${index}`, version: 1, hash, manifest, advice: "A", bundle: index % 2 === 0 ? fires : quiet });
    return { id: `x/p${index}`, version: 1, hash, enabled: true };
  });
  return { syncedAt: null, entries };
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) {
      throw new Error("timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function connects(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = net.connect(socket);
    connection.once("connect", () => {
      connection.destroy();
      resolve(true);
    });
    connection.once("error", () => resolve(false));
  });
}

function warmPid(): number | null {
  try {
    return Number(fs.readFileSync(warmPaths(worker).pid, "utf8"));
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  const pid = warmPid();
  if (pid !== null && alive(pid)) {
    process.kill(pid);
  }
  delete process.env.WELLACTUALLY_WARM_IDLE_MS;
});

describe("the warm pool", () => {
  test("the first hook starts it and runs on its own threads, the next ones run on it, with the same results", async () => {
    const lockfile = await board(30);
    const ctx = textCtx("prompt", "hello", null);
    const single = await runBoard(ctx, lockfile);

    const first = await HookPool.open(worker);
    try {
      expect(first.warm).toBe(false);
      expect((await runBoard(ctx, lockfile, new Set(), first, 1)).firings).toEqual(single.firings);
    } finally {
      await first.close();
    }

    await until(() => connects(warmPaths(worker).socket));
    for (let hook = 0; hook < 3; hook++) {
      const next = await HookPool.open(worker);
      try {
        expect(next.warm).toBe(true);
        const run = await runBoard(ctx, lockfile, new Set(), next, 1);
        expect(run.firings).toEqual(single.firings);
        expect(run.failures).toEqual([]);
      } finally {
        await next.close();
      }
    }
    expect(single.firings.length).toBe(15);
  }, 60_000);

  test("a warm pool that goes away mid-hook leaves the hook to its own threads", async () => {
    const lockfile = await board(20);
    const ctx = textCtx("prompt", "hello", null);
    const single = await runBoard(ctx, lockfile);
    await (await HookPool.open(worker)).close();
    await until(() => connects(warmPaths(worker).socket));

    const pool = await HookPool.open(worker);
    try {
      expect(pool.warm).toBe(true);
      process.kill(warmPid() as number);
      await until(async () => !(await connects(warmPaths(worker).socket)));
      expect((await runBoard(ctx, lockfile, new Set(), pool, 1)).firings).toEqual(single.firings);
      expect(pool.warm).toBe(false);
    } finally {
      await pool.close();
    }
  }, 60_000);

  test("ends when idle and takes its files with it, and its folder is its user's alone", async () => {
    await board(1);
    process.env.WELLACTUALLY_WARM_IDLE_MS = "300";
    await (await HookPool.open(worker)).close();
    const paths = warmPaths(worker);
    await until(() => warmPid() !== null && connects(paths.socket));
    if (process.platform !== "win32") {
      expect(fs.statSync(path.dirname(paths.socket)).mode & 0o777).toBe(0o700);
    }
    const pid = warmPid() as number;
    await until(() => !alive(pid));
    expect(fs.existsSync(paths.socket)).toBe(false);
    expect(fs.existsSync(paths.pid)).toBe(false);
    expect(fs.existsSync(paths.starting)).toBe(false);
  }, 60_000);

  test("replaces a socket file that a crashed pool left behind", async () => {
    if (process.platform === "win32") {
      return;
    }
    await board(1);
    const paths = warmPaths(worker);
    fs.mkdirSync(path.dirname(paths.socket), { recursive: true });
    fs.writeFileSync(paths.socket, "");
    await (await HookPool.open(worker)).close();
    await until(() => connects(paths.socket));
  }, 60_000);
});

test("is never started from a script other than the worker", async () => {
  await board(1);
  const other = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wa-other-")), "main.mjs");
  fs.writeFileSync(other, `require("node:fs").writeFileSync(${JSON.stringify(`${other}.ran`)}, "");\n`);
  const pool = await HookPool.open(other);
  await pool.close();
  expect(pool.warm).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(fs.existsSync(`${other}.ran`)).toBe(false);
  expect(fs.existsSync(path.join(process.env.WELLACTUALLY_HOME as string, "run"))).toBe(false);
});
