import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { targetPaths } from "./store/paths.mts";
import { listCandidates, listFindings, resolveCandidates, recordVerificationBlock } from "./api.mts";
import { readMeta } from "./store/findings.mts";
import { repoRelative } from "./store/paths.mts";
import { InputError, requireObject, str, optionalArray } from "./validate.mts";

type Json = Record<string, unknown>;
export interface QueueItem {
  id: string;
  kind: "source" | "principle" | "verification";
  principle?: { id: string; version: number };
  candidates?: string[];
  reason?: string;
  claim?: { token: string; worker: string; at: string; until: string };
  completed?: { worker: string; token: string; at: string; result: Json };
  previous?: { reason: string; completed: NonNullable<QueueItem["completed"]>; claim?: QueueItem["claim"] }[];
  blocked?: { reason: string; at: string; worker?: string; visibilityErrors?: string[] };
}
export interface ReviewSession {
  id: string;
  run: string;
  manifest: string;
  createdAt: string;
  updatedAt: string;
  phase: "review" | "verification";
  parallelProofs?: boolean;
  ratings?: Record<string, { version: number; rating: "up" | "down" | "not_applicable"; reason: string; state: "sending" | "sent" | "not_sent" | "uncertain"; at: string; response?: string }>;
  queues: { id: string; phase: "review" | "verification"; workers: number; items: QueueItem[] }[];
}
export function reviewSessionSummary(session: ReviewSession): unknown {
  return { id: session.id, run: session.run, phase: session.phase, parallelProofs: session.parallelProofs, createdAt: session.createdAt, updatedAt: session.updatedAt, queues: session.queues.map(queue => ({ id: queue.id, phase: queue.phase, workers: queue.workers, total: queue.items.length, completed: queue.items.filter(i => i.completed).length, claimed: queue.items.filter(i => !i.completed && !i.blocked && i.claim && Date.parse(i.claim.until) > Date.now()).length, pending: queue.items.filter(i => !i.completed && !i.blocked && (!i.claim || Date.parse(i.claim.until) <= Date.now())).length, blocked: queue.items.filter(i => i.blocked).length, limited: queue.items.filter(i => i.completed && ((i.completed.result.investigation as Json | undefined)?.status === "limited" || (Array.isArray(i.completed.result.limits) && i.completed.result.limits.length > 0))).length })) };
}
const LEASE_MS = 15 * 60_000;
function hasGit(repo: string): boolean { try { return Boolean(execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); } catch { return false; } }
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(nonempty);

/** Every server process shares the same lock. Never steal a lock from a living process. */
function locked<T>(dir: string, action: () => T): T {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, ".lock");
  const start = Date.now();
  while (true) {
    try { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, "owner"), String(process.pid)); break; }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const recovery = path.join(dir, ".recovery");
      let ownsRecovery = false;
      try {
        fs.mkdirSync(recovery); ownsRecovery = true;
        // Re-read inside the recovery guard: another process may already have recovered it.
        const pid = Number(fs.readFileSync(path.join(lock, "owner"), "utf8"));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (failure: any) { if (failure.code === "ESRCH") fs.rmSync(lock, { recursive: true, force: true }); }
        }
      } catch {
        if (ownsRecovery) {
          try { if (Date.now() - fs.statSync(lock).mtimeMs > 60_000 && !fs.existsSync(path.join(lock, "owner"))) fs.rmSync(lock, { recursive: true, force: true }); } catch { /* Owner released between reads. */ }
        }
      } finally { if (ownsRecovery) fs.rmSync(recovery, { recursive: true, force: true }); }
      if (Date.now() - start > 5000) throw new InputError("Review session is busy; retry this call");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return action(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

function location(args: Json, fallback: string): { repo: string; target: string; dir: string; file: string } {
  const repo = typeof args.repo === "string" ? path.resolve(args.repo) : fallback;
  if (!repo) throw new InputError("repo is required");
  const target = str(args, "target");
  const session = str(args, "session");
  if (!/^[a-f0-9]{64}$/.test(session)) throw new InputError("Invalid review session id");
  const dir = path.join(targetPaths(repo, target).dir, "sessions", session);
  return { repo, target, dir, file: path.join(dir, "session.json") };
}
function read(file: string): ReviewSession { return JSON.parse(fs.readFileSync(file, "utf8")); }
function save(file: string, session: ReviewSession): void {
  session.updatedAt = new Date().toISOString();
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(session, null, 2) + "\n");
  fs.renameSync(temp, file);
}
function access<T>(raw: unknown, repo: string, callback: (session: ReviewSession, args: Json) => T): T {
  const args = requireObject(raw), at = location(args, repo);
  return locked(at.dir, () => { const session = read(at.file); const result = callback(session, args); save(at.file, session); return result; });
}

