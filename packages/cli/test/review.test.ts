import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { API_VERSION } from "@wellactually/sdk";
import { buildBundle } from "@wellactually/core/node";
import { writeCached } from "../src/board/board.ts";
import { buildSets, checkReview, packDiff, parseBudget, planReview, renderPlan, resolveTarget, routeReview } from "../src/review.ts";

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
    expect(fs.existsSync(path.join(out, "baseline.json"))).toBe(false);
    for (const step of ["reviewer.md", "testing.md", "verifier.md"]) {
      expect(fs.readFileSync(path.join(out, "steps", step), "utf8")).not.toBe("");
    }
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

  test("routes every board principle without a router-generated scope file", async () => {
    const out = await prepared();
    fs.unlinkSync(path.join(out, "scope.json"));
    expect(routeReview(out).jobs.flatMap((job) => job.principles)).toEqual(["ana/no-todo", "ana/server"]);
    expect(JSON.parse(fs.readFileSync(path.join(out, "scope.json"), "utf8"))).toEqual({ inScope: ["ana/no-todo", "ana/server"], outOfScope: [] });
  });

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

  test("large changes retain per-set discovery jobs when every principle is out of scope", async () => {
    const out = await prepared();
    fs.writeFileSync(path.join(out, "scope.json"), JSON.stringify({ inScope: [], outOfScope: [{ id: "ana/no-todo", reason: "Other stack" }, { id: "ana/server", reason: "Other stack" }] }));
    expect(routeReview(out, 2_000)).toMatchObject({ route: "sets", groups: [] });
    fs.writeFileSync(path.join(out, "sets.json"), JSON.stringify({ sets: [{ name: "web", files: ["web/page.ts"] }, { name: "media", files: ["media/worker.ts"] }] }));
    expect(buildSets(out).map(({ id, principles }) => ({ id, principles }))).toEqual([{ id: "set-01", principles: [] }, { id: "set-02", principles: [] }]);
  });

  test("a budget is written as the user says it", () => {
    expect([parseBudget("100k"), parseBudget("1m"), parseBudget("250000")]).toEqual([100_000, 1_000_000, 250_000]);
    expect(() => parseBudget("lots")).toThrow(/no budget/);
  });
});

