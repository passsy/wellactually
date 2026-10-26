import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { buildBundle } from "@wellactually/core/node";
import { API_VERSION } from "@wellactually/sdk";
import { writeCached, type Lockfile } from "../src/board/board.ts";
import { checkReview, planInputReview, planReview, routeReview } from "../../../skills/review/scripts/review.ts";

const roots: string[] = [];
const originalHome = process.env.WELLACTUALLY_HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.WELLACTUALLY_HOME; else process.env.WELLACTUALLY_HOME = originalHome;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function temp(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-input-")); roots.push(root); return root; }
function write(root: string, file: string, content: string): void { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), content); }
const empty: Lockfile = { syncedAt: null, entries: [] };

async function board(): Promise<Lockfile> {
  process.env.WELLACTUALLY_HOME = temp();
  const bundle = await buildBundle({ "detector.ts": `import { onWrite } from "@wellactually/sdk/v4";
onWrite({ globs: ["**/*.ts"], *detect(event) { for (const line of event.written) if (line.text.includes("TODO")) yield { line: line.line }; } });` });
  writeCached({ id: "local/no-todo", version: 1, hash: "a".repeat(64), manifest: { title: "Finish work", summary: "Finish work", tags: [], events: ["write"], globs: ["**/*.ts"], handlers: [{ event: "write", globs: ["**/*.ts"] }], api: API_VERSION }, advice: "# Finish work\nNo TODO", bundle });
  return { syncedAt: null, entries: [{ id: "local/no-todo", hash: "a".repeat(64), version: 1, enabled: true }] };
}

test("reviews only the selected folder without Git and freezes content for workers and detectors", async () => {
  const root = temp(), out = temp(), lock = await board();
  write(root, "feature/a.ts", "// TODO finish\n");
  write(root, "feature/node_modules/vendor.ts", "ignored\n");
  write(root, "unrelated.ts", "not selected\n");
  const plan = await planInputReview(root, { paths: ["feature"] }, out, lock);
  expect(plan.target).toMatchObject({ kind: "snapshot", base: null, head: null });
  expect(plan.files.map((file) => file.path)).toEqual(["feature/a.ts"]);
  expect(plan.principles[0]?.hits).toMatchObject([{ file: "feature/a.ts", line: 1 }]);
  expect(fs.readFileSync(path.join(out, "diff.patch"), "utf8")).toContain("current contents; no comparison baseline");
  write(root, "feature/a.ts", "changed after preparation\n");
  expect(fs.readFileSync(path.join(plan.source as string, "feature/a.ts"), "utf8")).toBe("// TODO finish\n");
  expect(fs.existsSync(path.join(root, ".git"))).toBe(false);
  expect(fs.existsSync(path.join(out, "steps/reviewer.md"))).toBe(true);
});

test("accepts ordinary agent-supplied unified patches with additions and deletions, without Git", async () => {
  const root = temp(), before = temp(), out = temp(), lock = await board(), patch = path.join(temp(), "input.patch");
  write(root, "a.ts", "unchanged\n// TODO changed\n");
  write(root, "new.ts", "new content\n");
  write(before, "a.ts", "unchanged\nold\n"); write(before, "gone.ts", "removed\n");
  fs.writeFileSync(patch, "--- a.ts\n+++ a.ts\n@@ -1,2 +1,2 @@\n unchanged\n-old\n+// TODO changed\n--- /dev/null\n+++ new.ts\n@@ -0,0 +1 @@\n+new content\n--- gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed\n");
  const plan = await planInputReview(root, { patch, beforeRoot: before }, out, lock);
  expect(plan.target.kind).toBe("patch");
  expect(plan.files.map(({ path, status }) => [path, status])).toEqual([["a.ts", "modified"], ["new.ts", "added"], ["gone.ts", "deleted"]]);
  expect(plan.principles[0]?.hits).toMatchObject([{ file: "a.ts", line: 2 }]);
  expect(fs.readFileSync(path.join(plan.before as string, "gone.ts"), "utf8")).toBe("removed\n");
  expect(fs.readFileSync(path.join(plan.source as string, "a.ts"), "utf8")).toBe("unchanged\n// TODO changed\n");
});