/** Claim one immutable run and create its per-set queues, idempotently. */
export function claimReviewSession(raw: unknown, repo: string): ReviewSession {
  const args = requireObject(raw), run = str(args, "run"), id = hash(run);
  const sets = optionalArray(args, "sets").map(value => {
    const set = requireObject(value), name = str(set, "id");
    const principles = optionalArray(set, "principles").map(value => {
      const principle = requireObject(value), version = principle.version;
      if (!Number.isInteger(version) || Number(version) < 1) throw new InputError("Each principle needs its pinned positive version");
      return { id: str(principle, "id"), version: Number(version) };
    });
    if (new Set(principles.map(p => p.id)).size !== principles.length) throw new InputError("A set cannot repeat a principle");
    return { id: name, principles };
  });
  if (!sets.length || new Set(sets.map(s => s.id)).size !== sets.length) throw new InputError("Supply distinct review sets");
  const at = location({ ...args, session: id }, repo), manifest = hash(JSON.stringify({ sets, scope: args.scope ?? null }));
  return locked(at.dir, () => {
    if (fs.existsSync(at.file)) { const old = read(at.file); if (old.manifest !== manifest) throw new InputError("Run already has a different queue manifest; start a new run"); return old; }
    const now = new Date().toISOString();
    const session: ReviewSession = { id, run, manifest, createdAt: now, updatedAt: now, phase: "review", parallelProofs: hasGit(at.repo), queues: sets.map(set => ({ id: set.id, phase: "review", workers: Math.max(1, Math.ceil(set.principles.length / 20)), items: [{ id: "source", kind: "source" }, ...set.principles.map(principle => ({ id: principle.id, kind: "principle" as const, principle }))] })) };
    save(at.file, session); return session;
  });
}
export function getReviewSession(raw: unknown, repo: string): ReviewSession {
  // Atomic rename on writes makes snapshot reads safe without taking the mutation lock.
  return read(location(requireObject(raw), repo).file);
}

/** Reserve before network I/O: interrupted or ambiguous sends are visible and never auto-replayed. */
export async function rateReviewPrinciple(raw: unknown, repo: string, send: (id: string, rating: "up" | "down" | "not_applicable", version: number) => Promise<string>): Promise<NonNullable<ReviewSession["ratings"]>[string]> {
  const args = requireObject(raw), id = str(args, "id"), rating = str(args, "rating"), reason = str(args, "reason");
  if (!["up", "down", "not_applicable"].includes(rating)) throw new InputError("Invalid rating");
  const at = location(args, repo);
  let reserved = false;
  const entry = access(raw, repo, session => {
    if (session.phase !== "verification" || session.queues.some(q => q.items.some(i => !i.completed)) || verificationProblems(session, at.repo, at.target).length) throw new InputError("Complete verification before review ratings");
    const principle = session.queues.flatMap(q => q.items).find(i => i.principle?.id === id)?.principle;
    if (!principle) throw new InputError("Only retained reviewed principles can receive review ratings");
    session.ratings ??= {};
    const prior = session.ratings[id];
    if (prior) { if (prior.rating !== rating) throw new InputError("Principle already has a different rating in this review"); return prior; }
    reserved = true;
    return session.ratings[id] = { version: principle.version, rating: rating as "up" | "down" | "not_applicable", reason, state: "sending", at: new Date().toISOString() };
  });
  if (!reserved) return entry;
  let response: string, state: "sent" | "not_sent" | "uncertain";
  try { response = await send(id, entry.rating, entry.version); state = response.startsWith("Recorded ") ? "sent" : "not_sent"; }
  catch (error) { response = error instanceof Error ? error.message : String(error); state = "uncertain"; }
  return access(raw, repo, session => session.ratings![id] = { ...entry, state, response });
}

