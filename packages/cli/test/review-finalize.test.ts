import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { checkReview } from "../src/review.ts";

const script = path.resolve(import.meta.dirname, "../../../skills/review/scripts/finalize.mjs");

function fixture(): { dir: string; write: (file: string, value: unknown) => void; finish: () => Record<string, any> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-finalize-"));
  const write = (file: string, value: unknown): void => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), typeof value === "string" ? value : JSON.stringify(value));
  };
  write("plan.json", { target: { label: "feature" }, principles: [{ id: "expert/rule", detector: false, hits: [] }], omitted: [], skipped: [] });
  write("route.json", { route: "single", groups: [["expert/rule"]] });
  write("scope.json", { inScope: ["expert/rule"], outOfScope: [] });
  write("jobs.json", [{ id: "all", principles: ["expert/rule"], set: null }]);
  const finding = { file: "state.ts", line: 9, priority: "p2", evidence: "reasoned", scope: "introduced", problem: "Owner can retire before completion", fix: "Reject work after retirement", quote: "Retire pending work" };
  write("verdicts/all.json", { job: "all", verdicts: [{ principle: "expert/rule", verdict: "findings", findings: [finding, { ...finding, problem: "Separate ordering defect" }] }], outside: [] });
  write("verdicts/testing-all.json", { job: "all", verdicts: [], outside: [{ ...finding, principle: "expert/rule", evidence: "proven", provenTest: { command: "node repro.mjs", expected: "ignored", actual: "completed", artifact: "probes/all/repro.mjs", output: "probes/all/repro.log" } }] });
  write("probes/all/results.md", "A focused real-path probe failed.\nLimitation: platform execution unverified.\n");
  write("verified/all.json", [{ candidate: "all:expert/rule:0", status: "confirmed" }, { candidate: "all:expert/rule:1", status: "confirmed" }, { candidate: "testing-all:outside:0", status: "confirmed" }]);
  const finish = (): Record<string, any> => {
    execFileSync(process.execPath, ["--input-type=module", "-e", `import { finalizeReview } from ${JSON.stringify(pathToFileURL(script).href)}; finalizeReview(${JSON.stringify(dir)});`], { stdio: "pipe" });
    return JSON.parse(fs.readFileSync(path.join(dir, "findings.json"), "utf8"));
  };
  return { dir, write, finish };
}

describe("skill-local report finalization", () => {
  test("merges exact duplicates, keeps distinct defects on the same line and preserves proof", () => {
    const { dir, finish } = fixture();
    expect(checkReview(dir, "verify")).toMatchObject({ candidates: 3 });
    const report = finish();
    expect(report.findings).toHaveLength(2);
    const merged = report.findings.find((finding: any) => finding.candidates.length === 2);
    expect(merged).toMatchObject({ evidence: "proven", candidates: ["all:expert/rule:0", "testing-all:outside:0"], provenTest: { command: "node repro.mjs" } });
    expect(checkReview(dir, "report")).toMatchObject({ stage: "report", candidates: 3 });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "ratings.json"), "utf8"))).toEqual([{ id: "expert/rule", rating: "up" }]);
    expect(fs.readFileSync(path.join(dir, "report.md"), "utf8")).toContain("platform execution unverified");
    expect(fs.readFileSync(path.join(dir, "report.md"), "utf8")).toContain("verified/all.json");
  });

  test("retains corrected scope and plausible assumptions while dropping refuted sources", () => {
    const { dir, write, finish } = fixture();
    write("verified/all.json", [{ candidate: "all:expert/rule:0", status: "refuted", proof: "Caller cancels pending work" }, { candidate: "all:expert/rule:1", status: "plausible", scope: "pre_existing", reason: "Depends on external ordering" }, { candidate: "testing-all:outside:0", status: "refuted", proof: "Fixture bypasses real entry point" }]);
    const report = finish();
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ scope: "pre_existing", status: "plausible", reason: "Depends on external ordering" });
    expect(report.dismissed).toHaveLength(2);
    expect(checkReview(dir, "report")).toMatchObject({ stage: "report" });
    const text = fs.readFileSync(path.join(dir, "report.md"), "utf8");
    expect(text).toContain("Pre-existing observations");
    expect(text).toContain("Depends on external ordering");
  });

  test("completion rejects omitted board principles and unsubstantiated proven evidence", () => {
    const { dir, write } = fixture();
    write("jobs.json", [{ id: "all", principles: [], set: null }]);
    expect(() => checkReview(dir, "verify")).toThrow(/missing principle expert\/rule/);
    write("jobs.json", [{ id: "all", principles: ["expert/rule"], set: null }]);
    write("verdicts/testing-all.json", { job: "all", verdicts: [], outside: [{ scope: "introduced", evidence: "proven" }] });
    expect(() => checkReview(dir, "test")).toThrow(/without provenTest/);
  });

  test("finalization never upgrades reasoned evidence through confirmation", () => {
    const { write, finish } = fixture();
    write("verified/all.json", [{ candidate: "all:expert/rule:0", status: "confirmed" }, { candidate: "all:expert/rule:1", status: "refuted", proof: "No ordering defect" }, { candidate: "testing-all:outside:0", status: "refuted", proof: "Broken fixture" }]);
    expect(finish().findings[0].evidence).toBe("reasoned");
  });
});
