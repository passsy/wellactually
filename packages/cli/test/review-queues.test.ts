import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { claimReviewSession, claimReviewWork, completeReviewWork, getReviewSession, beginVerification, retryVerification, blockReviewWork, rateReviewPrinciple } from "../../findings/queues.mts";
import { createCandidates, listCandidates, listFindings, updateFinding, createFinding, baselineCheck } from "../../findings/api.mts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { checkReview, setupVerificationAgents } from "../../../skills/review/scripts/review.ts";

const inquiry = { status: "complete", reason: "Source traced", questions: [{ question: "Does the changed path satisfy the contract?", answer: "Yes", evidence: ["state.ts:1"] }], limits: [] };
const result = (kind: string) => ({ ...(kind === "principle" ? { verdict: "followed", where: "state.ts:1" } : {}), findings: [], investigation: inquiry });
function setup(count = 1) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wa-queue-")); fs.writeFileSync(path.join(repo, "state.ts"), "state();\n");
  const manifest = { repo, target: "test", run: "r", sets: [{ id: "a", principles: Array.from({ length: count }, (_, i) => ({ id: `p/${i}`, version: 1 })) }, { id: "b", principles: [] }] };
  const session = claimReviewSession(manifest, repo);
  return { repo, manifest, args: { repo, target: "test", session: session.id }, session };
}
const claim = (args: object, repo: string, worker = "w", queue = "a") => claimReviewWork({ ...args, queue, worker }, repo) as { state: string; work: { id: string; kind: string; claim: { token: string } } };
function finish(args: object, repo: string, work: ReturnType<typeof claim>["work"], worker = "w", queue = "a", value: Record<string, unknown> = result(work.kind)) {
  return completeReviewWork({ ...args, queue, worker, item: work.id, claim: work.claim.token, result: value }, repo);
}

