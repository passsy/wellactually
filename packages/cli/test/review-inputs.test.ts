import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { buildBundle } from "@wellactually/core/node";
import { API_VERSION } from "@wellactually/sdk";
import { writeCached, type Lockfile } from "../src/board/board.ts";
import {
  buildSets,
  checkReview,
  loadPrinciples,
  planInputReview,
  planReview,
  routeReview,
  setupAgents,
} from "../../../skills/review/scripts/review.ts";

const roots: string[] = [];
const originalHome = process.env.WELLACTUALLY_HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.WELLACTUALLY_HOME;
  else process.env.WELLACTUALLY_HOME = originalHome;
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function temp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-input-"));
  roots.push(root);
  return root;
}
function write(root: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}
const empty: Lockfile = { syncedAt: null, entries: [] };

test("revision reviews isolate HEAD in a worktree and reuse that worktree", async () => {
  const root = temp();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  write(root, "a.ts", "before\n");
  git("add", "."); git("commit", "-qm", "Before");
  const base = git("rev-parse", "HEAD");
  write(root, "a.ts", "after\n");
  git("add", "."); git("commit", "-qm", "After");
  const head = git("rev-parse", "HEAD");
  write(root, "a.ts", "user work\n");
  const first = await planReview(root, `${base}..${head}`, temp(), empty);
  try {
    expect(first.root).toBe(`${first.dir}-checkout`);
    expect(first.root).not.toBe(root);
    expect(fs.readFileSync(path.join(first.root, "a.ts"), "utf8")).toBe("after\n");
    expect(fs.readFileSync(path.join(root, "a.ts"), "utf8")).toBe("user work\n");
    const second = await planReview(first.root, `${base}..${head}`, temp(), empty);
    expect(second.root).toBe(first.root);
    for (const out of [first.dir, second.dir]) {
      expect(fs.existsSync(path.join(out, "source"))).toBe(false);
      expect(fs.existsSync(path.join(out, "before"))).toBe(false);
    }
  } finally {
    git("worktree", "remove", first.root);

  }
});

async function board(): Promise<Lockfile> {
  process.env.WELLACTUALLY_HOME = temp();
  const bundle = await buildBundle({
    "detector.ts": `import { onWrite } from "@wellactually/sdk/v4";
onWrite({ globs: ["**/*.ts"], *detect(event) { for (const line of event.written) if (line.text.includes("TODO")) yield { line: line.line }; } });`,
  });
  writeCached({
    id: "local/no-todo",
    version: 1,
    hash: "a".repeat(64),
    manifest: {
      title: "Finish work",
      summary: "Finish work",
      tags: [],
      events: ["write"],
      globs: ["**/*.ts"],
      handlers: [{ event: "write", globs: ["**/*.ts"] }],
      api: API_VERSION,
    },
    advice: "# Finish work\nNo TODO",
    bundle,
  });
  return {
    syncedAt: null,
    entries: [
      { id: "local/no-todo", hash: "a".repeat(64), version: 1, enabled: true },
    ],
  };
}

