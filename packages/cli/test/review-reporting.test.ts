import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

process.env.WELLACTUALLY_FINDINGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wa-report-index-"));
process.env.WELLACTUALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wa-report-config-"));
const { claimReviewSession, claimReviewWork, completeReviewWork, beginVerification, getReviewSession, noteSuggestionDelivery } = await import("../../findings/queues.mts");
const { createFindingRecord, createOccurrence, updateFindingRecord, getFindingRecord, listOccurrences, updateOccurrence } = await import("../../findings/crud.mts");
const { reportPendingReviewSuggestions, reviewActivityEvents, REVIEW_REPORT_MS } = await import("../src/registry/review-reports.ts");
const { writeConfig } = await import("../src/board/board.ts");
const registry = "https://example.invalid";
const a = "a".repeat(64), b = "b".repeat(64);
const inquiry = { status: "complete", reason: "Checked", questions: [{ question: "Applicable?", answer: "Yes", evidence: ["a.ts:1"] }], limits: [] };
function setup() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wa-review-report-"));
  fs.writeFileSync(path.join(repo, "a.ts"), "class Example {}\n");
  const session = claimReviewSession({ repo, target: "test", run: "run", registry, sets: [{ id: "all", principles: [{ id: "expert/a", version: 1, hash: a }, { id: "expert/b", version: 2, hash: b }] }] }, repo);
  const args = { repo, target: "test", session: session.id };
  const findings = [0, 1, 2].map(i => createFindingRecord({ repo, target: "test", finding: {
    title: `Issue ${i}`, rules: [{ id: "expert/a" }, ...(i === 1 ? [{ id: "expert/b" }] : [])], origins: [{ run: "run", unit: "all", source: `source-${i}` }],
  } }, repo));
  // Many occurrences remain one suggestion, not one per source location.
  for (let i = 0; i < 12; i++) createOccurrence({ repo, target: "test", occurrence: { findingId: findings[0]!.id, locations: [{ file: "a.ts", line: 1 }] } }, repo);
  const workArgs = { ...args, queue: "all", worker: "review" };
  for (let i = 0; i < 3; i++) {
    const claimed = claimReviewWork(workArgs, repo) as any;
    completeReviewWork({ ...workArgs, item: claimed.work.id, claim: claimed.work.claim.token, result: { ...(claimed.work.kind === "principle" ? { verdict: "followed", where: "a.ts:1" } : {}), findings: [], investigation: inquiry } }, repo);
  }
  const groups = [{ findings: findings.slice(0, 2).map(f => f.id), reason: "Same issue" }, { findings: [findings[2]!.id], reason: "Different issue" }];
  return { repo, args, groups, findings };
}

