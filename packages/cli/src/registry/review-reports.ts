import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { boardHome, readConfig } from "../board/board.ts";
import { readRegistry } from "../../../findings/store/registry.mts";
import { targetPaths } from "../../../findings/store/paths.mts";
import { locked } from "../../../findings/store/lock.mts";
import { getReviewSession, noteSuggestionDelivery, type ReviewSession } from "../../../findings/queues.mts";
import { listCandidates, listFindings } from "../../../findings/api.mts";
import type { Finding } from "../../../findings/model/types.mts";
import { sendReviewEvents } from "./client.ts";
import type { ReviewEvent, RejectedReviewEvent } from "./review-events.ts";

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
function resolutionTimes(f: Finding): { first: string; current: string } | null {
  if (f.resolution !== "resolved") return null;
  let first: string | undefined, current: string | undefined, resolved = false;
  for (const change of f.history) {
    if (change.resolution === undefined) continue;
    const next = change.resolution === "resolved";
    if (next && !resolved) { first ??= change.at; current = change.at; }
    if (!next) current = undefined;
    resolved = next;
  }
  // Missing resolution history cannot establish the five-minute waiting period.
  return first && current ? { first, current } : null;
}

/** Derive activity from the existing review store without changing finding state. */
export function reviewActivityEvents(session: ReviewSession, repo: string, target: string, at = Date.now()): ReviewEvent[] {
  const pinned = new Map(session.queues.filter(q => q.phase === "review").flatMap(q => q.items.flatMap(i => i.principle ? [i.principle] : [])).map(p => [p.id, p]));
  const reviewId = session.reportId ?? hash(session.id + session.createdAt);
  const events: ReviewEvent[] = [...pinned.values()].filter(p => !p.id.startsWith("local/")).map(p => ({ id: reviewId, type: "review_selection", principle: p.id, revision: p.version, occurred_at: session.createdAt }));
  if (!session.suggestions) return events;
  const candidates = new Map(listCandidates({ repo, target, run: session.run }, repo).map(c => [c.id, c]));
  const findings = new Map(listFindings({ repo, target }, repo).flatMap(t => t.findings).map(f => [f.id, f]));
  for (const suggestion of session.suggestions.events) {
    const p = pinned.get(suggestion.principle); if (!p) continue;
    events.push({ id: suggestion.id, type: "review_suggestion", principle: p.id, revision: p.version, occurred_at: session.suggestions.aggregatedAt, priority: suggestion.priority });
    const group = session.queues.find(q => q.phase === "verification")?.items.find(i => hash(`${session.reportId ?? session.id + session.createdAt}:${[...(i.candidates ?? [])].sort().join(":")}`) === suggestion.id);
    if (!group?.candidates?.length) continue;
    const members = group.candidates.map(id => candidates.get(id));
    if (members.some(c => !c || c.status === "pending")) continue;
    const applicable = members.filter(c => c!.status !== "refuted");
    if (!applicable.length || applicable.some(c => !c!.findingId || !findings.has(c!.findingId))) continue;
    const survivors = [...new Set(applicable.map(c => c!.findingId!))].map(id => findings.get(id)!);
    const times = survivors.map(resolutionTimes);
    if (times.some(t => !t)) continue;
    if (at - Math.max(...times.map(t => Date.parse(t!.current))) < REVIEW_REPORT_MS) continue;
    const occurred_at = new Date(Math.max(...times.map(t => Date.parse(t!.first)))).toISOString();
    const priority = (["p0", "p1", "p2", "p3", "p4"] as const).find(p => survivors.some(f => f.priority === p)) ?? suggestion.priority;
    events.push({ id: suggestion.id, type: "finding_fixed", principle: p.id, revision: p.version, occurred_at, priority });
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
    for (let i = 0; i < pending.length; i += 500) {
      const batch = pending.slice(i, i + 500);
      try {
        const result = await send(batch.map(e => e.event));
        const rejected = new Map((result?.rejected ?? []).map(e => [identity(e), e.reason]));
        locked(lockDir, () => {
          const ledger = readLedger(file);
          for (const { event } of batch) {
            const entry = ledger.entries[identity(event)]; if (!entry || entry.sentAt) continue;
            const error = rejected.get(identity(event));
            if (error) entry.error = error;
            else { entry.sentAt = new Date(at).toISOString(); delete entry.error; reported++; }
          }
          writeLedger(file, ledger);
        });
      } catch (error) {
        locked(lockDir, () => {
          const ledger = readLedger(file);
          for (const { event } of batch) { const entry = ledger.entries[identity(event)]; if (entry && !entry.sentAt) entry.error = error instanceof Error ? error.message : String(error); }
          writeLedger(file, ledger);
        });
        break;
      }
    }
    for (const session of sessions.filter(s => s.suggestions)) {
      const ledger = readLedger(file);
      const keys = session.suggestions!.events.map(e => identity({ id: e.id, type: "review_suggestion", principle: e.principle }));
      const entries = keys.map(k => ledger.entries[k]);
      try { if (entries.every(e => e?.sentAt)) noteSuggestionDelivery({ repo: repo.path, target, session: session.id }, repo.path, { registry: config.registry, sentAt: new Date(at).toISOString() });
      else { const error = entries.find(e => e?.error)?.error; if (error) noteSuggestionDelivery({ repo: repo.path, target, session: session.id }, repo.path, { registry: config.registry, lastError: error }); } } catch { /* Session removed. */ }
    }
  }
  return reported;
}