describe("review completion", () => {
  function completed(sets: boolean = false): { dir: string; write: (file: string, value: unknown) => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-review-check-"));
    const write = (file: string, value: unknown): void => {
      const full = path.join(dir, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, typeof value === "string" ? value : JSON.stringify(value));
    };
    const unit = sets ? "set-01" : "all";
    const job = `${unit}-g1`;
    write("route.json", { route: sets ? "sets" : "single" });
    write("jobs.json", [{ id: job, principles: ["expert/rule"], parts: [], set: sets ? unit : null }]);
    // Distinct findings can share a location; identity must include the source and index.
    const finding = { file: "a.ts", line: 1, scope: "introduced", problem: "Broken boundary", fix: "Handle it" };
    write(`verdicts/${job}.json`, { job, verdicts: [{ principle: "expert/rule", verdict: "findings", findings: [finding, finding] }], outside: [] });
    const units = sets ? [unit, "crossing"] : [unit];
    for (const id of units) {
      if (id === "crossing") {
        write("verdicts/crossing.json", { job: id, verdicts: [], outside: [] });
      }
      write(`probes/${id}/results.md`, "Checked the production path; reproduction retained.\n");
      write(`verdicts/testing-${id}.json`, { job: id, verdicts: [], outside: [finding] });
      write(`verified/${id}.json`, [
        ...(id === unit ? [0, 1].map((index) => ({ candidate: `${job}:expert/rule:${index}`, status: "confirmed" })) : []),
        { candidate: `testing-${id}:outside:0`, status: "refuted" },
      ]);
    }
    write("findings.json", { complete: true, verdicts: [{ principle: "expert/rule", verdict: "findings" }], findings: [{ ...finding, candidates: [`${job}:expert/rule:0`, `${job}:expert/rule:1`] }], outside: [], dismissed: [], outOfScope: [] });
    return { dir, write };
  }

  test("checks every stage without requiring a report file, including change sets and crossing", () => {
    for (const sets of [false, true]) {
      const { dir } = completed(sets);
      for (const stage of ["review", "test", "verify", "report"]) {
        expect(checkReview(dir, stage)).toMatchObject({ stage, jobs: 1, units: sets ? 2 : 1, candidates: stage === "review" ? 2 : sets ? 4 : 3 });
      }
      expect(fs.existsSync(path.join(dir, "report.md"))).toBe(false);
    }
  });

  test("all principles out of scope still requires testing and an independent empty-set challenge", () => {
    const { dir, write } = completed();
    const outOfScope = [{ id: "expert/rule", reason: "Different language" }];
    write("plan.json", { principles: [{ id: "expert/rule" }], parts: [], tokens: { diff: 10 } });
    write("scope.json", { inScope: [], outOfScope });
    const route = routeReview(dir);
    expect(route).toMatchObject({ route: "single", groups: [], jobs: [] });
    fs.unlinkSync(path.join(dir, "verdicts/all-g1.json"));
    write("verdicts/testing-all.json", { job: "all", verdicts: [], outside: [] });
    write("verified/all.json", []);
    write("findings.json", { complete: true, verdicts: [], findings: [], outside: [], dismissed: [], outOfScope });
    expect(() => checkReview(dir, "verify")).toThrow(/challenges\/all.md is missing/);
    write("challenges/all.md", "Independently challenged the boundary via production caller; source trace ruled it out.");
    expect(checkReview(dir, "report")).toEqual({ stage: "report", jobs: 0, units: 1, candidates: 0 });
    write("route.json", { ...route, route: "sets" });
    expect(() => checkReview(dir, "review")).toThrow(/zero jobs require a single route/);
  });

  test("ordinary review needs no context, blind design or investigation artifacts", () => {
    const { dir } = completed();
    expect(() => checkReview(dir, "report")).not.toThrow();
    for (const file of ["context.md", "blind.md", "investigation/all.json"]) {
      expect(fs.existsSync(path.join(dir, file))).toBe(false);
    }
  });

  test("rejects missing and duplicate principle verdicts and unfinished jobs", () => {
    const { dir, write } = completed();
    write("verdicts/all-g1.json", { job: "all-g1", verdicts: [], outside: [] });
    expect(() => checkReview(dir, "review")).toThrow(/missing principle expert\/rule/);
    const verdict = { principle: "expert/rule", verdict: "followed" };
    write("verdicts/all-g1.json", { job: "all-g1", verdicts: [verdict, verdict], outside: [] });
    expect(() => checkReview(dir, "review")).toThrow(/repeats principle expert\/rule/);
    fs.unlinkSync(path.join(dir, "verdicts/all-g1.json"));
    expect(() => checkReview(dir, "review")).toThrow(/verdicts\/all-g1.json is missing/);
  });

  test("requires both testing evidence and testing verdicts even when a report already exists", () => {
    const { dir } = completed();
    fs.unlinkSync(path.join(dir, "probes/all/results.md"));
    fs.unlinkSync(path.join(dir, "verdicts/testing-all.json"));
    expect(() => checkReview(dir, "test")).toThrow(/probes\/all\/results.md is missing/);
    expect(() => checkReview(dir, "report")).toThrow(/verdicts\/testing-all.json is missing/);
  });

  test("rejects gapped, duplicate and foreign verification references despite matching file and line", () => {
    const { dir, write } = completed();
    const first = { candidate: "all-g1:expert/rule:0", status: "confirmed" };
    const testing = { candidate: "testing-all:outside:0", status: "refuted" };
    write("verified/all.json", [first, first, testing]);
    expect(() => checkReview(dir, "verify")).toThrow(/repeats candidate all-g1:expert\/rule:0/);
    expect(() => checkReview(dir, "verify")).toThrow(/missing candidate all-g1:expert\/rule:1/);
    write("verified/all.json", [first, testing, { candidate: "other:outside:0", status: "confirmed" }]);
    expect(() => checkReview(dir, "verify")).toThrow(/unknown candidate other:outside:0/);
  });

  test("requires per-unit verification including crossing and rejects stale verdict files", () => {
    const { dir, write } = completed(true);
    fs.unlinkSync(path.join(dir, "verified/crossing.json"));
    expect(() => checkReview(dir, "verify")).toThrow(/verified\/crossing.json is missing/);
    write("verdicts/stale.json", { job: "stale", verdicts: [], outside: [] });
    expect(() => checkReview(dir, "review")).toThrow(/Unexpected verdicts\/stale.json/);
  });

  test("allows fully described promoted findings without letting them substitute for source coverage", () => {
    const { dir, write } = completed();
    const file = path.join(dir, "verified/all.json");
    const entries = JSON.parse(fs.readFileSync(file, "utf8"));
    const promoted = { promoted: true, scope: "introduced", status: "confirmed", file: "a.ts", line: 1, priority: "p2", evidence: "reasoned", problem: "Dismissed hit is real", fix: "Handle it" };
    write("verified/all.json", [...entries, promoted]);
    expect(() => checkReview(dir, "verify")).not.toThrow();
    write("verified/all.json", [promoted]);
    expect(() => checkReview(dir, "verify")).toThrow(/missing candidate/);
  });

  test("the report retains every surviving source while permitting merged duplicate findings", () => {
    const { dir, write } = completed();
    const file = path.join(dir, "findings.json");
    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(() => checkReview(dir, "report")).not.toThrow();
    write("findings.json", { ...report, findings: [] });
    expect(() => checkReview(dir, "report")).toThrow(/missing surviving candidate all-g1:expert\/rule:0/);
    write("findings.json", { ...report, outside: [{ candidates: ["testing-all:outside:0"] }] });
    expect(() => checkReview(dir, "report")).toThrow(/retains unknown or refuted candidate testing-all:outside:0/);
    write("findings.json", { ...report, findings: [...report.findings, ...report.findings] });
    expect(() => checkReview(dir, "report")).toThrow(/repeats candidate all-g1:expert\/rule:0/);
    write("findings.json", { ...report, verdicts: [{ principle: "expert/rule", verdict: "unchecked" }] });
    expect(() => checkReview(dir, "report")).toThrow(/invalid verdict for expert\/rule/);
  });

  test("the report retains promoted verifier findings by their stable verification source", () => {
    const { dir, write } = completed();
    const file = path.join(dir, "verified/all.json");
    const entries = JSON.parse(fs.readFileSync(file, "utf8"));
    const promoted = { promoted: true, scope: "introduced", status: "confirmed", file: "a.ts", line: 1, priority: "p2", evidence: "reasoned", problem: "Dismissed hit is real", fix: "Handle it" };
    write("verified/all.json", [...entries, promoted]);
    expect(() => checkReview(dir, "report")).toThrow(/missing surviving candidate verified\/all.json:3/);
    const report = JSON.parse(fs.readFileSync(path.join(dir, "findings.json"), "utf8"));
    write("findings.json", { ...report, outside: [{ ...promoted, candidates: ["verified/all.json:3"] }] });
    expect(() => checkReview(dir, "report")).not.toThrow();
  });

  test("the CLI exits nonzero for incomplete work and reports successful checks", () => {
    const { dir, write } = completed();
    const command = ["skills/review/scripts/main.ts", "--check", dir, "--stage", "verify"];
    expect(execFileSync(process.execPath, command, { encoding: "utf8" })).toContain("Review verify is complete");
    write("verified/all.json", []);
    try {
      execFileSync(process.execPath, command, { encoding: "utf8", stdio: "pipe" });
      throw new Error("The incomplete check unexpectedly succeeded");
    } catch (error) {
      const result = error as { status?: number; stderr?: string };
      expect(result.status).toBe(1);
      expect(String(result.stderr)).toContain("missing candidate all-g1:expert/rule:0");
    }
  });

  test("rejects missing or incomplete findings and invalid stages", () => {
    const { dir, write } = completed();
    write("findings.json", { complete: true, verdicts: [], findings: [], outside: [], dismissed: [], outOfScope: [] });
    expect(() => checkReview(dir, "report")).toThrow(/findings.json is missing principle expert\/rule/);
    fs.unlinkSync(path.join(dir, "findings.json"));
    expect(() => checkReview(dir, "report")).toThrow(/findings.json is missing/);
    expect(() => checkReview(dir, "typo")).toThrow(/Unknown review stage/);
  });
});
