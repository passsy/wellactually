import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { API_VERSION } from "@wellactually/sdk";
import {
  apiOf,
  applies,
  buildPrinciple,
  checkPrinciple,
  ctxFor,
  DetectorPool,
  environmentFor,
  fileCtx,
  mapProject,
  MIN_API_VERSION,
  runBoard,
  runDetector,
  scaffoldFiles,
  shapeOf,
  textCtx,
  unsupported,
  writeCached,
  type Manifest,
} from "../src/node.ts";

/**
 * Each folder in `api` is one version of the detector API, frozen:
 * `principle.json` is a bundle the toolchain of that version built, with the
 * SDK of that time inside, and `shape.json` is the event it was promised.
 * Nothing here is ever rebuilt. These tests are what a released principle
 * relies on when the API moves on.
 */
const dir = path.resolve(import.meta.dirname, "api");
const versions = Array.from({ length: API_VERSION - MIN_API_VERSION + 1 }, (_, index) => MIN_API_VERSION + index);
const frozen = (version: number) => JSON.parse(fs.readFileSync(path.join(dir, `v${version}/principle.json`), "utf8")) as { manifest: Manifest; bundle: string };
const shape = (version: number) => JSON.parse(fs.readFileSync(path.join(dir, `v${version}/shape.json`), "utf8")) as Record<string, unknown>;

const session = ["// relative absolute shape alone fresh root reads", "class Session {", "  late User user;", "}"].join("\n");
const written = fileCtx("write", "lib/session.dart", session, undefined, { isNew: true });
const project = mapProject("/project", { "pubspec.yaml": "name: app\n", "lib/session.dart": session });
const said = (findings: { evidence: string }[]) => findings.map((finding) => finding.evidence);

describe("every version of the detector API", () => {
  test("from the oldest this host runs to the newest is frozen", () => {
    for (const version of versions) {
      expect(fs.existsSync(path.join(dir, `v${version}/principle.json`)), `API ${version} has no frozen bundle. After raising API_VERSION run: node scripts/freeze-api.mjs`).toBe(true);
    }
    expect(apiOf(frozen(API_VERSION).manifest)).toBe(API_VERSION);
  });

  test.each(versions)("version %s still gets the event it was promised", (version) => {
    const environment = environmentFor(version, written, project);
    const today = {
      file: shapeOf(ctxFor(version, written)),
      text: shapeOf(ctxFor(version, textCtx("prompt", "a"))),
      globals: Object.keys(environment.strings).sort(),
      functions: Object.keys(environment.functions).sort(),
    };
    expect(
      today,
      version === API_VERSION
        ? `The event or the host functions changed. That is a new version of the detector API: raise API_VERSION in packages/sdk/src/index.ts, add the step back to version ${API_VERSION} in packages/core/src/api.ts, then run node scripts/freeze-api.mjs. Do not edit shape.json.`
        : `Version ${version} is released and principles depend on it. Fix the step in packages/core/src/api.ts, not shape.json.`,
    ).toEqual(shape(version));
  });
});

describe("a detector built against API 1, before paths were absolute", () => {
  const { manifest, bundle } = frozen(1);

  test("carries no version, which means 1", () => {
    expect(manifest.api).toBeUndefined();
    expect(apiOf(manifest)).toBe(1);
  });

  test("gets a relative path, the six fields it knew, and no host to ask", async () => {
    expect(applies(manifest, written)).toBe(true);
    const run = await runDetector(bundle, written, undefined, project, apiOf(manifest));
    expect(run.error).toBeNull();
    expect(run.dropped).toEqual([]);
    expect(said(run.findings)).toEqual(["relative", "shape", "alone", "late User user;"]);
    expect(run.findings.at(-1)).toEqual({ line: 3, evidence: "late User user;" });
  });

  test("still answers a prompt through the SDK it was built with", async () => {
    const run = await runDetector(bundle, textCtx("prompt", "why is the late keyword bad"), undefined, null, 1);
    expect(run.findings).toEqual([{ evidence: "late keyword", depth: "pointer" }]);
  });

  test("would see none of that if it were handed today's event", async () => {
    const run = await runDetector(bundle, written, undefined, project, API_VERSION);
    expect(said(run.findings)).toEqual(["late User user;"]);
  });
});

describe("a detector built against API 2", () => {
  const { manifest, bundle } = frozen(2);

  test("gets absolute paths, the project and files to read", async () => {
    const run = await runDetector(bundle, written, undefined, project, apiOf(manifest));
    expect(run.error).toBeNull();
    expect(run.dropped).toEqual([]);
    expect(said(run.findings)).toEqual(["absolute", "shape", "fresh", "root", "reads", "late User user;"]);
  });
});

describe("a detector from a version this host does not run", () => {
  const { bundle } = frozen(API_VERSION);

  test("is not run, and says what to do", async () => {
    const newer = await runDetector(bundle, written, undefined, project, API_VERSION + 1);
    expect(newer.findings).toEqual([]);
    expect(newer.error).toBe(`it was built for detector API ${API_VERSION + 1} and this version of Well Actually runs up to ${API_VERSION}. Update the plugin.`);
    expect(unsupported(0)).toMatch(/does not know/);
    expect(unsupported(1.5)).toMatch(/does not know/);
    expect(versions.map(unsupported)).toEqual(versions.map(() => null));
  });
});

