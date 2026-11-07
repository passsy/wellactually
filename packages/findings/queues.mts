import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { locked } from "./store/lock.mts";
import { targetPaths } from "./store/paths.mts";
import {
  getFindingRecord,
  mergeFindingRecords,
  updateFindingRecord,
  listFindingRecords,
} from "./crud.mts";
import { upsertRegistry } from "./store/registry.mts";
import { InputError, requireObject, str, optionalArray } from "./validate.mts";

type Json = Record<string, unknown>;
export interface QueueItem {
  id: string;
  kind: "source" | "principle" | "verification";
  principle?: { id: string; version: number; hash?: string };
  findings?: string[];
  reason?: string;
  claim?: { token: string; worker: string; at: string; until: string };
  completed?: { worker: string; token: string; at: string; result: Json };
  previous?: {
    reason: string;
    completed: NonNullable<QueueItem["completed"]>;
    claim?: QueueItem["claim"];
  }[];
  blocked?: {
    reason: string;
    at: string;
    worker?: string;
    visibilityErrors?: string[];
  };
}
export interface ReviewSession {
  id: string;
  reportId?: string;
  reportRegistry?: string;
  formatVersion?: 2;
  run: string;
  manifest: string;
  createdAt: string;
  updatedAt: string;
  phase: "review" | "verification";
  parallelProofs?: boolean;
  /** Telemetry only; no finding text or repository paths leave the machine. */
  suggestions?: {
    events: {
      id: string;
      hash: string;
      principle: string;
      day: string;
      priority?: "p0" | "p1" | "p2" | "p3" | "p4";
    }[];
    aggregatedAt: string;
    registry?: string;
    sentAt?: string;
    lastError?: string;
  };
  ratings?: Record<
    string,
    {
      version: number;
      rating: "up" | "down" | "not_applicable";
      reason: string;
      state: "sending" | "sent" | "not_sent" | "uncertain";
      at: string;
      response?: string;
    }
  >;
  queues: {
    id: string;
    phase: "review" | "verification";
    workers: number;
    items: QueueItem[];
  }[];
}
export function reviewSessionSummary(session: ReviewSession): unknown {
  return {
    id: session.id,
    run: session.run,
    phase: session.phase,
    parallelProofs: session.parallelProofs,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.suggestions
      ? {
          suggestions: {
            count: session.suggestions.events.length,
            aggregatedAt: session.suggestions.aggregatedAt,
            sentAt: session.suggestions.sentAt,
            lastError: session.suggestions.lastError,
          },
        }
      : {}),
    queues: session.queues.map((queue) => ({
      id: queue.id,
      phase: queue.phase,
      workers: queue.workers,
      total: queue.items.length,
      completed: queue.items.filter((i) => i.completed).length,
      claimed: queue.items.filter(
        (i) =>
          !i.completed &&
          !i.blocked &&
          i.claim &&
          Date.parse(i.claim.until) > Date.now(),
      ).length,
      pending: queue.items.filter(
        (i) =>
          !i.completed &&
          !i.blocked &&
          (!i.claim || Date.parse(i.claim.until) <= Date.now()),
      ).length,
      blocked: queue.items.filter((i) => i.blocked).length,
      limited: queue.items.filter(
        (i) =>
          i.completed &&
          ((i.completed.result.investigation as Json | undefined)?.status ===
            "limited" ||
            (Array.isArray(i.completed.result.limits) &&
              i.completed.result.limits.length > 0)),
      ).length,
    })),
  };
}
const LEASE_MS = 15 * 60_000;
function hasGit(repo: string): boolean {
  try {
    return Boolean(
      execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    return false;
  }
}
const hash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(nonempty);

function location(
  args: Json,
  fallback: string,
): { repo: string; target: string; dir: string; file: string } {
  const repo =
    typeof args.repo === "string" ? path.resolve(args.repo) : fallback;
  if (!repo) throw new InputError("repo is required");
  const target = str(args, "target");
  const session = str(args, "session");
  if (!/^[a-f0-9]{64}$/.test(session))
    throw new InputError("Invalid review session id");
  const dir = path.join(targetPaths(repo, target).dir, "sessions", session);
  return { repo, target, dir, file: path.join(dir, "session.json") };
}
function read(file: string): ReviewSession {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function save(file: string, session: ReviewSession): void {
  session.updatedAt = new Date().toISOString();
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(session, null, 2) + "\n");
  fs.renameSync(temp, file);
}
function access<T>(
  raw: unknown,
  repo: string,
  callback: (session: ReviewSession, args: Json) => T,
): T {
  const args = requireObject(raw),
    at = location(args, repo);
  return locked(at.dir, () => {
    const session = read(at.file);
    const result = callback(session, args);
    save(at.file, session);
    return result;
  });
}

/** Claim one immutable run and create its per-set queues, idempotently. */
export function claimReviewSession(raw: unknown, repo: string): ReviewSession {
  const args = requireObject(raw),
    run = str(args, "run"),
    id = hash(run);
  const sets = optionalArray(args, "sets").map((value) => {
    const set = requireObject(value),
      name = str(set, "id");
    const principles = optionalArray(set, "principles").map((value) => {
      const principle = requireObject(value),
        version = principle.version;
      if (!Number.isInteger(version) || Number(version) < 1)
        throw new InputError(
          "Each principle needs its pinned positive version",
        );
      if (
        principle.hash !== undefined &&
        (typeof principle.hash !== "string" ||
          !/^[a-f0-9]{64}$/.test(principle.hash))
      )
        throw new InputError("Invalid principle hash");
      return {
        id: str(principle, "id"),
        version: Number(version),
        ...(principle.hash ? { hash: principle.hash as string } : {}),
      };
    });
    if (new Set(principles.map((p) => p.id)).size !== principles.length)
      throw new InputError("A set cannot repeat a principle");
    return { id: name, principles };
  });
  if (!sets.length || new Set(sets.map((s) => s.id)).size !== sets.length)
    throw new InputError("Supply distinct review sets");
  const at = location({ ...args, session: id }, repo),
    manifest = hash(JSON.stringify({ sets, scope: args.scope ?? null }));
  return locked(at.dir, () => {
    upsertRegistry(at.repo, at.target, new Date().toISOString());
    if (fs.existsSync(at.file)) {
      const old = read(at.file);
      if (old.manifest === manifest) return old;
      const pinned = new Map(
        old.queues
          .filter((q) => q.phase === "review")
          .flatMap((q) =>
            q.items.flatMap((i) => (i.principle ? [i.principle] : [])),
          )
          .map((p) => [p.id, p]),
      );
      const restored = sets.map((s) => ({
        ...s,
        principles: s.principles.map((p) =>
          p.hash
            ? p
            : {
                ...p,
                ...(pinned.get(p.id)?.hash
                  ? { hash: pinned.get(p.id)!.hash }
                  : {}),
              },
        ),
      }));
      if (
        old.manifest ===
        hash(JSON.stringify({ sets: restored, scope: args.scope ?? null }))
      )
        return old;
      // Hashes may be supplied after creating a version-pinned session. Enrich
      // the same immutable releases without discarding coverage or claims.
      const versionsOnly = sets.map((s) => ({
        ...s,
        principles: s.principles.map((p) => ({ id: p.id, version: p.version })),
      }));
      if (
        old.manifest !==
        hash(JSON.stringify({ sets: versionsOnly, scope: args.scope ?? null }))
      )
        throw new InputError(
          "Run already has a different queue manifest; start a new run",
        );
      for (const set of sets)
        for (const p of set.principles) {
          const prior = pinned.get(p.id);
          if (prior && p.hash) prior.hash = p.hash;
        }
      old.manifest = manifest;
      old.reportId ??= randomUUID();
      old.reportRegistry ??=
        typeof args.registry === "string" ? args.registry : undefined;
      save(at.file, old);
      return old;
    }
    const now = new Date().toISOString();
    const session: ReviewSession = {
      id,
      reportId: randomUUID(),
      ...(typeof args.registry === "string"
        ? { reportRegistry: args.registry }
        : {}),
      formatVersion: 2,
      run,
      manifest,
      createdAt: now,
      updatedAt: now,
      phase: "review",
      parallelProofs: hasGit(at.repo),
      queues: sets.map((set) => ({
        id: set.id,
        phase: "review",
        workers: Math.max(1, Math.ceil(set.principles.length / 20)),
        items: [
          { id: "source", kind: "source" },
          ...set.principles.map((principle) => ({
            id: principle.id,
            kind: "principle" as const,
            principle,
          })),
        ],
      })),
    };
    save(at.file, session);
    return session;
  });
}
export function getReviewSession(raw: unknown, repo: string): ReviewSession {
  // Atomic rename on writes makes snapshot reads safe without taking the mutation lock.
  return read(location(requireObject(raw), repo).file);
}

/** Reserve before network I/O: interrupted or ambiguous sends are visible and never auto-replayed. */
export async function rateReviewPrinciple(
  raw: unknown,
  repo: string,
  send: (
    id: string,
    rating: "up" | "down" | "not_applicable",
    version: number,
  ) => Promise<string>,
): Promise<NonNullable<ReviewSession["ratings"]>[string]> {
  const args = requireObject(raw),
    id = str(args, "id"),
    rating = str(args, "rating"),
    reason = str(args, "reason");
  if (!["up", "down", "not_applicable"].includes(rating))
    throw new InputError("Invalid rating");
  const at = location(args, repo);
  let reserved = false;
  const entry = access(raw, repo, (session) => {
    if (
      session.phase !== "verification" ||
      session.queues.some((q) => q.items.some((i) => !i.completed)) ||
      verificationProblems(session, at.repo, at.target).length
    )
      throw new InputError("Complete verification before review ratings");
    const principle = session.queues
      .flatMap((q) => q.items)
      .find((i) => i.principle?.id === id)?.principle;
    if (!principle)
      throw new InputError(
        "Only retained reviewed principles can receive review ratings",
      );
    session.ratings ??= {};
    const prior = session.ratings[id];
    if (prior) {
      if (prior.rating !== rating)
        throw new InputError(
          "Principle already has a different rating in this review",
        );
      return prior;
    }
    reserved = true;
    return (session.ratings[id] = {
      version: principle.version,
      rating: rating as "up" | "down" | "not_applicable",
      reason,
      state: "sending",
      at: new Date().toISOString(),
    });
  });
  if (!reserved) return entry;
  let response: string, state: "sent" | "not_sent" | "uncertain";
  try {
    response = await send(id, entry.rating, entry.version);
    state = response.startsWith("Recorded ") ? "sent" : "not_sent";
  } catch (error) {
    response = error instanceof Error ? error.message : String(error);
    state = "uncertain";
  }
  return access(
    raw,
    repo,
    (session) => (session.ratings![id] = { ...entry, state, response }),
  );
}

/** One outstanding claim per worker. Expired claims can be recovered by another worker. */
export function claimReviewWork(raw: unknown, repo: string): unknown {
  return access(raw, repo, (session, args) => {
    const queue = session.queues.find((q) => q.id === str(args, "queue"));
    if (!queue || queue.phase !== session.phase)
      throw new InputError("Queue is unavailable in this phase");
    const worker = str(args, "worker"),
      now = Date.now();
    const active = queue.items.find(
      (item) =>
        !item.completed &&
        !item.blocked &&
        item.claim?.worker === worker &&
        Date.parse(item.claim.until) > now,
    );
    const item =
      active ??
      queue.items.find(
        (item) =>
          !item.completed &&
          !item.blocked &&
          (!item.claim || Date.parse(item.claim.until) <= now),
      );
    if (!item)
      return {
        state: queue.items.every((item) => item.completed)
          ? "complete"
          : queue.items
                .filter((item) => !item.completed)
                .every((item) => item.blocked)
            ? "blocked"
            : "waiting",
        remaining: queue.items.filter((item) => !item.completed).length,
      };
    if (!active)
      item.claim = {
        token: randomUUID(),
        worker,
        at: new Date(now).toISOString(),
        until: new Date(now + LEASE_MS).toISOString(),
      };
    else item.claim!.until = new Date(now + LEASE_MS).toISOString();
    const { completed: _, ...work } = item;
    return { state: "claimed", queue: queue.id, work };
  });
}

function validateInvestigation(result: Json, source: boolean): void {
  const inquiry = requireObject(result.investigation),
    status = str(inquiry, "status");
  if (!["complete", "limited", "not_applicable"].includes(status))
    throw new InputError(
      "investigation.status must be complete, limited or not_applicable",
    );
  str(inquiry, "reason");
  if (
    !strings(inquiry.limits) ||
    (status === "limited") !== inquiry.limits.length > 0
  )
    throw new InputError(
      "Only limited investigations have unresolved limits; retain the limits and mark limited",
    );
  const questions = optionalArray(inquiry, "questions");
  if (!questions.length)
    throw new InputError(
      "Investigation needs at least one evidence-backed question",
    );
  for (const value of questions) {
    const question = requireObject(value);
    str(question, "question");
    str(question, "answer");
    if (!strings(question.evidence) || !question.evidence.length)
      throw new InputError("Every question needs evidence locations");
  }
  if (!strings(result.findings))
    throw new InputError("findings must contain finding ids only, or []");
  if (source) {
    if (status === "not_applicable")
      throw new InputError("Source review cannot be not_applicable");
    return;
  }
  const verdict = str(result, "verdict");
  if (!["not_applicable", "followed", "findings"].includes(verdict))
    throw new InputError("Invalid principle verdict");
  if ((verdict === "not_applicable") !== (status === "not_applicable"))
    throw new InputError(
      "Applicability verdict and investigation status disagree",
    );
  if (verdict === "findings" && !result.findings.length)
    throw new InputError("findings verdict needs an MCP finding id");
  if (verdict !== "findings" && result.findings.length)
    throw new InputError("Candidate references need a findings verdict");
  if (verdict === "followed") str(result, "where");
}

/** Explicit final assessments prevent proof and anchor corrections from living only in prose. */
export function validateVerificationDecision(
  decision: Json,
  repo: string,
  target: string,
): void {
  if (decision.status !== undefined)
    throw new InputError(
      "Save evidence and assessments with CRUD, then reference their IDs",
    );
  const finding = getFindingRecord(
    { repo, target, id: str(decision, "id") },
    repo,
  );
  if (
    !Number.isInteger(decision.revision) ||
    Number(decision.revision) > finding.revision ||
    Number(decision.revision) < 1
  )
    throw new InputError("Decision needs the saved finding revision");
  if (
    !strings(decision.assessmentIds) ||
    !decision.assessmentIds.length ||
    decision.assessmentIds.some(
      (id) => !finding.assessments.some((a) => a.id === id),
    )
  )
    throw new InputError("Decision must reference saved assessments");
  if (
    decision.evidenceIds !== undefined &&
    (!strings(decision.evidenceIds) ||
      decision.evidenceIds.some(
        (id) => !finding.evidence.some((e) => e.id === id),
      ))
  )
    throw new InputError("Decision references missing evidence");
}

/** The gate checks the published finding, rather than trusting queue completion alone. */
export function verificationProblems(
  session: ReviewSession,
  repo: string,
  target: string,
): string[] {
  const problems: string[] = [];
  for (const item of session.queues
    .filter((q) => q.phase === "verification")
    .flatMap((q) => q.items)) {
    if (!item.completed) continue;
    for (const value of optionalArray(item.completed.result, "decisions")) {
      const decision = requireObject(value);
      try {
        validateVerificationDecision(decision, repo, target);
      } catch (error) {
        problems.push(
          `${item.id}/${decision.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return problems;
}

export function completeReviewWork(raw: unknown, repo: string): unknown {
  return access(raw, repo, (session, args) => {
    const queue = session.queues.find((q) => q.id === str(args, "queue"));
    const item = queue?.items.find((i) => i.id === str(args, "item"));
    if (!queue || !item) throw new InputError("Unknown queue item");
    const token = str(args, "claim"),
      worker = str(args, "worker"),
      result = requireObject(args.result);
    if (item.completed) {
      if (
        item.completed.token === token &&
        item.completed.worker === worker &&
        JSON.stringify(item.completed.result) === JSON.stringify(result)
      )
        return { state: "completed", item: item.id };
      throw new InputError("Item already completed by another submission");
    }
    if (
      item.blocked ||
      queue.phase !== session.phase ||
      item.claim?.token !== token ||
      item.claim.worker !== worker ||
      Date.parse(item.claim.until) <= Date.now()
    )
      throw new InputError(
        "Claim expired, blocked or belongs to another worker; claim again",
      );
    const at = location(args, repo);
    const findings = listFindingRecords(
      { repo: at.repo, target: at.target, run: session.run },
      at.repo,
    );
    if (item.kind !== "verification") {
      validateInvestigation(result, item.kind === "source");
      for (const id of result.findings as string[]) {
        const finding = findings.find((c) => c.id === id);
        if (
          !finding ||
          !finding.origins.some(
            (o) => o.run === session.run && o.unit === queue.id,
          ) ||
          (item.principle &&
            !finding.rules.some((r) => r.id === item.principle!.id))
        )
          throw new InputError(`${id} is not a finding for this queue item`);
      }
    } else {
      str(result, "summary");
      if (!strings(result.limits) || !strings(result.proofs))
        throw new InputError("Verification needs proofs and limits arrays");
      const decisions = optionalArray(result, "decisions").map(requireObject);
      const ids = decisions.map((d) => str(d, "id"));
      if (
        new Set(ids).size !== ids.length ||
        ids.length !== item.findings!.length ||
        item.findings!.some((id) => !ids.includes(id))
      )
        throw new InputError(
          "Decisions must cover every finding in the claimed group exactly once",
        );
      for (const decision of decisions)
        validateVerificationDecision(decision, at.repo, at.target);
    }
    item.completed = { worker, token, at: new Date().toISOString(), result };
    return { state: "completed", item: item.id };
  });
}

/** Aggregation only: partition every finding into distinct issues; do not verify or refute here. */
export function beginVerification(raw: unknown, repo: string): ReviewSession {
  return access(raw, repo, (session, args) => {
    if (
      session.queues
        .filter((q) => q.phase === "review")
        .some((q) => q.items.some((item) => !item.completed))
    )
      throw new InputError("Review queues must be complete before aggregation");
    const at = location(args, repo),
      runFindings = listFindingRecords(
        { repo: at.repo, target: at.target, run: session.run },
        at.repo,
      );
    const rawGroups = optionalArray(args, "groups").map((value) => {
      const group = requireObject(value);
      const ids = group.findings;
      if (!strings(ids) || !ids.length)
        throw new InputError("Each issue group needs finding ids");
      return { findings: ids, reason: str(group, "reason") };
    });
    const ids = rawGroups.flatMap((g) => g.findings);
    const current = new Map(runFindings.map(f=>[f.id,f]));
    const required = runFindings.filter(f=>f.closure?.reason !== "superseded");
    const groups = rawGroups.map(g=>({...g,findings:g.findings.filter(id=>current.get(id)?.closure?.reason !== "superseded")})).filter(g=>g.findings.length);
    if (
      new Set(ids).size !== ids.length ||
      ids.some(id=>!current.has(id)) ||
      required.some((c) => !ids.includes(c.id))
    )
      throw new InputError(
        "Issue groups must partition all run findings exactly once",
      );
    const old = session.queues.find((q) => q.phase === "verification");
    if (old) {
      if (
        JSON.stringify(
          old.items.map((i) => ({ findings: i.findings, reason: i.reason })),
        ) !== JSON.stringify(groups)
      )
        throw new InputError(
          "Verification queue already exists with different groups",
        );
      return session;
    }
    // Grouping is an instruction to merge duplicates, never an invisible relationship
    // between independently actionable findings. Verification owns one survivor.
    for (const group of groups) {
      const survivor = mergeFindingRecords({repo:at.repo,target:at.target,ids:group.findings},at.repo);
      group.findings = [survivor.id];
    }
    const items: QueueItem[] = groups.map((group, i) => ({id:`issue-${i+1}`,kind:"verification",...group}));
    session.phase = "verification";
    session.parallelProofs ??= hasGit(at.repo);
    session.queues.push({
      id: "verification",
      phase: "verification",
      workers: items.length
        ? session.parallelProofs
          ? Math.ceil(items.length / 10)
          : 1
        : 0,
      items,
    });
    const findings = new Map(
      listFindingRecords(
        { repo: at.repo, target: at.target, run: session.run },
        at.repo,
      ).map((f) => [f.id, f]),
    );
    const pinned = new Map(
      session.queues
        .flatMap((q) =>
          q.items.flatMap((i) => (i.principle ? [i.principle] : [])),
        )
        .map((p) => [p.id, p]),
    );
    const aggregatedAt = new Date().toISOString();
    session.suggestions = {
      aggregatedAt,
      ...(session.reportRegistry ? { registry: session.reportRegistry } : {}),
      events: groups.flatMap((group) => {
        const rules = new Set(
          group.findings
            .flatMap((id) => {
              const f = findings.get(id);
              return f
                ? [
                    ...f.rules.map((r) => r.id),
                    ...f.origins.flatMap((o) => (o.rule ? [o.rule] : [])),
                  ]
                : [];
            })
            .map((id) => id.replace(/@\d+$/, "")),
        );
        const id = hash(
          `${session.reportId ?? session.id + session.createdAt}:${[...group.findings].sort().join(":")}`,
        );
        const priorities = group.findings.flatMap((id) =>
          findings.get(id)?.priority ? [findings.get(id)!.priority] : [],
        );
        const priority =
          (["p0", "p1", "p2", "p3", "p4"] as const).find((p) =>
            priorities.includes(p),
          ) ?? "p3";
        return [...rules].flatMap((rule) => {
          const principle = pinned.get(rule);
          return principle?.hash && !rule.startsWith("local/")
            ? [
                {
                  id,
                  hash: principle.hash,
                  principle: rule,
                  day: aggregatedAt.slice(0, 10),
                  priority,
                },
              ]
            : [];
        });
      }),
    };
    return session;
  });
}

/** Delivery bookkeeping is independent of findings, evidence and human triage. */
export function noteSuggestionDelivery(
  raw: unknown,
  repo: string,
  result: { registry: string; sentAt?: string; lastError?: string },
): void {
  access(raw, repo, (session) => {
    if (!session.suggestions) return;
    if (
      session.suggestions.registry &&
      session.suggestions.registry !== result.registry
    )
      throw new InputError("Review report belongs to a different registry");
    if (session.suggestions.sentAt && result.lastError) return;
    Object.assign(session.suggestions, result);
    if (result.sentAt) delete session.suggestions.lastError;
  });
}

/** Retry proof only, preserving grouping, prior attempts, linked finding IDs and human triage. */
export function retryVerification(raw: unknown, repo: string): ReviewSession {
  return access(raw, repo, (session, args) => {
    const reason = str(args, "reason"),
      ids = args.items;
    if (!strings(ids) || !ids.length || new Set(ids).size !== ids.length)
      throw new InputError("Supply distinct verification issue ids");
    const queue = session.queues.find((q) => q.phase === "verification");
    if (!queue || session.phase !== "verification")
      throw new InputError("No verification queue");
    const chosen = ids.map((id) => queue.items.find((item) => item.id === id));
    if (chosen.some((item) => !item?.completed))
      throw new InputError("Only completed verification issues can be retried");
    for (const item of chosen as QueueItem[]) {
      item.previous = [
        ...(item.previous ?? []),
        {
          reason,
          completed: item.completed!,
          ...(item.claim ? { claim: item.claim } : {}),
        },
      ];
      delete item.completed;
      delete item.claim;
    }
    const remaining = queue.items.filter(
      (item) => !item.completed && !item.blocked,
    ).length;
    session.parallelProofs ??= hasGit(location(args, repo).repo);
    queue.workers = remaining
      ? session.parallelProofs
        ? Math.ceil(remaining / 10)
        : 1
      : 0;
    return session;
  });
}

export function blockReviewWork(raw: unknown, repo: string): ReviewSession {
  return access(raw, repo, (session, args) => {
    const queue = session.queues.find((q) => q.id === str(args, "queue")),
      worker = str(args, "worker"),
      reason = str(args, "reason");
    const item = queue?.items.find(
      (i) => !i.completed && i.claim?.worker === worker,
    );
    if (!item) throw new InputError("Worker has no active queue item to block");
    item.blocked = { reason, at: new Date().toISOString(), worker };
    if (item.kind === "verification") {
      const at = location(args, repo);
      try {
        for (const id of item.findings ?? []) {
          const finding = getFindingRecord({ ...at, id }, at.repo);
          updateFindingRecord(
            {
              ...at,
              id,
              expectedRevision: finding.revision,
              patch: {
                assessments: [
                  ...finding.assessments,
                  {
                    id: `blocked-${item.id}-${finding.revision}`,
                    author: worker,
                    authorType: "agent",
                    conclusion: "Investigation blocked",
                    reason,
                  },
                ],
              },
            },
            at.repo,
          );
        }
      } catch (error) {
        item.blocked.visibilityErrors = [
          error instanceof Error ? error.message : String(error),
        ];
      }
    }
    return session;
  });
}