test("step 2 preserves the brief and defers board work until step 3", async () => {
  const root = temp(), out = temp(), lock = await board();
  write(root, "a.ts", "// TODO finish\n");
  write(out, "task.md", "User brief from step 1\n");
  const prepared = await planInputReview(root, { paths: ["a.ts"] }, out, null);
  expect(prepared.principlesLoaded).toBe(false);
  expect(prepared.principles).toEqual([]);
  expect(fs.existsSync(path.join(out, "diff.patch"))).toBe(true);
  expect(fs.existsSync(path.join(out, "principles.md"))).toBe(false);
  expect(() => routeReview(out)).toThrow(/Load principles/);
  const loaded = await loadPrinciples(out, lock);
  expect(loaded.principlesLoaded).toBe(true);
  expect(loaded.principles[0]?.hits).toMatchObject([{ file: "a.ts", line: 1 }]);
  write(out, "principles.md", "");
  expect(() => routeReview(out)).toThrow(/omitted triggered principle/);
  write(out, "principles.md", "local/no-todo\nlocal/no-todo\n");
  expect(() => routeReview(out)).toThrow(/unique current-board ids/);
  write(out, "principles.md", "local/no-todo\n");
  expect(routeReview(out).jobs[0]).toMatchObject({ queue: "all", principles: [] });
  expect(fs.existsSync(path.join(out, "scope.json"))).toBe(false);
  expect(fs.readFileSync(path.join(out, "principles.md"), "utf8")).toBe("local/no-todo\n");
  expect(fs.existsSync(path.join(out, "principles"))).toBe(false);
  write(out, "tracking.json", JSON.stringify({ repo: root, target: "local", run: "step-1" }));
  const agents = setupAgents(out);
  expect(agents.map(file => path.relative(out, file))).toEqual([
    "agents/reviewer-all-worker-1/INSTRUCTIONS.md", "agents/aggregator/INSTRUCTIONS.md",
  ]);
  const instructions = fs.readFileSync(agents[0]!, "utf8");
  expect(instructions).toContain("Worker: all-worker-1");
  expect(instructions).toContain(path.join(out, "task.md"));
  expect(instructions).toContain(path.join(out, "diff/part-01.patch"));
  expect(instructions).toContain("get_principle");
  expect(instructions).not.toContain("<dir>");
  expect(instructions).toContain("cannot execute project code");
  const routedJobs = JSON.parse(fs.readFileSync(path.join(out, "jobs.json"), "utf8"));
  write(out, "jobs.json", JSON.stringify([routedJobs[0], { ...routedJobs[0], id: "second" }]));
  expect(setupAgents(out).filter(file => file.includes("/aggregator/"))).toHaveLength(1);
  write(out, "jobs.json", JSON.stringify(routedJobs));
  expect(JSON.parse(fs.readFileSync(path.join(out, "detectors-triggered.json"), "utf8"))).toMatchObject([{ id: "local/no-todo", hits: [{ file: "a.ts", line: 1 }] }]);
  expect(JSON.parse(fs.readFileSync(path.join(out, "detectors-no-findings.json"), "utf8"))).toEqual([]);
  write(root, "a.ts", "const a = 1;\n");
  await loadPrinciples(out, lock);
  expect(JSON.parse(fs.readFileSync(path.join(out, "detectors-triggered.json"), "utf8"))).toEqual([]);
  expect(JSON.parse(fs.readFileSync(path.join(out, "detectors-no-findings.json"), "utf8"))).toMatchObject([{ id: "local/no-todo", hits: [] }]);
  expect(fs.readFileSync(path.join(out, "task.md"), "utf8")).toBe("User brief from step 1\n");
});

test("reviews only the assigned folder without Git and creates no source copies", async () => {
  const root = temp(),
    out = temp(),
    lock = await board();
  write(root, "feature/a.ts", "// TODO finish\n");
  write(root, "feature/node_modules/vendor.ts", "ignored\n");
  write(root, "unrelated.ts", "not selected\n");
  const plan = await planInputReview(root, { paths: ["feature"] }, out, lock);
  expect(plan.target).toMatchObject({
    kind: "snapshot",
    base: null,
    head: null,
  });
  expect(plan.files.map((file) => file.path)).toEqual(["feature/a.ts"]);
  expect(plan.principles[0]?.hits).toMatchObject([
    { file: "feature/a.ts", line: 1 },
  ]);
  expect(fs.readFileSync(path.join(out, "diff.patch"), "utf8")).toContain(
    "current contents; no comparison baseline",
  );
  write(root, "feature/a.ts", "changed after preparation\n");
  expect(
    fs.readFileSync(path.join(plan.root, "feature/a.ts"), "utf8"),
  ).toBe("changed after preparation\n");
  expect(fs.existsSync(path.join(out, "source"))).toBe(false);
  expect(fs.existsSync(path.join(out, "before"))).toBe(false);
  expect(fs.existsSync(path.join(root, ".git"))).toBe(false);
  expect(fs.existsSync(path.join(out, "steps/6_queue-reviewer.md"))).toBe(true);
  expect(fs.existsSync(path.join(out, "project.md"))).toBe(false);
});

test("cuts a snapshot review into change sets", async () => {
  const root = temp(),
    out = temp(),
    lock = await board();
  write(root, "web/page.ts", "diff --git a/x b/x\n" + "// TODO page\n".repeat(150));
  write(root, "media/worker.ts", "// TODO worker\n".repeat(150));
  await planInputReview(root, { paths: ["."] }, out, lock);
  await loadPrinciples(out, lock);
  write(out, "principles.md", "local/no-todo\n");
  expect(routeReview(out, 2_000).route).toBe("sets");
  fs.writeFileSync(
    path.join(out, "sets.json"),
    JSON.stringify({
      sets: [
        { name: "web", files: ["web/page.ts"] },
        { name: "media", files: ["media/worker.ts"] },
      ],
    }),
  );
  const jobs = buildSets(out);
  expect(jobs.length).toBeGreaterThan(0);
  const media = jobs
    .filter((job) => job.set === "set-02")
    .flatMap((job) => job.parts)
    .map((part) => fs.readFileSync(path.join(out, part), "utf8"))
    .join("");
  expect(media).toContain("# Snapshot: media/worker.ts");
  expect(media).not.toContain("web/page.ts");
  expect(jobs.length).toBe(new Set(jobs.map((job) => job.id)).size);
});

