import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { API_VERSION } from "@wellactually/sdk";
import { buildBundle } from "@wellactually/core/node";
import { writeCached } from "../src/board/board.ts";
import { buildSets, packDiff, parseBudget, planReview, renderPlan, resolveTarget, routeReview } from "../src/review.ts";

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-review-repo-"));
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  fs.writeFileSync(path.join(dir, "gone.ts"), "export const gone = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "Start");
  return dir;
}

async function board(): Promise<void> {
  process.env.WELLACTUALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-review-home-"));
  const bundle = await buildBundle({
    "detector.ts": `import { onWrite } from "@wellactually/sdk/v3";
onWrite({
  globs: ["**/*.ts"],
  *detect(event) {
    for (const written of event.written) {
      if (written.text.includes("TODO")) {
        yield { line: written.line };
      }
    }
  },
});`,
  });
  const write = { title: "No TODO", summary: "Finish it now.", tags: ["typescript"], events: ["write" as const], globs: ["**/*.ts"], handlers: [{ event: "write" as const, globs: ["**/*.ts"] }], api: API_VERSION };
  writeCached({ id: "ana/no-todo", version: 1, hash: "1".repeat(64), manifest: write, advice: "# No TODO\n\nFinish it now.", bundle });
  writeCached({ id: "ana/off", version: 1, hash: "2".repeat(64), manifest: { ...write, title: "Off" }, advice: "Off", bundle });
  const advice = { title: "Verify on the server", summary: "Never trust the client.", tags: [], events: [], globs: [], handlers: [], api: API_VERSION };
  writeCached({ id: "ana/server", version: 2, hash: "3".repeat(64), manifest: advice, advice: "# Verify on the server\n\nNever trust the client.", bundle: "" });
}

const entries = [
  { id: "ana/no-todo", version: 1, hash: "1".repeat(64), enabled: true },
  { id: "ana/off", version: 1, hash: "2".repeat(64), enabled: false },
  // A principle without a detector is never enabled on the website, and still belongs in a review.
  { id: "ana/server", version: 2, hash: "3".repeat(64), enabled: false },
  { id: "ana/missing", version: 1, hash: "4".repeat(64), enabled: true },
];

