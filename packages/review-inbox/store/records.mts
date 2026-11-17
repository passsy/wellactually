import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  FindingRecord,
  OccurrenceRecord,
  RecordBase,
  OccurrenceLocation,
} from "../model/records.mts";
import type { Finding } from "../model/types.mts";
import { locked } from "./lock.mts";
import type { TargetPaths } from "./paths.mts";
import { InputError } from "../validate.mts";

export function validId(id: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(id))
    throw new InputError("Invalid record id");
  return id;
}
export const recordId = (prefix: string): string =>
  prefix + randomUUID().replaceAll("-", "");
export function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n");
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error: any) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
const files = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((n) => n.endsWith(".json"))
    : [];
export const findingFile = (p: TargetPaths, id: string): string =>
  path.join(p.findings, validId(id) + ".json");
export const occurrenceFile = (p: TargetPaths, id: string): string =>
  path.join(p.occurrences, validId(id) + ".json");
function findingRecord(file: string): FindingRecord | null {
  const record = readJson<FindingRecord>(file);
  if (
    record &&
    (record.schemaVersion !== 2 ||
      !["undecided", "accepted", "invalid", "tolerated"].includes(
        record.verdict,
      ))
  )
    throw new InputError(
      `Unsupported finding format in ${file}. The MCP server and review helper must use the same plugin version. Restart the host session after updating the plugin. Preserve this review for explicit recovery; do not delete it or rerun the review to hide the mismatch.`,
    );
  return record;
}
export const readRecord = (p: TargetPaths, id: string): FindingRecord | null =>
  findingRecord(findingFile(p, id));
export const readOccurrence = (
  p: TargetPaths,
  id: string,
): OccurrenceRecord | null => readJson(occurrenceFile(p, id));
export const findingRecords = (p: TargetPaths): FindingRecord[] =>
  files(p.findings)
    .map((n) => findingRecord(path.join(p.findings, n))!)
    .filter((record) => record !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
export const occurrenceRecords = (p: TargetPaths): OccurrenceRecord[] =>
  files(p.occurrences)
    .map((n) => readJson<OccurrenceRecord>(path.join(p.occurrences, n))!)
    .filter((record) => record !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
/** Allocate under withRecords' review-wide lock; counters survive record deletion. */
export function nextRecordId(p: TargetPaths, prefix: string): string {
  if (!/^[A-Za-z]$/.test(prefix)) throw new InputError("prefix must be one letter (A-Z or a-z)");
  const file = path.join(p.dir, ".records", "id-counters.json");
  const counters = readJson<Record<string, number>>(file) ?? {};
  let highest = counters[prefix] ?? 0;
  if (!Number.isSafeInteger(highest) || highest < 0) throw new InputError("Invalid ID counter");
  for (const dir of [p.findings, p.occurrences]) {
    for (const name of files(dir)) {
      const match = /^([A-Za-z])([1-9][0-9]*)\.json$/.exec(name);
      if (match?.[1] === prefix) {
        const number = Number(match[2]);
        if (Number.isSafeInteger(number)) highest = Math.max(highest, number);
      }
    }
  }
  if (!Number.isSafeInteger(highest + 1)) throw new InputError("ID counter exhausted");
  counters[prefix] = highest + 1;
  atomicJson(file, counters);
  return `${prefix}${highest + 1}`;
}

export function baseRecord(
  id: string,
  at = new Date().toISOString(),
): RecordBase {
  return {
    schemaVersion: 2,
    id,
    revision: 1,
    state: "open",
    evidence: [],
    assessments: [],
    links: [],
    createdAt: at,
    updatedAt: at,
    history: [],
  };
}

/** Capture a source-panel draft as canonical finding and occurrence records. */
export function recordFromView(old: Finding): {
  finding: FindingRecord;
  occurrence: OccurrenceRecord;
} {
  const finding: FindingRecord = {
    ...baseRecord(old.id, old.createdAt),
    title: old.title,
    description: old.body,
    priority: old.priority,
    rules: old.rule ? [{ id: old.rule }] : [],
    tags: old.tags ?? [],
    origins: [],
    verdict: old.verdict,
    ...(old.reportedAt ? { reportedAt: old.reportedAt } : {}),
    metadata: {
      evidence: old.evidence,
      fingerprint: old.fingerprint,
      reporter: old.reporter,
      reporterName: old.reporterName,
    },
  };
  if (old.note !== undefined) finding.note = old.note;
  if (old.verdict === "invalid" || old.verdict === "tolerated") {
    finding.state = "closed";
    finding.closure = {
      reason: "rejected",
      explanation: `Imported human verdict: ${old.verdict}`,
    };
  } else if (old.resolution === "resolved") {
    finding.state = "closed";
    finding.closure = {
      reason: "resolved",
      explanation: "Imported resolution",
    };
  }
  finding.evidence.push({
    id: "initial-evidence",
    kind: old.evidence === "Proven" && old.provenTest ? "test" : "reasoning",
    polarity: "supports",
    description: old.body,
    artifacts: old.provenTest ? [old.provenTest] : [],
  });
  for (const [kind, value] of Object.entries(old.links ?? {}))
    if (value)
      finding.links.push({
        id: `initial-${kind}`,
        kind:
          kind === "fixCommit"
            ? "commit"
            : kind === "prComment"
              ? "comment"
              : "rule-issue",
        ...(kind === "fixCommit" ? { commit: value } : { url: value }),
      });
  const locations: OccurrenceLocation[] = old.anchor
    ? [
        {
          ...old.anchor,
          context: old.context,
          diff: old.diff,
          authorship: old.authorship,
        },
        ...(old.related ?? []).map((r) => ({
          ...r,
          commit: old.anchor.commit,
        })),
      ]
    : [];
  const occurrence: OccurrenceRecord = {
    ...baseRecord(`${old.id}-1`, old.createdAt),
    findingId: old.id,
    locations,
  };
  if (old.resolution === "resolved") {
    occurrence.state = "closed";
    occurrence.closure = {
      reason: "resolved",
      explanation: "Imported resolution",
    };
  }
  finding.history = [
    {
      at: finding.createdAt,
      actor: "agent",
      revision: 1,
      patch: {
        title: finding.title,
        description: finding.description,
        verdict: finding.verdict,
        reportedAt: finding.reportedAt ?? null,
        state: finding.state,
        closure: finding.closure ?? null,
      },
    },
  ];
  return { finding, occurrence };
}
export function withRecords<T>(p: TargetPaths, action: () => T): T {
  return locked(path.join(p.dir, ".records"), action);
}