describe("MCP-owned dynamic review and proof queues", () => {
  test.each([false, true])("proof checkouts are isolated with Git=%s; non-Git uses one worker in place", (git) => {
    const { repo, manifest } = setup(0);
    if (git) {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["add", "state.ts"], { cwd: repo });
      execFileSync("git", ["-c", "user.name=Queue Test", "-c", "user.email=queue@example.invalid", "commit", "-qm", "Initial fixture"], { cwd: repo });
      fs.writeFileSync(path.join(repo, "state.ts"), "dirtyState();\n");
    }
    const session = claimReviewSession({ ...manifest, run: "isolation" }, repo), args = { repo, target: "test", session: session.id };
    finish(args, repo, claim(args, repo).work); finish(args, repo, claim(args, repo, "wb", "b").work, "wb", "b");
    createCandidates({ target: "test", run: "isolation", candidates: Array.from({ length: 11 }, (_, i) => ({ source: `s${i}`, unit: "a", title: `Issue ${i}`, body: "Problem.\n\nRemedy.", evidence: "Reasoned", priority: "p3", anchor: { file: "state.ts", line: 1 } })) }, repo);
    const verification = beginVerification({ ...args, groups: Array.from({ length: 11 }, (_, i) => ({ candidates: [`C${i + 1}`], reason: "Distinct issue" })) }, repo);
    expect(verification.queues.at(-1)!.workers).toBe(git ? 2 : 1);
    const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "wa-proof-artifacts-"));
    fs.writeFileSync(path.join(artifacts, "plan.json"), JSON.stringify({ reviewProtocol: 4, root: repo, target: { kind: "git", head: null }, files: [{ path: "state.ts", status: "modified" }] }));
    fs.writeFileSync(path.join(artifacts, "tracking.json"), JSON.stringify(args));
    const files = setupVerificationAgents(artifacts);
    const roots = files.map(file => JSON.parse(fs.readFileSync(path.join(path.dirname(file), "workspace.json"), "utf8")).root);
    if (git) {
      expect(new Set(roots).size).toBe(2);
      for (const root of roots) expect(fs.readFileSync(path.join(root, "state.ts"), "utf8")).toBe("dirtyState();\n");
      fs.writeFileSync(path.join(roots[0], "state.ts"), "proofChanges();\n");
      expect(fs.readFileSync(path.join(repo, "state.ts"), "utf8")).toBe("dirtyState();\n");
      expect(fs.readFileSync(path.join(roots[1], "state.ts"), "utf8")).toBe("dirtyState();\n");
    } else expect(roots).toEqual([repo]);
  });

  test("blocked work is not replayed while other eligible work continues", () => {
    const { repo, args } = setup(1), owned = claim(args, repo);
    blockReviewWork({ ...args, queue: "a", worker: "w", reason: "Explicit safeguard rejection" }, repo);
    expect(() => finish(args, repo, owned.work)).toThrow("blocked");
    const other = claim(args, repo, "healthy"); expect(other.work.id).toBe("p/0");
    finish(args, repo, other.work, "healthy");
    expect(claim(args, repo, "healthy").state).toBe("blocked");
  });

  test("a blocked unverified issue is visible in Findings without a fabricated verification result", () => {
    const { repo, args } = setup(0);
    finish(args, repo, claim(args, repo).work); finish(args, repo, claim(args, repo, "wb", "b").work, "wb", "b");
    createCandidates({ target: "test", run: "r", candidates: [{ source: "unverified", unit: "a", title: "Preserve a suspected issue", body: "Possible contract failure.\n\nCheck the affected path.", evidence: "Speculative", priority: "p2", anchor: { file: "state.ts", line: 1 } }] }, repo);
    beginVerification({ ...args, groups: [{ candidates: ["C1"], reason: "Single issue" }] }, repo);
    claim(args, repo, "proof", "verification");
    blockReviewWork({ ...args, queue: "verification", worker: "proof", reason: "Automatic review rejected the worker request" }, repo);
    const finding = listFindings({ target: "test" }, repo)[0]!.findings[0]!;
    expect(finding).toMatchObject({ title: "Preserve a suspected issue", body: "Possible contract failure.\n\nCheck the affected path.", evidence: "Speculative", verdict: "undecided", resolution: "unresolved", verification: { status: "plausible" }, verificationBlock: { reason: "Automatic review rejected the worker request", candidates: ["C1"] } });
    expect(getReviewSession(args, repo).queues.at(-1)!.items[0]!.completed).toBeUndefined();
    expect(claim(args, repo, "new-proof", "verification").state).toBe("blocked");
  });
  test("MCP transport retains submitted investigations and returns compact progress", async () => {
    const { repo } = setup(0);
    const client = new Client({ name: "queue-transport-test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../src/main.ts", import.meta.url)), "mcp"] }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: { repo, target: "transport", ...args } });
      const content = (response.content as { type: string; text?: string }[]).find(x => x.type === "text")!.text!;
      if (response.isError) throw new Error(content);
      return JSON.parse(content);
    };
    try {
      const session = await call("claim_review_session", { run: "transport", sets: [{ id: "all", principles: [] }] });
      expect(session.queues[0].items).toBeUndefined();
      const args = { session: session.id, queue: "all", worker: "one" };
      const next = await call("claim_review_work", args);
      await call("complete_review_work", { ...args, item: next.work.id, claim: next.work.claim.token, result: result("source") });
      const details = await call("get_review_session", { session: session.id, includeResults: true, queue: "all" });
      expect(details.queues[0].items[0].completed.result.investigation.questions).toEqual(inquiry.questions);
      const aggregated = await call("begin_verification", { session: session.id, groups: [] });
      expect(aggregated.queues.at(-1).workers).toBe(0);
    } finally { await client.close(); }
  }, 20000);
  test("pins a session, sizes workers, isolates sets, validates coverage and recovers expired claims", () => {
    const { repo, args, manifest, session } = setup(21);
    expect(session.queues.map(q => q.workers)).toEqual([2, 1]);
    expect(claimReviewSession(manifest, repo).id).toBe(session.id);
    expect(() => claimReviewSession({ ...manifest, sets: [] }, repo)).toThrow();
    const first = claim(args, repo), second = claim(args, repo, "other");
    expect(first.work.id).toBe("source"); expect(second.work.id).toBe("p/0");
    expect(claim(args, repo).work.claim.token).toBe(first.work.claim.token);
    expect(() => finish(args, repo, first.work, "intruder")).toThrow("belongs");
    expect(() => finish(args, repo, second.work, "other", "a", { ...result("principle"), investigation: { ...inquiry, limits: ["Unsettled"] } })).toThrow("limits");
    expect(getReviewSession(args, repo).queues[0]!.items[1]!.completed).toBeUndefined();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
    const recovered = claim(args, repo, "replacement");
    expect(recovered.work.id).toBe(first.work.id); expect(recovered.work.claim.token).not.toBe(first.work.claim.token);
    expect(() => finish(args, repo, first.work)).toThrow("belongs");
    finish(args, repo, recovered.work, "replacement");
    finish(args, repo, recovered.work, "replacement"); // Lost completion response is safe to retry.
    clock.mockRestore();
    expect(claim(args, repo, "isolated", "b").work.id).toBe("source");
  });

  test("aggregates only after coverage, verifies every grouped candidate and leaves human triage untouched", () => {
    const { repo, args } = setup(0);
    expect(() => beginVerification({ ...args, groups: [] }, repo)).toThrow("complete");
    finish(args, repo, claim(args, repo).work);
    finish(args, repo, claim(args, repo, "wb", "b").work, "wb", "b");
    const draft = { unit: "a", title: "Protect state", body: "State can be stale.\n\nReject stale work.", evidence: "Reasoned", priority: "p3", anchor: { file: "state.ts", line: 1 } };
    createCandidates({ target: "test", run: "r", candidates: [{ ...draft, source: "one" }, { ...draft, source: "two" }] }, repo);
    expect(() => beginVerification({ ...args, groups: [{ candidates: ["C1"], reason: "one" }] }, repo)).toThrow("partition");
    const session = beginVerification({ ...args, groups: [{ candidates: ["C1", "C2"], reason: "Same defect and remedy" }] }, repo);
    expect(session.queues.at(-1)!.workers).toBe(1);
    const issue = claim(args, repo, "proof", "verification");
    expect(claim(args, repo, "another", "verification").state).toBe("waiting");
    const decisions = { summary: "Source supports one issue", proofs: ["state.ts:1"], limits: [], decisions: [{ id: "C1", status: "confirmed", method: "source", finding: { evidence: "Reasoned", anchor: { file: "state.ts", line: 1 } } }, { id: "C2", status: "refuted", reason: "Duplicate of C1; substantive claim retained" }] };
    const submit = (value: unknown) => completeReviewWork({ ...args, queue: "verification", worker: "proof", item: issue.work.id, claim: issue.work.claim.token, result: value }, repo);
    expect(() => submit({ ...decisions, decisions: [{ id: "C1", status: "confirmed" }, decisions.decisions[1]] })).toThrow();
    expect(listCandidates({ target: "test", run: "r", status: "pending" }, repo)).toHaveLength(2);
    expect(() => submit({ ...decisions, decisions: [{ ...decisions.decisions[0], finding: { evidence: "Reasoned", anchor: { file: "state.ts", line: 99 } } }, decisions.decisions[1]] })).toThrow("outside");
    submit(decisions);
    expect(listCandidates({ target: "test", run: "r", status: "pending" }, repo)).toEqual([]);
    expect(listFindings({ target: "test" }, repo)[0]!.findings[0]).toMatchObject({ verdict: "undecided", resolution: "unresolved", evidence: "Reasoned" });
    expect(claim(args, repo, "another", "verification").state).toBe("complete");
    const before = listFindings({ target: "test" }, repo)[0]!.findings[0]!;
    updateFinding({ target: "test", id: before.id, tags: ["owner:maintainer"] }, repo);
    retryVerification({ ...args, items: [issue.work.id], reason: "Runtime permission now matches host policy" }, repo);
    expect(getReviewSession(args, repo).queues.at(-1)!.items[0]!.previous).toHaveLength(1);
    const retried = claim(args, repo, "retry", "verification");
    const updatedDecisions = { ...decisions, proofs: ["probe.mjs:1"], decisions: [{ id: "C1", status: "confirmed", method: "executable", proof: "probe.mjs:1", finding: { anchor: { file: "state.ts", line: 1 }, evidence: "Proven", provenTest: "node probe.mjs; expected current owner; observed stale state", scope: "pre_existing" } }, { id: "C2", status: "refuted", reason: "Duplicate of C1" }] };
    completeReviewWork({ ...args, queue: "verification", worker: "retry", item: retried.work.id, claim: retried.work.claim.token, result: updatedDecisions }, repo);
    const findings = listFindings({ target: "test" }, repo)[0]!.findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: before.id, evidence: "Proven", verdict: "undecided", resolution: "unresolved", verification: { status: "confirmed" } });
    expect(findings[0]!.tags).toEqual(["owner:maintainer", "scope:pre_existing"]);
    const artifacts = path.join(repo, "artifacts"); fs.mkdirSync(artifacts);
    fs.writeFileSync(path.join(artifacts, "plan.json"), JSON.stringify({ reviewProtocol: 4, root: repo }));
    fs.writeFileSync(path.join(artifacts, "tracking.json"), JSON.stringify(args));
    expect(checkReview(artifacts, "verify").candidates).toBe(2);
    updateFinding({ target: "test", id: findings[0]!.id, evidence: "Speculative" }, repo);
    expect(() => checkReview(artifacts, "verify")).toThrow("Published evidence");
    fs.writeFileSync(path.join(artifacts, "findings.json"), "[]");
    expect(() => checkReview(artifacts, "verify")).toThrow("obsolete");
  });

  test("metadata baseline uses saved IDs and review ratings are durable and deduplicated", async () => {
    const { repo, args } = setup(1);
    finish(args, repo, claim(args, repo).work);
    finish(args, repo, claim(args, repo).work);
    finish(args, repo, claim(args, repo, "wb", "b").work, "wb", "b");
    beginVerification({ ...args, groups: [] }, repo);
    const metadata = createFinding({ target: "test", title: "Title wording", body: "Problem.\n\nRemedy.", priority: "p4", evidence: "Reasoned", anchor: { kind: "metadata", subject: "pr-title", file: "https://example.test/pr/1", line: 1, text: "Title" } }, repo);
    expect(baselineCheck({ target: "test", currentFindingIds: [metadata.id] }, repo)).toMatchObject({ seen: [metadata.id], stale: [] });
    const send = vi.fn(async () => "Recorded up for p/0@1");
    const rating = { ...args, id: "p/0", rating: "up", reason: "Useful source guidance" };
    await Promise.all([rateReviewPrinciple(rating, repo, send), rateReviewPrinciple(rating, repo, send)]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(getReviewSession(args, repo).ratings?.["p/0"]).toMatchObject({ rating: "up", version: 1, state: "sent" });
    await expect(rateReviewPrinciple({ ...rating, id: "skipped/rule" }, repo, send)).rejects.toThrow("retained");
    await expect(rateReviewPrinciple({ ...rating, rating: "down" }, repo, send)).rejects.toThrow("different rating");
  });

  test("independent MCP processes cannot claim the same work", async () => {
    const { repo, args } = setup(40);
    const module = fileURLToPath(new URL("../../findings/queues.mts", import.meta.url));
    const code = `import {claimReviewWork,completeReviewWork} from ${JSON.stringify(module)};const args=JSON.parse(process.argv[1]);const worker=process.argv[2];let ids=[];while(true){const next=claimReviewWork({...args,queue:'a',worker},args.repo);if(next.state!=='claimed')break;ids.push(next.work.id);completeReviewWork({...args,queue:'a',worker,item:next.work.id,claim:next.work.claim.token,result:{...(next.work.kind==='principle'?{verdict:'followed',where:'state.ts:1'}:{}),findings:[],investigation:${JSON.stringify(inquiry)}}},args.repo);}console.log(JSON.stringify(ids));`;
    const batches = await Promise.all(Array.from({ length: 6 }, (_, i) => promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(args), `worker-${i}`])));
    const ids = batches.flatMap(batch => JSON.parse(batch.stdout));
    expect(ids).toHaveLength(41); expect(new Set(ids).size).toBe(41);
    expect(getReviewSession(args, repo).queues[0]!.items.every(i => i.completed)).toBe(true);
  }, 20000);
});
