import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
process.env.WELLACTUALLY_FINDINGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wa-report-index-"));
process.env.WELLACTUALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wa-report-config-"));
const { claimReviewSession, claimReviewWork, completeReviewWork, beginVerification, getReviewSession, noteSuggestionDelivery } = await import("../../findings/queues.mts");
const { createCandidates, resolveCandidates, setResolution } = await import("../../findings/api.mts");
const { reportPendingReviewSuggestions, reviewActivityEvents, REVIEW_REPORT_MS } = await import("../src/registry/review-reports.ts");
const { writeConfig } = await import("../src/board/board.ts");
const registry = "https://example.invalid";
function setup() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wa-report-"));
  fs.writeFileSync(path.join(repo, "a.ts"), "first();\nsecond();\nthird();\n");
  const session = claimReviewSession({ repo, target: "test", run: "run", registry, sets: [{ id: "all", principles: [{ id: "expert/a", version: 1 }, { id: "expert/b", version: 2 }] }] }, repo);
  const args = { repo, target: "test", session: session.id };
  for (let i = 0; i < 3; i++) {
    const claim = claimReviewWork({ ...args, queue: "all", worker: "w" }, repo) as any;
    completeReviewWork({ ...args, queue: "all", worker: "w", item: claim.work.id, claim: claim.work.claim.token, result: { ...(claim.work.kind === "principle" ? { verdict: "followed", where: "a.ts:1" } : {}), findings: [], investigation: { status: "complete", reason: "Read", questions: [{ question: "Applicable?", answer: "Yes", evidence: ["a.ts:1"] }], limits: [] } } }, repo);
  }
  const created = createCandidates({ repo, target: "test", run: "run", candidates: [0, 1, 2].map(i => ({ source: `s${i}`, unit: "all", title: `Issue ${i}`, body: "Concern.\n\nChange it.", evidence: "Reasoned", priority: i === 1 ? "p1" : "p3", rule: i === 1 ? "expert/b" : "expert/a", anchor: { file: "a.ts", line: i + 1 } })) }, repo);
  expect(created.errors).toEqual([]);
  const groups = [{ candidates: ["C1", "C2"], reason: "Same issue" }, { candidates: ["C3"], reason: "Distinct" }];
  return { repo, args, groups, session };
}
function resolve(s: ReturnType<typeof setup>, ids: string[]) {
  const result = resolveCandidates({ ...s.args, decisions: ids.map(id => ({ id, status: "plausible", reason: "Source supports this concern" })) }, s.repo);
  expect(result.errors).toEqual([]);
  return result.resolved.map(c => c.findingId!);
}
describe("aggregated review telemetry", () => {
  test("tracks unique selected principles before aggregation and pins readable revisions", () => {
    const s = setup();
    expect(reviewActivityEvents(s.session, s.repo, "test")).toEqual([
      expect.objectContaining({ type: "review_selection", principle: "expert/a", revision: 1 }),
      expect.objectContaining({ type: "review_selection", principle: "expert/b", revision: 2 }),
    ]);
    expect(claimReviewSession({ ...s.args, run: "run", sets: [{ id: "all", principles: [{ id: "expert/a", version: 1 }, { id: "expert/b", version: 2 }] }] }, s.repo).id).toBe(s.session.id);
  });
  test("freezes one suggestion per group and credited principle with the highest priority", () => {
    const s = setup(), session = beginVerification({ ...s.args, groups: s.groups }, s.repo);
    expect(session.suggestions!.events).toHaveLength(3);
    expect(session.suggestions!.events.map(e => e.priority)).toEqual(["p1", "p1", "p3"]);
    expect(new Set(session.suggestions!.events.map(e => e.id)).size).toBe(2);
    expect(beginVerification({ ...s.args, groups: s.groups }, s.repo).suggestions).toEqual(session.suggestions);
    expect(session.queues.at(-1)!.items.every(i => !i.completed)).toBe(true);
  });
  test("waits five minutes after a complete fix and never counts partial fixes or reopenings twice", () => {
    const s = setup(), session = beginVerification({ ...s.args, groups: s.groups }, s.repo);
    const ids = resolve(s, ["C1", "C2"]);
    setResolution({ ...s.args, id: ids[0], to: "resolved", actor: "agent", commit: "abc" }, s.repo);
    expect(reviewActivityEvents(session, s.repo, "test", Date.now() + 10 * REVIEW_REPORT_MS).filter(e => e.type === "finding_fixed")).toHaveLength(0);
    const f = setResolution({ ...s.args, id: ids[1], to: "resolved", actor: "agent", commit: "def" }, s.repo);
    const at = Date.parse(f.history.at(-1)!.at);
    expect(reviewActivityEvents(session, s.repo, "test", at + REVIEW_REPORT_MS - 1).filter(e => e.type === "finding_fixed")).toHaveLength(0);
    const fixes = reviewActivityEvents(session, s.repo, "test", at + REVIEW_REPORT_MS).filter(e => e.type === "finding_fixed");
    expect(fixes).toHaveLength(2);
    expect(new Set(fixes.map(e => e.id)).size).toBe(1);
    setResolution({ ...s.args, id: ids[0], to: "regressed", actor: "review" }, s.repo);
    setResolution({ ...s.args, id: ids[0], to: "resolved", actor: "agent", commit: "ghi" }, s.repo);
    expect(reviewActivityEvents(session, s.repo, "test", Date.now() + 10 * REVIEW_REPORT_MS).filter(e => e.type === "finding_fixed")).toEqual(fixes);
  });
  test("durably retries unchanged events and throttles cycles across processes", async () => {
    writeConfig({ registry, token: "test-token", handle: "tester", stats: true });
    const s = setup(); beginVerification({ ...s.args, groups: s.groups }, s.repo);
    const at = Date.now(), failed = vi.fn(async () => { throw new Error("lost acknowledgement"); });
    await reportPendingReviewSuggestions(failed, at);
    expect(getReviewSession(s.args, s.repo).suggestions!.lastError).toContain("lost acknowledgement");
    const sent = vi.fn(async () => {});
    expect(await reportPendingReviewSuggestions(sent, at + REVIEW_REPORT_MS - 1)).toBe(0);
    expect(sent).not.toHaveBeenCalled();
    expect(await reportPendingReviewSuggestions(sent, at + REVIEW_REPORT_MS)).toBeGreaterThan(0);
    expect(getReviewSession(s.args, s.repo).suggestions!.sentAt).toBeTruthy();
    const events = sent.mock.calls.flat().flat();
    expect(events).toEqual(expect.arrayContaining(failed.mock.calls.flat().flat()));
    sent.mockClear();
    expect(await reportPendingReviewSuggestions(sent, at + 2 * REVIEW_REPORT_MS)).toBe(0);
    expect(sent).not.toHaveBeenCalled();
    noteSuggestionDelivery(s.args, s.repo, { registry, lastError: "concurrent error" });
    expect(getReviewSession(s.args, s.repo).suggestions!.lastError).toBeUndefined();
  });
  test("stats off and a different registry never send pending reports", async () => {
    const s = setup(); beginVerification({ ...s.args, groups: s.groups }, s.repo);
    const send = vi.fn(async () => {});
    writeConfig({ registry, token: "test", handle: "tester", stats: false });
    expect(await reportPendingReviewSuggestions(send)).toBe(0);
    writeConfig({ registry: "https://another.invalid", token: "test", handle: "tester", stats: true });
    expect(await reportPendingReviewSuggestions(send)).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