/** One outstanding claim per worker. Expired claims can be recovered by another worker. */
export function claimReviewWork(raw: unknown, repo: string): unknown {
  return access(raw, repo, (session, args) => {
    const queue = session.queues.find(q => q.id === str(args, "queue"));
    if (!queue || queue.phase !== session.phase) throw new InputError("Queue is unavailable in this phase");
    const worker = str(args, "worker"), now = Date.now();
    const active = queue.items.find(item => !item.completed && !item.blocked && item.claim?.worker === worker && Date.parse(item.claim.until) > now);
    const item = active ?? queue.items.find(item => !item.completed && !item.blocked && (!item.claim || Date.parse(item.claim.until) <= now));
    if (!item) return { state: queue.items.every(item => item.completed) ? "complete" : queue.items.filter(item => !item.completed).every(item => item.blocked) ? "blocked" : "waiting", remaining: queue.items.filter(item => !item.completed).length };
    if (!active) item.claim = { token: randomUUID(), worker, at: new Date(now).toISOString(), until: new Date(now + LEASE_MS).toISOString() };
    else item.claim!.until = new Date(now + LEASE_MS).toISOString();
    const { completed: _, ...work } = item;
    return { state: "claimed", queue: queue.id, work };
  });
}

function validateInvestigation(result: Json, source: boolean): void {
  const inquiry = requireObject(result.investigation), status = str(inquiry, "status");
  if (!["complete", "limited", "not_applicable"].includes(status)) throw new InputError("investigation.status must be complete, limited or not_applicable");
  str(inquiry, "reason");
  if (!strings(inquiry.limits) || (status === "limited") !== (inquiry.limits.length > 0)) throw new InputError("Only limited investigations have unresolved limits; retain the limits and mark limited");
  const questions = optionalArray(inquiry, "questions");
  if (!questions.length) throw new InputError("Investigation needs at least one evidence-backed question");
  for (const value of questions) { const question = requireObject(value); str(question, "question"); str(question, "answer"); if (!strings(question.evidence) || !question.evidence.length) throw new InputError("Every question needs evidence locations"); }
  if (!strings(result.findings)) throw new InputError("findings must contain candidate ids only, or []");
  if (source) { if (status === "not_applicable") throw new InputError("Source review cannot be not_applicable"); return; }
  const verdict = str(result, "verdict");
  if (!["not_applicable", "followed", "findings"].includes(verdict)) throw new InputError("Invalid principle verdict");
  if ((verdict === "not_applicable") !== (status === "not_applicable")) throw new InputError("Applicability verdict and investigation status disagree");
  if (verdict === "findings" && !result.findings.length) throw new InputError("findings verdict needs an MCP candidate id");
  if (verdict !== "findings" && result.findings.length) throw new InputError("Candidate references need a findings verdict");
  if (verdict === "followed") str(result, "where");
}

