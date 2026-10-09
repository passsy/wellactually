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
  sdkImports,
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
  const build = (detector: string, more: Record<string, string> = {}) => buildPrinciple({ "principle.md": advice, "detector.ts": detector, ...more });
  const quiet = "export function detect() { return []; }";
  const from = (version: number | string) => `import type { Ctx } from "@wellactually/sdk/v${version}";`;

  test("records the version the detector imports the SDK from", async () => {
    expect((await build(`${from(1)} ${quiet}`)).manifest.api).toBe(1);
    expect((await build(`${from(2)} ${quiet}`)).manifest.api).toBe(2);
    // An import of types only is gone from the bundle, so it is read from the source.
    expect((await build(`${from(1)} ${quiet}`)).bundle).not.toContain("sdk");
  });

  test("finds the import however it is written, and not in a comment or a string", async () => {
    expect(sdkImports(`import {\n  type Ctx,\n} from '@wellactually/sdk/v1'`)).toEqual(["@wellactually/sdk/v1"]);
    expect(sdkImports(`export { findWord } from "@wellactually/sdk/v2"; import "@wellactually/sdk/v2/test";`)).toEqual(["@wellactually/sdk/v2", "@wellactually/sdk/v2/test"]);
    expect(sdkImports(`// import { Ctx } from "@wellactually/sdk/v1";\n/* from "@wellactually/sdk/v1" */\nconst text = 'import x from "@wellactually/sdk/v1"';`)).toEqual([]);
    expect(sdkImports(`import fs from "node:fs"; import { a } from "./sdk.ts";`)).toEqual([]);
    expect((await build(`// was: import type { Ctx } from "@wellactually/sdk/v1";\n${from(2)} ${quiet}`)).manifest.api).toBe(2);
  });

  test("a new principle starts on the newest version", async () => {
    const files = scaffoldFiles("my-principle");
    expect(files["detector.ts"]).toContain(`from "@wellactually/sdk/v${API_VERSION}";`);
    expect(files["detector.test.ts"]).toContain(`from "@wellactually/sdk/v${API_VERSION}/test";`);
    expect((await buildPrinciple(files)).manifest.api).toBe(API_VERSION);
  });

  test("refuses a principle that names no version", async () => {
    await expect(build(quiet)).rejects.toThrow(`no file says which detector API the principle is written against. Import from the version in detector.ts, for example: import type { Ctx, Finding } from "@wellactually/sdk/v${API_VERSION}";`);
    await expect(build(`import type { Ctx } from "@wellactually/sdk"; ${quiet}`)).rejects.toThrow(
      `detector.ts imports "@wellactually/sdk". The detector API version is part of the path: import from "@wellactually/sdk/v${API_VERSION}".`,
    );
    await expect(build(`import { findWord } from "@wellactually/sdk"; export function detect() { return findWord("a", "a") ? [] : []; }`)).rejects.toThrow(/The detector API version is part of the path/);
    await expect(build(`${from(2)} ${quiet}`, { "detector.test.ts": `import { detect } from "@wellactually/sdk/test";` })).rejects.toThrow(
      `detector.test.ts imports "@wellactually/sdk/test". The detector API version is part of the path: import from "@wellactually/sdk/v${API_VERSION}/test".`,
    );
  });

  test("refuses a version this host does not build for", async () => {
    await expect(build(`${from(API_VERSION + 1)} ${quiet}`)).rejects.toThrow(`detector.ts imports "@wellactually/sdk/v${API_VERSION + 1}". This version of Well Actually builds for the detector API versions 1 to ${API_VERSION}.`);
    await expect(build(`${from(0)} ${quiet}`)).rejects.toThrow(/builds for the detector API versions/);
    await expect(build(`${from("next")} ${quiet}`)).rejects.toThrow(/The detector API version is part of the path/);
  });

  test("refuses a principle whose files disagree about the version", async () => {
    await expect(build(`${from(1)} ${quiet}`, { "detector.test.ts": `import { detect } from "@wellactually/sdk/v2/test";` })).rejects.toThrow(
      `the principle is written against 2 versions of the detector API: detector.test.ts imports "@wellactually/sdk/v2/test", detector.ts imports "@wellactually/sdk/v1". Import from one version everywhere.`,
    );
    // A project in fixtures/ is data for a test, whatever it imports.
    expect((await build(`${from(1)} ${quiet}`, { "fixtures/app/detector.ts": from(2) })).manifest.api).toBe(1);
  });

  test("refuses the declaration that the import path replaced", async () => {
    await expect(build(`${from(2)} export const api = 2; ${quiet}`)).rejects.toThrow("detector.ts exports api. The version is part of the import path now, and this principle imports version 2. Remove the line.");
  });

  test("refuses what the version did not have", async () => {
    await expect(build(`import fs from "node:fs"; ${from(1)} export function detect() { return fs.existsSync("/") ? [] : []; }`)).rejects.toThrow(
      `detector.ts imports node:fs, which exists from detector API 2 on, and the principle is written against version 1. Import from "@wellactually/sdk/v${API_VERSION}" to use it.`,
    );
    // node:path is string logic and needs nothing from the host.
    const built = await build(`import path from "node:path"; ${from(1)} export function detect() { return path.join("a", "b") ? [] : []; }`);
    expect(built.manifest.api).toBe(1);
  });
});

describe("a detector that stays on an old version", () => {
  test("is built with today's SDK and behaves like the bundle that was built back then", async () => {
    // The source of the frozen API 1 bundle, uploaded again today. Back then the SDK had one path, today that version has its own.
    const source = fs.readFileSync(path.join(dir, "v1/detector.ts"), "utf8").replace('"@wellactually/sdk"', '"@wellactually/sdk/v1"');
    const today = await buildPrinciple({ "principle.md": "# T\n\nOne sentence.\n\nA paragraph of advice that is long enough to count as advice for an agent to read.", "detector.ts": source });
    const then = frozen(1);
    expect(today.manifest.api).toBe(1);

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
      "detector.ts": `import type { Ctx } from "@wellactually/sdk/v1";
        export function detect(ctx: Ctx) { return ctx.file?.path === "lib/a.dart" && !("project" in ctx) ? [{ evidence: ctx.text }] : []; }`,
      "detector.test.ts": `import { expect, test } from "vitest";
        import { detect, write } from "@wellactually/sdk/v1/test";
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