test("accepts ordinary agent-supplied unified patches with additions and deletions, without Git", async () => {
  const root = temp(),
    before = temp(),
    out = temp(),
    lock = await board(),
    patch = path.join(temp(), "input.patch");
  write(root, "a.ts", "unchanged\n// TODO changed\n");
  write(root, "new.ts", "new content\n");
  write(before, "a.ts", "unchanged\nold\n");
  write(before, "gone.ts", "removed\n");
  fs.writeFileSync(
    patch,
    "--- a.ts\n+++ a.ts\n@@ -1,2 +1,2 @@\n unchanged\n-old\n+// TODO changed\n--- /dev/null\n+++ new.ts\n@@ -0,0 +1 @@\n+new content\n--- gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed\n",
  );
  const plan = await planInputReview(
    root,
    { patch, beforeRoot: before },
    out,
    lock,
  );
  expect(plan.target.kind).toBe("patch");
  expect(plan.files.map(({ path, status }) => [path, status])).toEqual([
    ["a.ts", "modified"],
    ["new.ts", "added"],
    ["gone.ts", "deleted"],
  ]);
  expect(plan.principles[0]?.hits).toMatchObject([{ file: "a.ts", line: 2 }]);
  expect(
    fs.readFileSync(path.join(plan.before as string, "gone.ts"), "utf8"),
  ).toBe("removed\n");
  expect(
    fs.readFileSync(path.join(plan.root, "a.ts"), "utf8"),
  ).toBe("unchanged\n// TODO changed\n");
});

test("rejects malformed, escaping and mismatched patches instead of claiming a clean review", async () => {
  const root = temp(),
    patch = path.join(temp(), "input.patch");
  write(root, "a.ts", "actual\n");
  fs.writeFileSync(patch, "@@ -1 +1 @@\n-old\n+new\n");
  await expect(planInputReview(root, { patch }, temp(), empty)).rejects.toThrow(
    /headers/,
  );
  fs.writeFileSync(patch, "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+wrong\n");
  await expect(planInputReview(root, { patch }, temp(), empty)).rejects.toThrow(
    /does not match/,
  );
  fs.writeFileSync(
    patch,
    "--- ../escape.ts\n+++ ../escape.ts\n@@ -1 +1 @@\n-old\n+new\n",
  );
  await expect(planInputReview(root, { patch }, temp(), empty)).rejects.toThrow(
    /inside the review root/,
  );
});

test("includes staged, unstaged and untracked Git work without altering the index or branch", async () => {
  const root = temp();
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  write(root, "a.ts", "original\n");
  write(root, "b.ts", "original\n");
  git("add", ".");
  git("commit", "-qm", "Start");
  write(root, "a.ts", "staged\n");
  write(root, "b.ts", "staged only\n");
  git("add", ".");
  write(root, "a.ts", "unstaged\n");
  write(root, "new.ts", "untracked\n");
  const index = git("diff", "--cached"),
    head = git("rev-parse", "HEAD");
  const plan = await planReview(root, "local", temp(), empty);
  expect(plan.files.map((f) => f.path).sort()).toEqual([
    "a.ts",
    "b.ts",
    "new.ts",
  ]);
  expect(plan.target).toMatchObject({
    kind: "git",
    head: null,
    base: head.trim(),
  });
  expect(
    fs.readFileSync(path.join(plan.root, "a.ts"), "utf8"),
  ).toBe("unstaged\n");
  expect(
    fs.readFileSync(path.join(plan.root, "b.ts"), "utf8"),
  ).toBe("staged only\n");
  expect(
    fs.readFileSync(path.join(plan.root, "new.ts"), "utf8"),
  ).toBe("untracked\n");
  expect(git("diff", "--cached")).toBe(index);
  expect(git("branch", "--show-current").trim()).toBe("main");
});

