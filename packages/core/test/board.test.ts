import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildBundle, runBoard, textCtx, writeCached } from "../src/node.ts";

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
