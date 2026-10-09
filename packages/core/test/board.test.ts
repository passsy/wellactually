import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildBundle, DetectorPool, runBoard, textCtx, writeCached } from "../src/node.ts";

describe("running the advisory board", () => {
  test("a fork that shares a hash with what it copied speaks under its own name", async () => {
    process.env.WELLACTUALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-board-"));
    const bundle = await buildBundle({ "detector.ts": "export function detect() { return [{ evidence: 'hello' }]; }" });
    const hash = "c".repeat(64);
    // Cached while the original still ran.
    writeCached({ id: "ana/grid", version: 3, hash, manifest: { title: "Grid", summary: "", languages: [], events: ["prompt"], globs: [] }, advice: "Use grid.", bundle });

    const run = await runBoard(textCtx("prompt", "hello"), { syncedAt: null, entries: [{ id: "me/grid", version: 1, hash, enabled: true }] });
    expect(run.failures).toEqual([]);
    expect(run.firings.map((firing) => [firing.principle.id, firing.principle.version])).toEqual([["me/grid", 1]]);
  });
});

describe("running the advisory board on worker threads", () => {
  const worker = path.resolve(import.meta.dirname, "../../cli/src/worker.ts");

  test("gives what one thread gives, in the order of the advisory board, and stops what never ends", async () => {
    process.env.WELLACTUALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-pool-"));
    const manifest = { title: "T", summary: "", languages: [], events: ["prompt" as const], globs: [] };
    const fires = await buildBundle({ "detector.ts": "export function detect(ctx) { return [{ evidence: ctx.text }]; }" });
    const quiet = await buildBundle({ "detector.ts": "export function detect() { return []; }" });
    const endless = await buildBundle({ "detector.ts": "export function detect() { for (;;) {} }" });
    const reads = await buildBundle({ "detector.ts": `import fs from "node:fs"; export function detect(ctx) { return fs.existsSync(${JSON.stringify(worker)}) ? [{ evidence: ctx.text }] : []; }` });
    const bundles = [fires, quiet, endless, reads, fires, quiet, fires, reads, quiet, fires];
    const entries = bundles.map((bundle, index) => {
      const hash = index.toString(16).padStart(64, "0");
      writeCached({ id: `x/p${index}`, version: 1, hash, manifest, advice: "A", bundle });
      return { id: `x/p${index}`, version: 1, hash, enabled: true };
    });
    const lockfile = { syncedAt: null, entries };
    const ctx = textCtx("prompt", "hello", null);

    const single = await runBoard(ctx, lockfile);
    const pool = new DetectorPool(worker, 4);
    try {
      const parallel = await runBoard(ctx, lockfile, new Set(), pool, 1);
      expect(parallel.firings.map((firing) => firing.principle.id)).toEqual(["x/p0", "x/p3", "x/p4", "x/p6", "x/p7", "x/p9"]);
      expect(parallel.firings).toEqual(single.firings);
      expect(parallel.failures).toEqual([{ id: "x/p2", error: "the detector ran longer than 100 ms and was stopped" }]);
      expect(parallel.failures).toEqual(single.failures);
      // Below the threshold no thread is asked.
      expect((await runBoard(ctx, lockfile, new Set(), pool, 11)).firings).toEqual(single.firings);
    } finally {
      await pool.close();
    }
  });

  test("a script that never serves detectors fails them instead of hanging the hook", async () => {
    const idle = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-idle-")), "idle.mjs");
    fs.writeFileSync(idle, "process.exit(0);\n");
    const pool = new DetectorPool(idle, 2);
    try {
      const results = await pool.run(textCtx("prompt", "x"), ["a", "b"], performance.now() + 1000, "skipped");
      expect(results.map((result) => result.error)).toEqual(["no worker thread was left to run it", "no worker thread was left to run it"]);
    } finally {
      await pool.close();
    }
  });
});