describe("reporting after aggregation", () => {
  test("resumes old version-pinned sessions without discarding their coverage", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wa-legacy-report-"));
    const manifest = { repo, target: "old", run: "old", sets: [{ id: "all", principles: [{ id: "expert/a", version: 1 }] }] };
    const original = claimReviewSession(manifest, repo);
    const upgraded = claimReviewSession({ ...manifest, sets: [{ id: "all", principles: [{ id: "expert/a", version: 1, hash: a }] }] }, repo);
    expect(upgraded.id).toBe(original.id);
    expect(upgraded.queues[0]!.items[1]!.principle?.hash).toBe(a);
    expect(claimReviewSession(manifest, repo).manifest).toBe(upgraded.manifest);
  });
  test("freezes one event per issue and attributed principle before any proof worker runs", () => {
    const s = setup();
    expect(getReviewSession(s.args, s.repo).suggestions).toBeUndefined();
    const aggregated = beginVerification({ ...s.args, groups: s.groups }, s.repo);
    expect(aggregated.suggestions!.events).toHaveLength(3);
    expect(aggregated.suggestions!.events.map(e => e.hash).sort()).toEqual([a, a, b]);
    expect(new Set(aggregated.suggestions!.events.map(e => e.id)).size).toBe(2);
    expect(aggregated.queues.at(-1)!.items.every(i => !i.completed)).toBe(true);
    expect(beginVerification({ ...s.args, groups: s.groups }, s.repo).suggestions).toEqual(aggregated.suggestions);
  });
  test("retries an ambiguous upload with unchanged IDs and never counts later fixes again", async () => {
    writeConfig({ registry, token: "test-token", handle: "test", stats: true });
    const s = setup();
    const session = beginVerification({ ...s.args, groups: s.groups }, s.repo);
    const failed = vi.fn(async () => { throw new Error("connection lost after acceptance"); });
    const at = Date.now();
    await reportPendingReviewSuggestions(failed, at);
    expect(getReviewSession(s.args, s.repo).suggestions?.lastError).toContain("connection lost");
    const sent = vi.fn(async () => {});
    expect(await reportPendingReviewSuggestions(sent, at + REVIEW_REPORT_MS - 1)).toBe(0);
    await reportPendingReviewSuggestions(sent, at + REVIEW_REPORT_MS);
    expect(sent.mock.calls.flat().flat()).toEqual(expect.arrayContaining(session.suggestions!.events.map(e => ({ id: e.id, type: "review_suggestion", principle: e.principle, revision: e.principle === "expert/a" ? 1 : 2, occurred_at: session.suggestions!.aggregatedAt, priority: "p2" }))));
    expect(getReviewSession(s.args, s.repo).suggestions?.sentAt).toBeTruthy();
    noteSuggestionDelivery(s.args, s.repo, { registry, lastError: "A concurrent retry timed out after acknowledgement" });
    expect(getReviewSession(s.args, s.repo).suggestions?.lastError).toBeUndefined();
    const f = getFindingRecord({repo:s.repo,target:"test",id:s.findings[0]!.id},s.repo);
    updateFindingRecord({ repo: s.repo, target: "test", id: f.id, expectedRevision: f.revision, patch: { state: "closed", closure: { reason: "resolved", explanation: "Fixed" } } }, s.repo);
    sent.mockClear();
    expect(await reportPendingReviewSuggestions(sent, at + 2 * REVIEW_REPORT_MS)).toBe(2);
    expect(sent.mock.calls.flat().flat()).toHaveLength(2);
    sent.mockClear();
    expect(await reportPendingReviewSuggestions(sent, at + 3 * REVIEW_REPORT_MS)).toBe(0);
    expect(sent).not.toHaveBeenCalled();
  });
  test("attributes the highest group priority to each credited principle", () => {
    const s = setup(), f = s.findings[1]!;
    updateFindingRecord({ repo: s.repo, target: "test", id: f.id, expectedRevision: f.revision, patch: { priority: "p1" } }, s.repo);
    const session = beginVerification({ ...s.args, groups: s.groups }, s.repo);
    const suggestions = reviewActivityEvents(session, s.repo, "test").filter(e => e.type === "review_suggestion");
    expect(suggestions.map(e => "priority" in e ? e.priority : undefined).sort()).toEqual(["p1", "p1", "p2"]);
    const current = getFindingRecord({ repo: s.repo, target: "test", id: f.id }, s.repo);
    updateFindingRecord({ repo: s.repo, target: "test", id: f.id, expectedRevision: current.revision, patch: { priority: "p3" } }, s.repo);
    expect(reviewActivityEvents(session, s.repo, "test").filter(e => e.type === "review_suggestion")).toEqual(suggestions);
  });
  test("tracks selections once across sets, including reviews with no suggestions", () => {
    const s = setup();
    const events = reviewActivityEvents(getReviewSession(s.args, s.repo), s.repo, "test");
    expect(events).toHaveLength(2);
    expect(events.every(e => e.type === "review_selection")).toBe(true);
    expect(events.map(e => e.principle)).toEqual(["expert/a", "expert/b"]);
  });
  test("reports each resolved finding after its own grace period even with open occurrences", () => {
    const s = setup(), session = beginVerification({ ...s.args, groups: s.groups }, s.repo);
    const occurrences = listOccurrences({repo:s.repo,target:"test",findingId:s.findings[0]!.id},s.repo);
    updateOccurrence({repo:s.repo,target:"test",id:occurrences[0]!.id,expectedRevision:occurrences[0]!.revision,patch:{state:"closed",closure:{reason:"resolved",explanation:"Partial progress"}}},s.repo);
    expect(reviewActivityEvents(session,s.repo,"test",Date.now()+10*REVIEW_REPORT_MS).filter(e=>e.type==="finding_fixed")).toHaveLength(0);
    const f = getFindingRecord({repo:s.repo,target:"test",id:s.findings[0]!.id},s.repo);
    const closed = updateFindingRecord({repo:s.repo,target:"test",id:f.id,expectedRevision:f.revision,patch:{state:"closed",closure:{reason:"resolved",explanation:"Resolved finding"}}},s.repo);
    expect(listOccurrences({repo:s.repo,target:"test",findingId:f.id,state:"open"},s.repo)).toHaveLength(11);
    const at = Date.parse(closed.updatedAt);
    expect(reviewActivityEvents(session,s.repo,"test",at+REVIEW_REPORT_MS-1).filter(e=>e.type==="finding_fixed")).toHaveLength(0);
    const fixes=reviewActivityEvents(session,s.repo,"test",at+REVIEW_REPORT_MS).filter(e=>e.type==="finding_fixed");
    expect(fixes).toHaveLength(2); // One finding, once for each linked principle.
    expect(new Set(fixes.map(e=>e.id)).size).toBe(1);
    const reopened = updateFindingRecord({repo:s.repo,target:"test",id:f.id,expectedRevision:closed.revision,patch:{state:"open",closure:null}},s.repo);
    expect(reviewActivityEvents(session,s.repo,"test",at+10*REVIEW_REPORT_MS).filter(e=>e.type==="finding_fixed")).toHaveLength(0);
    const reclosed=updateFindingRecord({repo:s.repo,target:"test",id:f.id,expectedRevision:reopened.revision,patch:{state:"closed",closure:{reason:"resolved",explanation:"Confirmed"}}},s.repo);
    expect(reviewActivityEvents(session,s.repo,"test",Date.parse(reclosed.updatedAt)+REVIEW_REPORT_MS-1).filter(e=>e.type==="finding_fixed")).toHaveLength(0);
    expect(reviewActivityEvents(session,s.repo,"test",Date.parse(reclosed.updatedAt)+REVIEW_REPORT_MS).filter(e=>e.type==="finding_fixed")).toEqual(fixes);
  });
  test("legacy proof groups do not link finding resolutions or require aggregation to report fixes", () => {
    const s=setup(), session=getReviewSession(s.args,s.repo);
    // Old proof groups can contain several independently visible findings.
    session.queues.push({id:"verification",phase:"verification",workers:1,items:[{id:"issue-1",kind:"verification",findings:s.findings.map(f=>f.id),reason:"Legacy group"}]} as any);
    for(const f of s.findings.slice(0,2)) updateFindingRecord({repo:s.repo,target:"test",id:f.id,expectedRevision:f.revision,patch:{state:"closed",closure:{reason:"resolved",explanation:"Telemetry test"}}},s.repo);
    const fixes=reviewActivityEvents(session,s.repo,"test",Date.now()+REVIEW_REPORT_MS).filter(e=>e.type==="finding_fixed");
    expect(fixes).toHaveLength(3); // G1/a, G2/a, G2/b, while G3 and all occurrences remain open.
    expect(new Set(fixes.map(e=>e.id)).size).toBe(2);
    expect(getFindingRecord({repo:s.repo,target:"test",id:s.findings[2]!.id},s.repo).state).toBe("open");
  });
  test("respects stats off and never sends a pinned report to another registry", async () => {
    const s = setup(); beginVerification({ ...s.args, groups: s.groups }, s.repo);
    const send = vi.fn(async () => {});
    writeConfig({ registry, token: "test-token", handle: "test", stats: false });
    expect(await reportPendingReviewSuggestions(send)).toBe(0);
    writeConfig({ registry: "https://another.invalid", token: "test-token", handle: "test", stats: true });
    expect(await reportPendingReviewSuggestions(send)).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});

test("the UI Fixed action resolves its finding and occurrences and reports once per linked principle", async () => {
  const { setStage } = await import('../../findings/api.mts');
  const s = setup(), session = beginVerification({...s.args,groups:s.groups},s.repo);
  setStage({repo:s.repo,target:'test',id:s.findings[0]!.id,to:'fixed',actor:'human'},s.repo);
  const occurrences = listOccurrences({repo:s.repo,target:'test',findingId:s.findings[0]!.id},s.repo);
  expect(occurrences).toHaveLength(12);
  expect(occurrences.every(o=>o.state==='closed' && o.closure?.reason==='resolved')).toBe(true);
  const at = Date.parse(getFindingRecord({repo:s.repo,target:'test',id:s.findings[0]!.id},s.repo).updatedAt);
  expect(reviewActivityEvents(session,s.repo,'test',at+REVIEW_REPORT_MS-1).filter(e=>e.type==='finding_fixed')).toHaveLength(0);
  const fixes=reviewActivityEvents(session,s.repo,'test',at+REVIEW_REPORT_MS).filter(e=>e.type==='finding_fixed');
  expect(fixes).toHaveLength(2);
  expect(new Set(fixes.map(e=>e.id)).size).toBe(1);
});

test("one upload batches pending events across review stores and acknowledges each owning ledger",async()=>{
  writeConfig({registry,token:"test-token",handle:"test",stats:true});
  const first=setup(),second=setup();
  beginVerification({...first.args,groups:first.groups},first.repo);beginVerification({...second.args,groups:second.groups},second.repo);
  const send=vi.fn(async(_events:unknown[])=>undefined);
  await reportPendingReviewSuggestions(send,Date.now()+40*REVIEW_REPORT_MS);
  expect(send).toHaveBeenCalledTimes(1);
  for(const current of [first,second]){
    const ledger=JSON.parse(fs.readFileSync(path.join(current.repo,".well-actually/test/review-event-delivery.json"),"utf8"));
    expect(Object.values(ledger.entries).every((e:any)=>Boolean(e.sentAt))).toBe(true);
  }
});
test("a failed upload stops the whole cycle rather than hammering every remaining store",async()=>{
  writeConfig({registry,token:"test-token",handle:"test",stats:true});
  const repo=fs.mkdtempSync(path.join(os.tmpdir(),"wa-report-bulk-"));
  claimReviewSession({repo,target:"large",run:"large",registry,sets:[{id:"all",principles:Array.from({length:601},(_,i)=>({id:`expert/bulk-${i}`,version:1}))}]},repo);
  const refused=vi.fn(async(_events:unknown[])=>{throw new Error("Too many review reports");});
  const at=Date.now()+50*REVIEW_REPORT_MS;
  await reportPendingReviewSuggestions(refused,at);
  expect(refused).toHaveBeenCalledTimes(1);
  const accepted=vi.fn(async(_events:unknown[])=>undefined);
  await reportPendingReviewSuggestions(accepted,at+REVIEW_REPORT_MS);
  expect(accepted).toHaveBeenCalledTimes(2);
  expect(accepted.mock.calls.every(([events])=>events.length<=500)).toBe(true);
  const ledger=JSON.parse(fs.readFileSync(path.join(repo,".well-actually/large/review-event-delivery.json"),"utf8"));
  expect(Object.values(ledger.entries).every((e:any)=>Boolean(e.sentAt)&&!e.error)).toBe(true);
});