test("rejects malformed, escaping and mismatched patches instead of claiming a clean review", async () => {
  const root = temp(), patch = path.join(temp(), "input.patch"); write(root, "a.ts", "actual\n");
  fs.writeFileSync(patch, "@@ -1 +1 @@\n-old\n+new\n");
  await expect(planInputReview(root, { patch }, temp(), empty)).rejects.toThrow(/headers/);
  fs.writeFileSync(patch, "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+wrong\n");
  await expect(planInputReview(root, { patch }, temp(), empty)).rejects.toThrow(/does not match/);
  fs.writeFileSync(patch, "--- ../escape.ts\n+++ ../escape.ts\n@@ -1 +1 @@\n-old\n+new\n");
  await expect(planInputReview(root, { patch }, temp(), empty)).rejects.toThrow(/inside the review root/);
});

test("includes staged, unstaged and untracked Git work without altering the index or branch", async () => {
  const root = temp();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");git("config", "user.name", "Fixture");git("config", "user.email", "fixture@example.invalid");git("config", "commit.gpgsign", "false");
  write(root, "a.ts", "original\n");write(root, "b.ts", "original\n");git("add", ".");git("commit", "-qm", "Start");
  write(root, "a.ts", "staged\n");write(root, "b.ts", "staged only\n");git("add", ".");
  write(root, "a.ts", "unstaged\n");write(root, "new.ts", "untracked\n");
  const index = git("diff", "--cached"), head = git("rev-parse", "HEAD");
  const plan = await planReview(root, "local", temp(), empty);
  expect(plan.files.map((f) => f.path).sort()).toEqual(["a.ts", "b.ts", "new.ts"]);
  expect(plan.target).toMatchObject({ kind: "git", head: null, base: head.trim() });
  expect(fs.readFileSync(path.join(plan.source as string, "a.ts"), "utf8")).toBe("unstaged\n");
  expect(fs.readFileSync(path.join(plan.source as string, "b.ts"), "utf8")).toBe("staged only\n");
  expect(fs.readFileSync(path.join(plan.source as string, "new.ts"), "utf8")).toBe("untracked\n");
  expect(git("diff", "--cached")).toBe(index);expect(git("branch", "--show-current").trim()).toBe("main");
});

test("snapshot completion accepts current findings and rejects invented regression scopes", async () => {
  const root = temp(), out = temp(), lock = await board();write(root, "a.ts", "const a = 1;\n");
  await planInputReview(root, { paths: ["a.ts"] }, out, lock);routeReview(out);
  const [job] = JSON.parse(fs.readFileSync(path.join(out, "jobs.json"), "utf8"));
  const result = { job: job.id, verdicts: [{ principle: "local/no-todo", verdict: "followed", where: "a.ts:1" }], outside: [{ file: "a.ts", line: 1, scope: "introduced", evidence: "reasoned", priority: "p3", problem: "A current defect", fix: "Fix it" }] };
  write(out, `verdicts/${job.id}.json`, JSON.stringify(result));
  expect(() => checkReview(out, "review")).toThrow(/snapshot findings must use scope current/);
  result.outside[0]!.scope = "current";write(out, `verdicts/${job.id}.json`, JSON.stringify(result));
  expect(checkReview(out, "review").candidates).toBe(1);
  write(out, "probes/all/results.md", "Fixture source check; execution is not required for this reasoned candidate.");
  write(out, "verdicts/testing-all.json", JSON.stringify({ job: "all", verdicts: [], outside: [] }));
  write(out, "verified/all.json", JSON.stringify([{ candidate: `${job.id}:outside:0`, status: "confirmed", scope: "current", evidence: "reasoned" }]));
  execFileSync(process.execPath, [path.resolve(import.meta.dirname, "../../../skills/review/scripts/finalize.mjs"), out], { stdio: "pipe" });
  expect(checkReview(out, "report").candidates).toBe(1);
  expect(JSON.parse(fs.readFileSync(path.join(out, "findings.json"), "utf8")).outside[0].scope).toBe("current");
  expect(fs.readFileSync(path.join(out, "report.md"), "utf8")).not.toContain("Pre-existing observations");
});