describe("planning a review", () => {
  test("says so when there is no advisory board", async () => {
    process.env.WELLACTUALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-review-home-"));
    const dir = repo();
    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 3;\n");
    const plan = await planReview(dir, undefined, fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-review-out-")), { syncedAt: null, entries: [] });
    expect(renderPlan(plan)).toContain("No advisory board on this machine.");
  });

  test("local changes run the detectors on what was written, and every principle that is on is in the plan", async () => {
    await board();
    const dir = repo();
    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n// TODO: b\nexport const b = 2;\n");
    fs.writeFileSync(path.join(dir, "new.ts"), "// TODO: all of it\n");
    fs.writeFileSync(path.join(dir, "image.bin"), Buffer.from([0, 1, 2]));
    fs.writeFileSync(path.join(dir, "package-lock.json"), "{}\n");
    fs.rmSync(path.join(dir, "gone.ts"));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-review-out-"));

    const plan = await planReview(dir, undefined, out, { syncedAt: null, entries });

    expect(plan.target.head).toBeNull();
    expect(plan.files).toEqual([
      { path: "a.ts", status: "modified" },
      { path: "gone.ts", status: "deleted" },
      { path: "image.bin", status: "added" },
      { path: "new.ts", status: "added" },
      { path: "package-lock.json", status: "added" },
    ]);
    // Nothing the review could not look at passes for a clean result.
    expect(plan.unchecked).toEqual([{ file: "image.bin", reason: "binary" }]);
    expect(plan.omitted).toEqual([{ file: "package-lock.json", reason: "a lockfile" }]);
    expect(renderPlan(plan)).toContain("1 file left out as generated, 1 file no detector could read, 2 principles left out, each with its reason in plan.json.");
    expect(plan.principles.map(({ id, detector, hits }) => ({ id, detector, hits: hits.map(({ file, line }) => `${file}:${line}`) }))).toEqual([
      { id: "ana/no-todo", detector: true, hits: ["a.ts:2", "new.ts:1"] },
      { id: "ana/server", detector: false, hits: [] },
    ]);
    expect(plan.skipped).toEqual([
      { id: "ana/off", reason: "switched off on the website" },
      { id: "ana/missing", reason: "not downloaded, run the sync skill" },
    ]);
    expect(fs.readFileSync(path.join(out, "diff.patch"), "utf8")).toContain("+// TODO: all of it");
    expect(fs.readFileSync(path.join(out, "principles/ana__no-todo.md"), "utf8")).toContain("- a.ts: line 2: // TODO: b");
    expect(fs.readFileSync(path.join(out, "principles.md"), "utf8")).toContain("- ana/server | no detector | no tags | Verify on the server: Never trust the client.");
  });

  test("a branch is compared with the default branch since it left it, and switches in the project are respected", async () => {
    await board();
    const dir = repo();
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    };
    git("checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(dir, "b.ts"), "// TODO\n");
    git("add", ".");
    git("commit", "-q", "-m", "Add b");
    fs.writeFileSync(path.join(dir, ".wellactually.json"), JSON.stringify({ disabled: ["ana/server"] }));
    git("add", ".");
    git("commit", "-q", "-m", "Switch off");

    expect(resolveTarget(dir).label).toBe("HEAD against main");
    const plan = await planReview(dir, "main...HEAD", fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-review-out-")), { syncedAt: null, entries });
    expect(plan.files.map((file) => file.path)).toEqual([".wellactually.json", "b.ts"]);
    expect(plan.principles.map((principle) => principle.id)).toEqual(["ana/no-todo"]);
    expect(plan.skipped).toContainEqual({ id: "ana/server", reason: "switched off with the disable skill" });
  });
});

function block(file: string, hunks: number, lines = 10): { file: string; text: string } {
  const body = Array.from({ length: hunks }, (_, hunk) => `@@ -${hunk * 100 + 1},0 +${hunk * 100 + 1},${lines} @@\n${Array.from({ length: lines }, (_, line) => `+line ${line}\n`).join("")}`).join("");
  return { file, text: `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${body}` };
}

describe("cutting the diff into parts", () => {
  test("a small change stays one part", () => {
    expect(packDiff([block("a/x.ts", 1), block("b/y.ts", 1)], 10_000).map((part) => part.map((piece) => piece.file))).toEqual([["a/x.ts", "b/y.ts"]]);
  });

  test("a folder that fits stays together, even when files of another folder sort between", () => {
    const blocks = [block("web/a.ts", 4), block("media/b.ts", 4), block("web/c.ts", 4), block("media/d.ts", 4)];
    const media = Buffer.byteLength(blocks[1]!.text) + Buffer.byteLength(blocks[3]!.text);
    const parts = packDiff(blocks, media);
    expect(parts.map((part) => part.map((piece) => piece.file))).toEqual([
      ["media/b.ts", "media/d.ts"],
      ["web/a.ts", "web/c.ts"],
    ]);
  });

  test("only a file too large on its own is split, at its hunks, each piece with the file's header", () => {
    const big = block("lib/big.ts", 6);
    const parts = packDiff([big], Math.ceil(Buffer.byteLength(big.text) / 2));
    expect(parts.length).toBeGreaterThan(1);
    for (const [piece] of parts) {
      expect(piece!.text.startsWith("diff --git a/lib/big.ts b/lib/big.ts\n--- a/lib/big.ts\n+++ b/lib/big.ts\n@@ ")).toBe(true);
    }
    expect(parts.map(([piece]) => piece!.text.split("@@ -").length - 1).reduce((a, b) => a + b, 0)).toBe(6);
  });

  test("generated code is left out, boring code is not", async () => {
    await board();
    const dir = repo();
    fs.writeFileSync(path.join(dir, "model.g.dart"), "// GENERATED CODE - DO NOT MODIFY BY HAND\npart of 'model.dart';\n");
    fs.writeFileSync(path.join(dir, "strings.ts"), Array.from({ length: 300 }, (_, index) => `export const s${index} = "text ${index}";`).join("\n"));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-review-out-"));
    const plan = await planReview(dir, undefined, out, { syncedAt: null, entries });
    expect(plan.omitted).toEqual([{ file: "model.g.dart", reason: "generated, as its first lines say" }]);
    expect(plan.parts.flatMap((part) => part.files)).toContain("strings.ts");
    expect(fs.readFileSync(path.join(out, "diff/index.md"), "utf8")).toContain("strings.ts");
  });
});

describe("routing a review", () => {
  async function prepared(): Promise<string> {
    await board();
    const dir = repo();
    fs.mkdirSync(path.join(dir, "web"));
    fs.mkdirSync(path.join(dir, "media"));
    fs.writeFileSync(path.join(dir, "web/page.ts"), "export const page = 1;\n".repeat(200));
    fs.writeFileSync(path.join(dir, "media/worker.ts"), "export const worker = 1;\n".repeat(200));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-review-out-"));
    await planReview(dir, undefined, out, { syncedAt: null, entries });
    // The router forgets ana/server: a principle it did not place is checked, not dropped.
    fs.writeFileSync(path.join(out, "scope.json"), JSON.stringify({ inScope: ["ana/no-todo"], outOfScope: [] }));
    return out;
  }

  test("a change that fits beside the advice goes to one reviewer, with every principle the router kept or forgot", async () => {
    const out = await prepared();
    const route = routeReview(out, 100_000);
    expect(route.route).toBe("single");
    expect(route.jobs).toEqual([{ id: "all", parts: ["diff/part-01.patch"], principles: ["ana/no-todo", "ana/server"], set: null }]);
    expect(JSON.parse(fs.readFileSync(path.join(out, "jobs.json"), "utf8"))).toEqual(route.jobs);
  });

  test("a change that does not fit is cut into change sets, and every file must be in exactly one", async () => {
    const out = await prepared();
    const route = routeReview(out, 2_000);
    expect(route.route).toBe("sets");
    fs.writeFileSync(path.join(out, "sets.json"), JSON.stringify({ sets: [{ name: "web", files: ["web/page.ts"] }] }));
    expect(() => buildSets(out)).toThrow(/media\/worker.ts is in no set/);
    fs.writeFileSync(path.join(out, "sets.json"), JSON.stringify({ sets: [{ name: "web", files: ["web/page.ts"] }, { name: "media", files: ["media/worker.ts"] }] }));
    const jobs = buildSets(out);
    expect(jobs.map((job) => [job.id, job.set])).toEqual([
      ["set-01", "set-01"],
      ["set-02", "set-02"],
    ]);
    expect(fs.readFileSync(path.join(out, jobs[1]!.parts[0]!), "utf8")).toContain("media/worker.ts");
    expect(fs.readFileSync(path.join(out, jobs[1]!.parts[0]!), "utf8")).not.toContain("web/page.ts");
  });

  test("a budget is written as the user says it", () => {
    expect([parseBudget("100k"), parseBudget("1m"), parseBudget("250000")]).toEqual([100_000, 1_000_000, 250_000]);
    expect(() => parseBudget("lots")).toThrow(/no budget/);
  });
});