test("snapshot completion keeps candidates in Findings MCP rather than local verification files", async () => {
  const root = temp(),
    out = temp(),
    lock = await board();
  write(root, "a.ts", "const a = 1;\n");
  await planInputReview(root, { paths: ["a.ts"] }, out, lock);
  const legacy = JSON.parse(fs.readFileSync(path.join(out, "plan.json"), "utf8"));
  write(out, "plan.json", JSON.stringify({ ...legacy, reviewProtocol: 2 }));
  write(
    out,
    "scope.json",
    JSON.stringify({ inScope: ["local/no-todo"], outOfScope: [] }),
  );
  routeReview(out);
  const [job] = JSON.parse(
    fs.readFileSync(path.join(out, "jobs.json"), "utf8"),
  );
  const result = {
    job: job.id,
    verdicts: [
      {
        principle: "local/no-todo",
        verdict: "followed",
        where: "a.ts:1",
        investigation: {
          status: "complete",
          reason: "All selected source was checked.",
          questions: [
            {
              question: "Do selected lines contain TODO markers?",
              answer: "No TODO marker exists in the selected source.",
              evidence: ["a.ts:1"],
            },
          ],
          limits: [],
        },
      },
    ],
    outside: [{ file: "a.ts" }],
  };
  write(out, `verdicts/${job.id}.json`, JSON.stringify(result));
  expect(() => checkReview(out, "review")).toThrow(
    /must contain Findings MCP candidate ids/,
  );
  result.outside = ["C1" as never];
  write(out, `verdicts/${job.id}.json`, JSON.stringify(result));
  expect(checkReview(out, "review").candidates).toBe(1);
  write(
    out,
    "probes/all/results.md",
    "Fixture source check; execution is not required for this reasoned candidate.",
  );
  write(
    out,
    "verdicts/testing-all.json",
    JSON.stringify({ job: "all", verdicts: [], outside: [] }),
  );
  write(
    out,
    "investigations/all.json",
    JSON.stringify([
      {
        job: job.id,
        principle: "local/no-todo",
        status: "checked",
        reason: "Selected source supports the absence of TODO markers.",
        limits: [],
      },
    ]),
  );
  write(out, "probes/verification/results.md", "Verifier source-traced the candidate; no executable claim required.");
  expect(checkReview(out, "verify").candidates).toBe(1);
  expect(fs.existsSync(path.join(out, "verified"))).toBe(false);
  expect(fs.existsSync(path.join(out, "findings.json"))).toBe(false);
});

test("excluded principles are absent from every worker-facing routing artifact", () => {
  const out = temp();
  const dart = {
    id: "expert/dart-only",
    version: 1,
    title: "Dart only",
    summary: "Use a Dart construct",
    tags: ["dart"],
    detector: true,
    hits: [],
    file: "principles/expert__dart-only.md",
  };
  const general = {
    id: "expert/general",
    version: 1,
    title: "General",
    summary: "Check ownership",
    tags: [],
    detector: false,
    hits: [],
    file: "principles/expert__general.md",
  };
  const uncertain = {
    id: "expert/uncertain",
    version: 1,
    title: "Uncertain",
    summary: "Might apply",
    tags: ["architecture"],
    detector: false,
    hits: [],
    file: "principles/expert__uncertain.md",
  };
  write(out, dart.file, "dart advice\n");
  write(out, general.file, "general advice\n");
  write(out, uncertain.file, "uncertain advice\n");
  write(
    out,
    "plan.json",
    JSON.stringify({
      principles: [dart, general, uncertain],
      parts: [{ file: "diff/part-01.patch", bytes: 10, files: ["App.kt"] }],
      tokens: { diff: 10, advice: 30 },
      skipped: [{ id: "expert/disabled", reason: "disabled" }],
    }),
  );
  write(
    out,
    "principles.md",
    "expert/dart-only\nexpert/general\nexpert/uncertain\n",
  );
  write(
    out,
    "scope.json",
    JSON.stringify({
      inScope: ["expert/general"],
      outOfScope: [
        {
          id: "expert/dart-only",
          reason: "Dart cannot apply to this Kotlin-only change.",
        },
      ],
    }),
  );

  const route = routeReview(out);

  expect(route.jobs.flatMap((job) => job.principles)).toEqual([
    "expert/general",
    "expert/uncertain",
  ]);
  expect(fs.existsSync(path.join(out, dart.file))).toBe(false);
  for (const file of [
    "plan.json",
    "principles.md",
    "scope.json",
    "route.json",
    "jobs.json",
  ]) {
    expect(fs.readFileSync(path.join(out, file), "utf8")).not.toContain(
      "expert/dart-only",
    );
    expect(fs.readFileSync(path.join(out, file), "utf8")).not.toContain("expert/disabled");
  }
});