/** Explicit final assessments prevent proof and anchor corrections from living only in prose. */
export function validateVerificationDecision(decision: Json, repo: string, target: string): void {
  if (decision.status === "refuted") return;
  const finding = requireObject(decision.finding), evidence = str(finding, "evidence"), method = str(decision, "method");
  if (!["source", "executable", "unverified"].includes(method)) throw new InputError("method must be source, executable or unverified");
  if (!["Proven", "Reasoned", "Speculative"].includes(evidence)) throw new InputError("finding.evidence must be exactly Proven, Reasoned or Speculative");
  if (method === "executable" && (evidence !== "Proven" || !nonempty(finding.provenTest) || !nonempty(decision.proof))) throw new InputError("Executable proof requires evidence Proven, provenTest and proof; use source/unverified for partial evidence");
  if (method !== "executable" && evidence === "Proven") throw new InputError("Proven requires an executable production-path probe");
  if ((method === "unverified") !== (decision.status === "plausible")) throw new InputError("Unverified findings must be plausible with an explicit reason");
  const anchor = requireObject(finding.anchor), line = Number(anchor.line), end = Number(anchor.endLine ?? line);
  let text: string;
  if (anchor.kind === "metadata") text = str(anchor, "text");
  else {
    const file = repoRelative(repo, str(anchor, "file"));
    try { text = fs.readFileSync(path.join(repo, file), "utf8"); }
    catch {
      const base = readMeta(targetPaths(repo, target))?.base;
      if (!base) throw new InputError("Final anchor must point to reviewed source or a deleted base file");
      try { text = execFileSync("git", ["show", `${base}:${file}`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
      catch { throw new InputError("Final anchor source is unavailable"); }
    }
  }
  const lines = text.replace(/\n$/, "").split("\n").length;
  if (!Number.isInteger(line) || !Number.isInteger(end) || line < 1 || end < line || end > lines) throw new InputError("Final anchor range is outside the reviewed source; correct it before completion");
}

/** The gate checks the published finding, rather than trusting queue completion alone. */
export function verificationProblems(session: ReviewSession, repo: string, target: string): string[] {
  const candidates = listCandidates({ repo, target, run: session.run }, repo);
  const findings = listFindings({ repo, target }, repo).flatMap(group => group.findings);
  const problems: string[] = [];
  for (const item of session.queues.filter(q => q.phase === "verification").flatMap(q => q.items)) {
    if (!item.completed) continue;
    for (const value of optionalArray(item.completed.result, "decisions")) {
      const decision = requireObject(value);
      if (decision.status === "refuted") continue;
      try {
        validateVerificationDecision(decision, repo, target);
        const candidate = candidates.find(c => c.id === decision.id), finding = findings.find(f => f.id === candidate?.findingId), final = requireObject(decision.finding);
        if (!finding || candidate?.status !== decision.status || finding.verification?.status !== decision.status) throw new Error("Published finding is missing or has a different verification status");
        for (const key of ["evidence", "provenTest", "title", "body"] as const) if (final[key] !== undefined && final[key] !== finding[key]) throw new Error(`Published ${key} differs from verification`);
        const anchor = requireObject(final.anchor);
        for (const key of ["file", "line", "endLine", "kind", "subject", "text"] as const) if (anchor[key] !== undefined && anchor[key] !== finding.anchor[key]) throw new Error(`Published anchor.${key} differs from verification`);
        if (finding.verification?.method !== decision.method || JSON.stringify(finding.verification?.proofs) !== JSON.stringify(item.completed.result.proofs) || JSON.stringify(finding.verification?.limits) !== JSON.stringify(item.completed.result.limits)) throw new Error("Published finding is missing verification evidence or limits");
      } catch (error) { problems.push(`${item.id}/${decision.id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  return problems;
}

export function completeReviewWork(raw: unknown, repo: string): unknown {
  return access(raw, repo, (session, args) => {
    const queue = session.queues.find(q => q.id === str(args, "queue"));
    const item = queue?.items.find(i => i.id === str(args, "item"));
    if (!queue || !item) throw new InputError("Unknown queue item");
    const token = str(args, "claim"), worker = str(args, "worker"), result = requireObject(args.result);
    if (item.completed) {
      if (item.completed.token === token && item.completed.worker === worker && JSON.stringify(item.completed.result) === JSON.stringify(result)) return { state: "completed", item: item.id };
      throw new InputError("Item already completed by another submission");
    }
    if (item.blocked || queue.phase !== session.phase || item.claim?.token !== token || item.claim.worker !== worker || Date.parse(item.claim.until) <= Date.now()) throw new InputError("Claim expired, blocked or belongs to another worker; claim again");
    const at = location(args, repo);
    const candidates = listCandidates({ repo: at.repo, target: at.target, run: session.run }, at.repo);
    if (item.kind !== "verification") {
      validateInvestigation(result, item.kind === "source");
      for (const id of result.findings as string[]) {
        const candidate = candidates.find(c => c.id === id);
        if (!candidate || candidate.unit !== queue.id || (item.principle && candidate.rule !== item.principle.id)) throw new InputError(`${id} is not a candidate for this queue item`);
      }
    } else {
      str(result, "summary");
      if (!strings(result.limits) || !strings(result.proofs)) throw new InputError("Verification needs proofs and limits arrays");
      const decisions = optionalArray(result, "decisions").map(requireObject);
      const ids = decisions.map(d => str(d, "id"));
      if (new Set(ids).size !== ids.length || ids.length !== item.candidates!.length || item.candidates!.some(id => !ids.includes(id))) throw new InputError("Decisions must cover every candidate in the claimed group exactly once");
      for (const decision of decisions) validateVerificationDecision(decision, at.repo, at.target);
      const resolved = resolveCandidates({ repo: at.repo, target: at.target, decisions, proofs: result.proofs, limits: result.limits, reverify: Boolean(item.previous?.length) }, at.repo);
      if (resolved.errors.length) throw new InputError(JSON.stringify(resolved.errors));
    }
    item.completed = { worker, token, at: new Date().toISOString(), result };
    return { state: "completed", item: item.id };
  });
}

/** Aggregation only: partition every candidate into distinct issues; do not verify or refute here. */
export function beginVerification(raw: unknown, repo: string): ReviewSession {
  return access(raw, repo, (session, args) => {
    if (session.queues.filter(q => q.phase === "review").some(q => q.items.some(item => !item.completed))) throw new InputError("Review queues must be complete before aggregation");
    const at = location(args, repo), candidates = listCandidates({ repo: at.repo, target: at.target, run: session.run }, at.repo);
    const groups = optionalArray(args, "groups").map(value => {
      const group = requireObject(value);
      if (!strings(group.candidates) || !group.candidates.length) throw new InputError("Each issue group needs candidate ids");
      return { candidates: group.candidates, reason: str(group, "reason") };
    });
    const ids = groups.flatMap(g => g.candidates);
    if (ids.length !== candidates.length || new Set(ids).size !== ids.length || candidates.some(c => !ids.includes(c.id))) throw new InputError("Issue groups must partition all run candidates exactly once");
    const items: QueueItem[] = groups.map((group, i) => ({ id: `issue-${i + 1}`, kind: "verification", ...group }));
    const old = session.queues.find(q => q.phase === "verification");
    if (old) { if (JSON.stringify(old.items.map(i => ({ candidates: i.candidates, reason: i.reason }))) !== JSON.stringify(groups)) throw new InputError("Verification queue already exists with different groups"); return session; }
    session.phase = "verification";
    session.parallelProofs ??= hasGit(at.repo);
    session.queues.push({ id: "verification", phase: "verification", workers: items.length ? session.parallelProofs ? Math.ceil(items.length / 10) : 1 : 0, items });
    return session;
  });
}

/** Retry proof only, preserving grouping, prior attempts, linked finding IDs and human triage. */
export function retryVerification(raw: unknown, repo: string): ReviewSession {
  return access(raw, repo, (session, args) => {
    const reason = str(args, "reason"), ids = args.items;
    if (!strings(ids) || !ids.length || new Set(ids).size !== ids.length) throw new InputError("Supply distinct verification issue ids");
    const queue = session.queues.find(q => q.phase === "verification");
    if (!queue || session.phase !== "verification") throw new InputError("No verification queue");
    const chosen = ids.map(id => queue.items.find(item => item.id === id));
    if (chosen.some(item => !item?.completed)) throw new InputError("Only completed verification issues can be retried");
    for (const item of chosen as QueueItem[]) {
      item.previous = [...(item.previous ?? []), { reason, completed: item.completed!, ...(item.claim ? { claim: item.claim } : {}) }];
      delete item.completed; delete item.claim;
    }
    const remaining = queue.items.filter(item => !item.completed && !item.blocked).length;
    session.parallelProofs ??= hasGit(location(args, repo).repo);
    queue.workers = remaining ? session.parallelProofs ? Math.ceil(remaining / 10) : 1 : 0;
    return session;
  });
}

export function blockReviewWork(raw: unknown, repo: string): ReviewSession {
  return access(raw, repo, (session, args) => {
    const queue = session.queues.find(q => q.id === str(args, "queue")), worker = str(args, "worker"), reason = str(args, "reason");
    const item = queue?.items.find(i => !i.completed && i.claim?.worker === worker);
    if (!item) throw new InputError("Worker has no active queue item to block");
    item.blocked = { reason, at: new Date().toISOString(), worker };
    if (item.kind === "verification") {
      const at = location(args, repo);
      try {
        const visible = recordVerificationBlock({ repo: at.repo, target: at.target, candidates: item.candidates, reason }, at.repo);
        if (visible.errors.length) item.blocked.visibilityErrors = visible.errors;
      } catch (error) { item.blocked.visibilityErrors = [error instanceof Error ? error.message : String(error)]; }
    }
    return session;
  });
}
