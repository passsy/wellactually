/** Presentation view for the inbox, card and source panels. Records remain the source of truth. */
import type { Finding } from "../model/types.mts";
import type { FindingRecord, OccurrenceRecord } from "../model/records.mts";
import type { TargetPaths } from "./paths.mts";
import {
  atomicJson,
  findingFile,
  occurrenceFile,
  readRecord,
  occurrenceRecords,
  recordFromView,
  baseRecord,
} from "./records.mts";
import { InputError } from "../validate.mts";
import { createHash } from "node:crypto";

export function view(
  record: FindingRecord,
  occurrences: OccurrenceRecord[],
): Finding {
  const owned = occurrences.filter((o) => o.findingId === record.id),
    locations = owned.flatMap((o) => o.locations),
    first = locations[0];
  const proof = record.evidence.findLast(
    (e) =>
      e.kind === "test" && e.polarity === "supports" && e.artifacts.length > 0,
  );
  return {
    id: record.id,
    title: record.title,
    body: record.description,
    priority: record.priority,
    rule: record.rules[0]?.id,
    tags: record.tags,
    evidence:
      (record.metadata.evidence as Finding["evidence"]) ??
      (proof ? "Proven" : "Reasoned"),
    provenTest: proof?.artifacts[0],
    anchor: first
      ? { ...first }
      : { file: "(no source location)", line: 1, commit: "unknown" },
    snippet:
      first?.context?.lines[first.line - first.context.start] ??
      first?.text?.split("\n")[first.line - 1] ??
      "",
    context: first?.context,
    diff: first?.diff,
    authorship: first?.authorship,
    related: locations.slice(1),
    fingerprint:
      typeof record.metadata.fingerprint === "string"
        ? record.metadata.fingerprint
        : createHash("sha256").update(record.id).digest("hex"),
    verdict: record.verdict,
    resolution:
      record.state === "closed" && record.closure?.reason === "resolved"
        ? "resolved"
        : "unresolved",
    history: record.history.flatMap((change) => {
      const patch = change.patch;
      const verdict = patch.verdict as Finding["verdict"] | undefined;
      const resolution =
        patch.state === "closed" &&
        (patch.closure as { reason?: string } | undefined)?.reason ===
          "resolved"
          ? ("resolved" as const)
          : patch.state === "open"
            ? ("unresolved" as const)
            : undefined;
      return verdict || resolution
        ? [
            {
              at: change.at,
              actor: change.actor as Finding["history"][number]["actor"],
              ...(verdict ? { verdict } : {}),
              ...(resolution ? { resolution } : {}),
            },
          ]
        : [];
    }),
    links: {
      fixCommit: record.links.findLast((l) => l.commit)?.commit,
      prComment: record.links.findLast((l) => l.kind === "comment")?.url,
      ruleIssue: record.links.findLast((l) => l.kind === "rule-issue")?.url,
    },
    note: record.note,
    reportedAt: record.reportedAt,
    reporter: record.metadata.reporter as Finding["reporter"],
    reporterName: record.metadata.reporterName as string | undefined,
    createdAt: record.createdAt,
    lastSeen: record.metadata.lastSeen as string | undefined,
    confirmedAt: record.metadata.confirmedAt as string | undefined,
    staleAnchor: record.metadata.staleAnchor as boolean | undefined,
    noteAt: record.metadata.noteAt as string | undefined,
    record,
    occurrenceSummary: {
      revisionKey: createHash("sha256")
        .update(
          owned
            .map((o) => `${o.id}:${o.revision}`)
            .sort()
            .join("|"),
        )
        .digest("hex"),
      updatedAt: owned
        .map((o) => o.updatedAt)
        .sort()
        .at(-1),
      total: owned.length,
      open: owned.filter((o) => o.state === "open").length,
      closed: owned.filter((o) => o.state === "closed").length,
      resolved: owned.filter((o) => o.closure?.reason === "resolved").length,
    },
  };
}
export function saveView(p: TargetPaths, finding: Finding): void {
  const old = readRecord(p, finding.id);
  if (!old) {
    const imported = recordFromView(finding);
    atomicJson(occurrenceFile(p, imported.occurrence.id), imported.occurrence);
    atomicJson(findingFile(p, finding.id), imported.finding);
    return;
  }
  if (finding.record && finding.record.revision !== old.revision)
    throw new InputError(
      "Revision conflict: reload the finding before editing",
    );
  const occurrences = occurrenceRecords(p),
    before = view(old, occurrences),
    updated = structuredClone(old);
  updated.title = finding.title;
  updated.description = finding.body;
  updated.tags = finding.tags ?? [];
  updated.priority = finding.priority;
  if (before.rule !== finding.rule)
    updated.rules = finding.rule
      ? [
          { id: finding.rule },
          ...old.rules.filter(
            (r) => r.id !== before.rule && r.id !== finding.rule,
          ),
        ]
      : old.rules.filter((r) => r.id !== before.rule);
  updated.note = finding.note;
  updated.verdict = finding.verdict;
  if (finding.reportedAt) updated.reportedAt = finding.reportedAt;
  else delete updated.reportedAt;
  if (
    finding.resolution !== before.resolution ||
    finding.verdict !== before.verdict
  ) {
    if (finding.resolution === "resolved") {
      updated.state = "closed";
      updated.closure = {
        reason: "resolved",
        explanation: finding.history.at(-1)?.note ?? "Marked resolved",
      };
    } else if (
      finding.verdict === "invalid" ||
      finding.verdict === "tolerated"
    ) {
      updated.state = "closed";
      updated.closure = {
        reason: "rejected",
        explanation: finding.history.at(-1)?.note ?? "Rejected in review UI",
      };
    } else {
      updated.state = "open";
      delete updated.closure;
    }
  }
  for (const [kind, value] of Object.entries(finding.links))
    if (value && value !== before.links[kind as keyof Finding["links"]])
      updated.links.push({
        id: `initial-${kind}-${old.revision + 1}`,
        kind:
          kind === "fixCommit"
            ? "commit"
            : kind === "prComment"
              ? "comment"
              : "rule-issue",
        ...(kind === "fixCommit" ? { commit: value } : { url: value }),
      });
  if (
    finding.evidence !== before.evidence ||
    finding.provenTest !== before.provenTest
  )
    updated.evidence.push({
      id: `initial-evidence-${old.revision + 1}`,
      kind:
        finding.evidence === "Proven" && finding.provenTest
          ? "test"
          : "reasoning",
      polarity: "supports",
      description: finding.body,
      artifacts: finding.provenTest ? [finding.provenTest] : [],
    });
  const locations = [
    {
      ...finding.anchor,
      context: finding.context,
      diff: finding.diff,
      authorship: finding.authorship,
    },
    ...(finding.related ?? []).map((l) => ({
      ...l,
      commit: finding.anchor.commit,
    })),
  ];
  if (
    JSON.stringify(finding.anchor) !== JSON.stringify(before.anchor) ||
    JSON.stringify(finding.related) !== JSON.stringify(before.related)
  ) {
    // Source-panel edits address one compound occurrence. Do not overwrite independent occurrences.
    if (occurrences.filter((o) => o.findingId === finding.id).length > 1)
      throw new InputError(
        "Edit multiple occurrences with occurrence CRUD, not presentation anchor fields",
      );
    const primary = occurrences.find((o) => o.findingId === finding.id);
    const changed = {
      ...(primary ?? baseRecord(`${finding.id}-1`)),
      findingId: finding.id,
      locations,
    } as OccurrenceRecord;
    changed.revision += 1;
    changed.updatedAt = new Date().toISOString();
    atomicJson(occurrenceFile(p, changed.id), changed);
  }
  Object.assign(updated.metadata, {
    evidence: finding.evidence,
    fingerprint: finding.fingerprint,
    reporter: finding.reporter,
    reporterName: finding.reporterName,
    lastSeen: finding.lastSeen,
    confirmedAt: finding.confirmedAt,
    staleAnchor: finding.staleAnchor,
    noteAt: finding.noteAt,
  });
  updated.revision += 1;
  updated.updatedAt = new Date().toISOString();
  updated.history.push({
    at: updated.updatedAt,
    actor:
      finding.history.length > before.history.length
        ? finding.history.at(-1)!.actor
        : "human",
    revision: updated.revision,
    patch: Object.fromEntries(
      Object.keys(updated)
        .filter(
          (key) =>
            !["history", "revision", "updatedAt"].includes(key) &&
            JSON.stringify((old as any)[key]) !==
              JSON.stringify((updated as any)[key]),
        )
        .map((key) => [key, (updated as any)[key] ?? null]),
    ),
  });
  // The UI's whole-finding Fixed action resolves all remaining applicable scope.
  // Independent occurrence CRUD still supports partial resolution.
  const resolvedOccurrences = finding.resolution === "resolved" && before.resolution !== "resolved"
    ? occurrences.filter(o => o.findingId === finding.id && o.state === "open") : [];
  const saved: OccurrenceRecord[] = [];
  try {
    for (const occurrence of resolvedOccurrences) {
      const changed = structuredClone(occurrence);
      changed.state = "closed";
      changed.closure = { reason: "resolved", explanation: "Finding marked fixed" };
      changed.revision += 1;
      changed.updatedAt = updated.updatedAt;
      changed.history.push({ at: changed.updatedAt, actor: updated.history.at(-1)!.actor,
        revision: changed.revision, patch: { state: changed.state, closure: changed.closure } });
      saved.push(occurrence);
      atomicJson(occurrenceFile(p, changed.id), changed);
    }
    atomicJson(findingFile(p, updated.id), updated);
  } catch (error) {
    for (const occurrence of saved) atomicJson(occurrenceFile(p, occurrence.id), occurrence);
    throw error;
  }
}
