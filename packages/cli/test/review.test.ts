import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { API_VERSION } from "@wellactually/sdk";
import { buildBundle } from "@wellactually/core/node";
import { writeCached } from "../src/board/board.ts";
import { planReview, renderPlan, resolveTarget } from "../src/review.ts";

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
    expect(renderPlan(plan)).toContain("No detector saw image.bin: binary.");
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
