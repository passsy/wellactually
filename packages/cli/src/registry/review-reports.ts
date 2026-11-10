import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { boardHome, readConfig } from "../board/board.ts";
import { readRegistry } from "../../../findings/store/registry.mts";
import { targetPaths } from "../../../findings/store/paths.mts";
import { locked } from "../../../findings/store/lock.mts";
import { getReviewSession, noteSuggestionDelivery, type ReviewSession } from "../../../findings/queues.mts";
import { listFindingRecords } from "../../../findings/crud.mts";
import type { RecordBase } from "../../../findings/model/records.mts";
import { sendReviewEvents } from "./client.ts";
import type { ReviewEvent, ReviewPriority, RejectedReviewEvent } from "./review-events.ts";

export const REVIEW_REPORT_MS = 5 * 60_000;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const identity = (e: { id: string; type: string; principle: string }) => `${e.type}:${e.id}:${e.principle}`;
interface Queued { event: ReviewEvent; registry: string; sentAt?: string; error?: string; }
interface Ledger { entries: Record<string, Queued>; }
const readLedger = (file: string): Ledger => { try { const data = JSON.parse(fs.readFileSync(file, "utf8")); if (data && data.entries && typeof data.entries === "object") return data; } catch { /* No acknowledgements yet. */ } return { entries: {} }; };
function writeLedger(file: string, ledger: Ledger) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 }); fs.renameSync(temp, file);
}

/** First historical resolution identifies the event; the current episode controls the five-minute delay. */
function resolutionTimes(f: Pick<RecordBase, "state" | "closure" | "history" | "updatedAt">): { first: string; current: string } | null {
  if (f.state !== "closed" || f.closure?.reason !== "resolved") return null;
  let state = "open", reason: unknown, first: string | undefined, current: string | undefined, resolved = false;
  for (const change of f.history) {
    if (change.patch.state !== undefined) state = String(change.patch.state);
    if (change.patch.closure !== undefined) reason = (change.patch.closure as { reason?: string } | null)?.reason;
    const next = state === "closed" && reason === "resolved";
    if (next && !resolved) { first ??= change.at; current = change.at; }
    if (!next) current = undefined;
    resolved = next;
  }
  return { first: first ?? f.updatedAt, current: current ?? f.updatedAt };
}

/** Derive tracking from authoritative review sessions and finding history. No workflow state is changed. */
export function reviewActivityEvents(session: ReviewSession, repo: string, target: string, at = Date.now()): ReviewEvent[] {
  const pinned = new Map(session.queues.filter(q => q.phase === "review").flatMap(q => q.items.flatMap(i => i.principle ? [i.principle] : [])).map(p => [p.id, p]));
  const reviewId = session.reportId ?? hash(session.id + session.createdAt);
  const events: ReviewEvent[] = [...pinned.values()].filter(p => !p.id.startsWith("local/")).map(p => ({ id: reviewId, type: "review_selection", principle: p.id, revision: p.version, occurred_at: session.createdAt }));
  const findings = new Map(listFindingRecords({ repo, target, run: session.run }, repo).map(f => [f.id, f]));
  for (const suggestion of session.suggestions?.events ?? []) {
    const p = pinned.get(suggestion.principle); if (!p) continue;
    const group = session.queues.find(q => q.phase === "verification")?.items.find(i => hash(`${session.reportId ?? session.id + session.createdAt}:${[...(i.findings ?? [])].sort().join(":")}`) === suggestion.id);
    const members = (group?.findings ?? []).flatMap(id => findings.get(id) ? [findings.get(id)!] : []);
    const priority: ReviewPriority = suggestion.priority ?? (["p0", "p1", "p2", "p3", "p4"] as const).find(level => members.some(f => f.priority === level)) ?? "p3";
    events.push({ id: suggestion.id, type: "review_suggestion", principle: p.id, revision: p.version, occurred_at: session.suggestions!.aggregatedAt, priority });
  }
  // A human resolves a finding, not a proof-queue group or its occurrence inventory.
  // Keep identity stable across reopening, retries, occurrence edits and old grouped sessions.
  for (const finding of findings.values()) {
    const times = resolutionTimes(finding);
    if (!times || at - Date.parse(times.current) < REVIEW_REPORT_MS) continue;
    const id = hash(`${reviewId}:${finding.id}`);
    const rules = new Set([...finding.rules.map(r => r.id), ...finding.origins.flatMap(o => o.rule ? [o.rule] : [])].map(r => r.replace(/@\d+$/, "")));
    for (const rule of rules) {
      const p = pinned.get(rule);
      if (!p || p.id.startsWith("local/")) continue;
      events.push({id,type:"finding_fixed",principle:p.id,revision:p.version,occurred_at:times.first,priority:finding.priority});
    }
  }
  return events;
}