describe("a build", () => {
  const advice = "# T\n\nOne sentence.\n\nA paragraph of advice that is long enough to count as advice for an agent to read.";
  const build = (detector: string) => buildPrinciple({ "principle.md": advice, "detector.ts": detector });

  test("records the newest API version when the detector declares none", async () => {
    expect((await build("export function detect() { return []; }")).manifest.api).toBe(API_VERSION);
  });

  test("records the version the detector declares", async () => {
    expect((await build("export const api = 1; export function detect() { return []; }")).manifest.api).toBe(1);
  });

  test("a new principle declares the version it starts from", async () => {
    const built = await buildPrinciple(scaffoldFiles("my-principle"));
    expect(scaffoldFiles("my-principle")["detector.ts"]).toContain(`export const api = ${API_VERSION};`);
    expect(built.manifest.api).toBe(API_VERSION);
  });

  test("refuses a version this host does not build for", async () => {
    await expect(build(`export const api = ${API_VERSION + 1}; export function detect() { return []; }`)).rejects.toThrow(/Use a whole number from 1 to/);
    await expect(build(`export const api = "1"; export function detect() { return []; }`)).rejects.toThrow(/is not a number/);
  });

  test("refuses what the declared version did not have", async () => {
    await expect(build(`import fs from "node:fs"; export const api = 1; export function detect() { return fs.existsSync("/") ? [] : []; }`)).rejects.toThrow(
      "detector.ts imports node:fs, which exists from detector API 2 on, and declares api = 1.",
    );
    // node:path is string logic and needs nothing from the host.
    const built = await build(`import path from "node:path"; export const api = 1; export function detect() { return path.join("a", "b") ? [] : []; }`);
    expect(built.manifest.api).toBe(1);
  });
});

describe("a detector that stays on an old version", () => {
  test("is built with today's SDK and behaves like the bundle that was built back then", async () => {
    // The source of the frozen API 1 bundle, uploaded again today with its version declared.
    const source = `${fs.readFileSync(path.join(dir, "v1/detector.ts"), "utf8")}\nexport const api = 1;\n`;
    const today = await buildPrinciple({ "principle.md": "# T\n\nOne sentence.\n\nA paragraph of advice that is long enough to count as advice for an agent to read.", "detector.ts": source });
    const then = frozen(1);
    expect(today.manifest.api).toBe(1);
    expect(today.bundle).not.toBe(then.bundle);

    for (const ctx of [written, textCtx("prompt", "why is the late keyword bad"), fileCtx("read", "lib/session.dart", session)]) {
      if (!applies(today.manifest, ctx)) {
        continue;
      }
      const now = await runDetector(today.bundle, ctx, undefined, project, apiOf(today.manifest));
      const before = await runDetector(then.bundle, ctx, undefined, project, apiOf(then.manifest));
      expect(now.error).toBeNull();
      expect(now.findings).toEqual(before.findings);
    }
    expect(said((await runDetector(today.bundle, written, undefined, project, 1)).findings)).toEqual(["relative", "shape", "alone", "late User user;"]);
  });

  test("gets the old event in its own tests too", async () => {
    const { report } = await checkPrinciple({
      "principle.md": "# T\n\nOne sentence.\n\nA paragraph of advice that is long enough to count as advice for an agent to read.",
      "detector.ts": `import type { CtxV1 } from "@wellactually/sdk";
        export const api = 1;
        export function detect(ctx: CtxV1) { return ctx.file?.path === "lib/a.dart" && !("project" in ctx) ? [{ evidence: ctx.text }] : []; }`,
      "detector.test.ts": `import { expect, test } from "vitest";
        import { detect, write } from "@wellactually/sdk/test";
        test("fires", () => { expect(detect(write("lib/a.dart", "x"))).toHaveLength(1); });
        test("quiet", () => { expect(detect(write("lib/b.dart", "x"))).toEqual([]); });`,
    });
    expect(report.problems).toEqual([]);
  });
});

describe("an advisory board with principles of different ages", () => {
  test("runs each against its own version, on one thread and on several", async () => {
    process.env.WELLACTUALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-ages-"));
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-ages-repo-")));
    fs.mkdirSync(path.join(repo, "lib"));
    fs.writeFileSync(path.join(repo, "pubspec.yaml"), "name: app\n");
    fs.writeFileSync(path.join(repo, "lib/session.dart"), session);
    const ctx = fileCtx("write", "lib/session.dart", session, undefined, { root: repo, isNew: true });

    const entries = [1, 2, 1, 2].map((version, index) => {
      const hash = `${version}${index}`.padStart(64, "0");
      writeCached({ id: `x/v${version}-${index}`, version: 1, hash, advice: "A", ...frozen(version) });
      return { id: `x/v${version}-${index}`, version: 1, hash, enabled: true };
    });
    const lockfile = { syncedAt: null, entries };
    // The frozen API 2 bundle expects its project at /project, so here it only proves the file access and the shape.
    const expected = [
      ["x/v1-0", ["relative", "shape", "alone", "late User user;"]],
      ["x/v2-1", ["shape", "fresh", "reads", "late User user;"]],
      ["x/v1-2", ["relative", "shape", "alone", "late User user;"]],
      ["x/v2-3", ["shape", "fresh", "reads", "late User user;"]],
    ];
    const summary = (run: Awaited<ReturnType<typeof runBoard>>) => run.firings.map((firing) => [firing.principle.id, said(firing.findings)]);

    const single = await runBoard(ctx, lockfile);
    expect(single.failures).toEqual([]);
    expect(summary(single)).toEqual(expected);

    const pool = new DetectorPool(path.resolve(import.meta.dirname, "../../cli/src/worker.ts"), 2);
    try {
      const parallel = await runBoard(ctx, lockfile, new Set(), pool, 1);
      expect(parallel.failures).toEqual([]);
      expect(summary(parallel)).toEqual(expected);
    } finally {
      await pool.close();
    }
  });
});
