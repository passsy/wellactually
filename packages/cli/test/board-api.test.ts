import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { Finding } from "@wellactually/sdk";
import { fileCtx, type Manifest } from "@wellactually/core/node";
import { runBoard, writeCached } from "../src/board.ts";
import { DetectorPool } from "../src/pool.ts";

/** A detector bundle built by the toolchain of API 3, frozen in the core's tests. */
const frozen = (version: number) =>
  JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, `../../core/test/api/v${version}/principle.json`), "utf8")) as { manifest: Manifest; bundle: string };
const session = ["// relative absolute shape alone fresh root reads", "class Session {", "  late User user;", "}"].join("\n");
const said = (findings: Finding[]) => findings.map((finding) => finding.match ?? `line ${finding.line}`);

describe("an advisory board", () => {
  test("runs each detector against its version, on one thread and on several", async () => {
    process.env.WELLACTUALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-ages-"));
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-ages-repo-")));
    fs.mkdirSync(path.join(repo, "lib"));
    fs.writeFileSync(path.join(repo, "pubspec.yaml"), "name: app\n");
    fs.writeFileSync(path.join(repo, "lib/session.dart"), session);
    const ctx = fileCtx("write", "lib/session.dart", session, undefined, { root: repo, isNew: true });

    const entries = [0, 1, 2].map((index) => {
      const hash = `3${index}`.padStart(64, "0");
      writeCached({ id: `x/v3-${index}`, version: 1, hash, advice: "A", ...frozen(3) });
      return { id: `x/v3-${index}`, version: 1, hash, enabled: true };
    });
    const lockfile = { syncedAt: null, entries };
    // The frozen bundle expects its project at /project, so here it only proves the file access and the shape.
    const expected = entries.map((entry) => [entry.id, ["shape", "fresh", "reads", "line 3"]]);
    const summary = (run: Awaited<ReturnType<typeof runBoard>>) => run.firings.map((firing) => [firing.principle.id, said(firing.findings)]);

    const single = await runBoard(ctx, lockfile);
    expect(single.failures).toEqual([]);
    expect(summary(single)).toEqual(expected);

    const pool = new DetectorPool(path.resolve(import.meta.dirname, "../src/worker.ts"), 2);
    try {
      const parallel = await runBoard(ctx, lockfile, new Set(), pool, 1);
      expect(parallel.failures).toEqual([]);
      expect(summary(parallel)).toEqual(expected);
    } finally {
      await pool.close();
    }
  });
});