/** At most one upload cycle per five minutes across plugin processes. */
function claimCycle(at: number): boolean {
  const dir = path.join(boardHome(), "review-reporting");
  return locked(dir, () => {
    const file = path.join(dir, "last-attempt");
    const last = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
    if (at >= last && at - last < REVIEW_REPORT_MS) return false;
    fs.writeFileSync(file, String(at)); return true;
  });
}

/** Pending telemetry and acknowledgements stay under <repo>/.well-actually, separate from the finding's content. */
export async function reportPendingReviewSuggestions(
  send: (events: ReviewEvent[]) => Promise<void | { rejected: RejectedReviewEvent[] }> = sendReviewEvents,
  at = Date.now(),
): Promise<number> {
  const config = readConfig();
  if (!config.stats || !config.token || !claimCycle(at)) return 0;
  let reported = 0;
  const targets: {repo:string;target:string;file:string;lockDir:string;sessions:ReviewSession[];pending:Queued[]}[]=[];
  for (const repo of readRegistry().repos) for (const target of repo.targets) {
    if (!fs.existsSync(repo.path)) continue;
    let dir: string, names: string[];
    try { dir = targetPaths(repo.path, target).dir; names = fs.readdirSync(path.join(dir, "sessions")); } catch { continue; }
    const file = path.join(dir, "review-event-delivery.json"), lockDir = path.join(dir, "review-event-delivery");
    const sessions: ReviewSession[] = [];
    for (const name of names.filter(n => /^[a-f0-9]{64}$/.test(n))) {
      try { const s = getReviewSession({ repo: repo.path, target, session: name }, repo.path); if (!s.reportRegistry || s.reportRegistry === config.registry) sessions.push(s); } catch { /* Vanished session. */ }
    }
    let pending: Queued[];
    try {
      const events = sessions.flatMap(s => reviewActivityEvents(s, repo.path, target, at));
      pending = locked(lockDir, () => {
        const ledger = readLedger(file);
        for (const event of events) ledger.entries[identity(event)] ??= { event, registry: config.registry };
        writeLedger(file, ledger);
        return Object.values(ledger.entries).filter(e => e.registry === config.registry && !e.sentAt);
      });
    } catch { continue; }
    targets.push({repo:repo.path,target,file,lockDir,sessions,pending});
  }
  // A review inbox is one client. Batch across stores rather than spending one
  // request per target, and stop the cycle after a transport/server refusal.
  const merged=new Map<string,{event:ReviewEvent;owners:typeof targets}>();
  for (const owner of targets) for (const entry of owner.pending) {
    const key=identity(entry.event), prior=merged.get(key);
    if (prior) prior.owners.push(owner);
    else merged.set(key,{event:entry.event,owners:[owner]});
  }
  const pending=[...merged.values()];
  for(let i=0;i<pending.length;i+=500){
    const batch=pending.slice(i,i+500);
    let rejected:Map<string,string>, failure:string|undefined;
    try { const result=await send(batch.map(e=>e.event)); rejected=new Map((result?.rejected??[]).map(e=>[identity(e),e.reason])); }
    catch(error){failure=error instanceof Error?error.message:String(error);rejected=new Map();}
    const owners=new Set(batch.flatMap(e=>e.owners));
    for(const owner of owners) locked(owner.lockDir,()=>{
      const ledger=readLedger(owner.file);
      for(const {event,owners} of batch){
        if(!owners.includes(owner))continue;
        const entry=ledger.entries[identity(event)];if(!entry||entry.sentAt)continue;
        const error=failure??rejected.get(identity(event));
        if(error)entry.error=error;
        else{entry.sentAt=new Date(at).toISOString();delete entry.error;reported++;}
      }
      writeLedger(owner.file,ledger);
    });
    if(failure)break;
  }
  for(const {repo,target,file,sessions} of targets){
    for (const session of sessions.filter(s => s.suggestions)) {
      const ledger = readLedger(file);
      const keys = session.suggestions!.events.map(e => identity({ id: e.id, type: "review_suggestion", principle: e.principle }));
      const entries = keys.map(k => ledger.entries[k]);
      try { if (entries.every(e => e?.sentAt)) noteSuggestionDelivery({ repo, target, session: session.id }, repo, { registry: config.registry, sentAt: new Date(at).toISOString() });
      else { const error = entries.find(e => e?.error)?.error; if (error) noteSuggestionDelivery({ repo, target, session: session.id }, repo, { registry: config.registry, lastError: error }); } } catch { /* Session removed. */ }
    }
  }
  return reported;
}
