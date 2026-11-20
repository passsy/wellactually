/** CRUD shared by MCP and HTTP. No review sequence or actor-specific transition graph. */
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  FindingRecord,
  OccurrenceRecord,
  Closure,
  RuleLink,
  RecordLink,
  EvidenceEntry,
  Assessment,
  OccurrenceLocation,
  RecordBase,
  OccurrenceSummary,
} from "./model/records.mts";
import { PRIORITY } from "./model/types.mts";
import { targetPaths, repoRelative, headCommit } from "./store/paths.mts";
import type { TargetPaths } from "./store/paths.mts";
import {
  atomicJson,
  withRecords,
  readRecord,
  readOccurrence,
  findingRecords,
  occurrenceRecords,
  findingFile,
  occurrenceFile,
  baseRecord,
  recordId,
  nextRecordId,
  validId,
} from "./store/records.mts";
import { upsertRegistry } from "./store/registry.mts";
import { captureAt } from "./model/context.mts";
import { InputError, requireObject, str } from "./validate.mts";

type Json = Record<string, unknown>;
const now = (): string => new Date().toISOString();
function paths(args: Json, repo: string): TargetPaths {
  const root = args.repo === undefined ? repo : str(args, "repo");
  if (!root || !path.isAbsolute(root))
    throw new InputError("repo must be an absolute repository path");
  return targetPaths(root, str(args, "target"));
}
const enumValue = <T extends string>(
  value: unknown,
  values: readonly T[],
  name: string,
): T => {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new InputError(`${name} must be one of ${values.join(", ")}`);
  return value as T;
};
const strings = (raw: unknown, name: string): string[] => {
  if (
    !Array.isArray(raw) ||
    raw.some((v) => typeof v !== "string" || !v.trim())
  )
    throw new InputError(`${name} must be an array of nonempty strings`);
  return raw;
};
function array<T>(value: unknown, convert: (item: Json) => T): T[] {
  if (!Array.isArray(value)) throw new InputError("Expected an array");
  const result = value.map((v) => convert(requireObject(v)));
  const ids = result.map((v) => (v as { id?: string }).id).filter(Boolean);
  if (new Set(ids).size !== ids.length)
    throw new InputError("Entry IDs must be unique within an array");
  return result;
}
function optionalText(args: Json, key: string): string | undefined {
  if (args[key] === undefined) return undefined;
  if (typeof args[key] !== "string")
    throw new InputError(`${key} must be a string`);
  return args[key] as string;
}
function identified(args: Json, prefix: string): string {
  return args.id === undefined ? recordId(prefix) : validId(str(args, "id"));
}
function links(value: unknown): RecordLink[] {
  return array(value, (entry) => {
    const result: RecordLink = {
      id: identified(entry, "L"),
      kind: str(entry, "kind"),
    };
    for (const key of ["url", "commit", "description"] as const)
      if (entry[key] !== undefined) result[key] = str(entry, key);
    if (!result.url && !result.commit)
      throw new InputError("A link needs url or commit");
    if (result.url && !/^(https?:\/\/|file:|\/)/.test(result.url))
      throw new InputError(
        "Link URLs must be http(s), file URLs or absolute paths",
      );
    return result;
  });
}
function rules(value: unknown): RuleLink[] {
  if (!Array.isArray(value)) throw new InputError("rules must be an array");
  return array(
    value.map((v) => (typeof v === "string" ? { id: v } : v)),
    (entry) => ({
      id: str(entry, "id"),
      ...(entry.url === undefined ? {} : { url: str(entry, "url") }),
      ...(entry.note === undefined ? {} : { note: str(entry, "note") }),
    }),
  );
}
function evidence(value: unknown): EvidenceEntry[] {
  return array(value, (entry) => ({
    id: identified(entry, "E"),
    kind: enumValue(
      entry.kind,
      ["source", "reasoning", "test"],
      "evidence.kind",
    ),
    polarity: enumValue(
      entry.polarity,
      ["supports", "contradicts"],
      "evidence.polarity",
    ),
    description: str(entry, "description"),
    artifacts: strings(entry.artifacts ?? [], "artifacts"),
    ...(entry.occurrenceIds === undefined
      ? {}
      : {
          occurrenceIds: strings(entry.occurrenceIds, "occurrenceIds").map(
            validId,
          ),
        }),
  }));
}
function assessments(value: unknown): Assessment[] {
  return array(value, (entry) => {
    const at = entry.at === undefined ? now() : str(entry, "at");
    if (!Number.isFinite(Date.parse(at)))
      throw new InputError("Assessment at must be a timestamp");
    return {
      id: identified(entry, "A"),
      author: str(entry, "author"),
      authorType: enumValue(entry.authorType, ["human", "agent"], "authorType"),
      conclusion: str(entry, "conclusion"),
      reason: str(entry, "reason"),
      at,
    };
  });
}
function closure(value: unknown): Closure {
  const entry = requireObject(value);
  return {
    reason: enumValue(
      entry.reason,
      ["resolved", "rejected", "disproven", "superseded"],
      "closure.reason",
    ),
    explanation: str(entry, "explanation"),
    ...(entry.supersededBy === undefined
      ? {}
      : {
          supersededBy: strings(entry.supersededBy, "supersededBy").map(
            validId,
          ),
        }),
  };
}
function checkState(record: RecordBase, p: TargetPaths): void {
  if (record.state === "open" && record.closure)
    throw new InputError(
      "An open record cannot have a closure; clear it with null when reopening",
    );
  if (record.state === "closed" && !record.closure)
    throw new InputError(
      "A closed record needs a closure reason and explanation",
    );
  if (
    record.closure?.reason === "superseded" &&
    !record.closure.supersededBy?.length
  )
    throw new InputError(
      "A superseded record needs supersededBy finding references",
    );
  for (const id of record.closure?.supersededBy ?? []) {
    if (id === record.id || !readRecord(p, id))
      throw new InputError(`Invalid superseding finding ${id}`);
  }
  for (const item of record.evidence)
    for (const id of item.occurrenceIds ?? []) {
      const occurrence = readOccurrence(p, id);
      const owner =
        "findingId" in record
          ? (record as OccurrenceRecord).findingId
          : record.id;
      if (!occurrence || occurrence.findingId !== owner)
        throw new InputError(
          `Evidence refers to an occurrence outside this finding: ${id}`,
        );
    }
}
function location(value: Json, p: TargetPaths): OccurrenceLocation {
  const file = str(value, "file"),
    line = value.line,
    endLine = value.endLine;
  if (
    !Number.isInteger(line) ||
    Number(line) < 1 ||
    (endLine !== undefined &&
      (!Number.isInteger(endLine) || Number(endLine) < Number(line)))
  )
    throw new InputError(
      "Location needs a positive line and an endLine at or after line",
    );
  const metadata = value.kind === "metadata";
  const normalized = metadata ? file : repoRelative(p.repo, file);
  if (
    !metadata &&
    (path.isAbsolute(normalized) || normalized.split(/[\\/]/).includes(".."))
  )
    throw new InputError("Source locations must be inside the repository");
  const commit =
    value.commit === undefined ? headCommit(p.repo) : str(value, "commit");
  const span = {
    line: Number(line),
    ...(endLine === undefined ? {} : { endLine: Number(endLine) }),
  };
  const result: OccurrenceLocation = {
    file: normalized,
    ...span,
    commit,
    ...(value.note === undefined ? {} : { note: str(value, "note") }),
  };
  if (metadata) {
    result.kind = "metadata";
    result.subject = enumValue(
      value.subject,
      ["pr-title", "pr-body", "commit-message"] as const,
      "subject",
    );
    result.text = str(value, "text");
    if (
      !/^https?:\/\//.test(file) ||
      span.line > result.text.split("\n").length ||
      (span.endLine ?? span.line) > result.text.split("\n").length
    )
      throw new InputError(
        "Metadata range is outside its text or has no authoritative URL",
      );
    result.context = { start: 1, lines: result.text.split("\n") };
  } else {
    // Context is optional; unavailable source must not block recording a finding.
    const meta = JSON.parse(
      fs.existsSync(p.meta) ? fs.readFileSync(p.meta, "utf8") : "{}",
    );
    Object.assign(result, captureAt(p.repo, normalized, span, meta.base));
  }
  return result;
}
const shared = ["state", "closure", "evidence", "assessments", "links"];
const findingFields = [
  ...shared,
  "title",
  "verdict",
  "reportedAt",
  "description",
  "rules",
  "priority",
  "tags",
  "note",
  "origins",
  "metadata",
];
const occurrenceFields = [...shared, "findingId", "description", "locations"];
function apply<T extends FindingRecord | OccurrenceRecord>(
  record: T,
  patch: Json,
  p: TargetPaths,
): T {
  const isFinding = "title" in record;
  for (const key of Object.keys(patch))
    if (!(isFinding ? findingFields : occurrenceFields).includes(key))
      throw new InputError(`Field ${key} is not editable`);
  const result = structuredClone(record);
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case "state":
        result.state = enumValue(value, ["open", "closed"], "state");
        break;
      case "closure":
        if (value === null) delete result.closure;
        else result.closure = closure(value);
        break;
      case "evidence":
        result.evidence = evidence(value);
        break;
      case "assessments":
        result.assessments = assessments(value);
        break;
      case "links":
        result.links = links(value);
        break;
      case "verdict":
        (result as FindingRecord).verdict = enumValue(
          value,
          ["undecided", "accepted", "invalid", "tolerated"],
          "verdict",
        );
        break;
      case "reportedAt":
        if (value === null) delete (result as FindingRecord).reportedAt;
        else {
          const at = str(patch, key);
          if (!/^\d{4}-\d\d-\d\dT/.test(at) || !Number.isFinite(Date.parse(at)))
            throw new InputError("reportedAt must be an ISO timestamp or null");
          (result as FindingRecord).reportedAt = at;
        }
        break;
      case "title":
        (result as FindingRecord).title = str(patch, key);
        break;
      case "description": {
        if (value === null && !isFinding)
          delete (result as OccurrenceRecord).description;
        else (result as FindingRecord).description = optionalText(patch, key)!;
        break;
      }
      case "rules":
        (result as FindingRecord).rules = rules(value);
        break;
      case "priority":
        (result as FindingRecord).priority = enumValue(value, PRIORITY, key);
        break;
      case "tags":
        (result as FindingRecord).tags = strings(value, key);
        break;
      case "note":
        if (value === null) delete (result as FindingRecord).note;
        else (result as FindingRecord).note = optionalText(patch, key)!;
        break;
      case "origins":
        (result as FindingRecord).origins = array(value, (entry) => ({
          run: str(entry, "run"),
          source: str(entry, "source"),
          unit: str(entry, "unit"),
          ...(entry.rule === undefined ? {} : { rule: str(entry, "rule") }),
          ...(entry.quote === undefined ? {} : { quote: str(entry, "quote") }),
        }));
        break;
      case "metadata":
        (result as FindingRecord).metadata = requireObject(value);
        break;
      case "findingId":
        (result as OccurrenceRecord).findingId = validId(str(patch, key));
        break;
      case "locations":
        (result as OccurrenceRecord).locations = array(value, (entry) => {
          const previous = (record as OccurrenceRecord).locations.find(
            (l) =>
              l.file === entry.file &&
              l.line === entry.line &&
              l.endLine === entry.endLine &&
              l.commit === entry.commit &&
              l.kind === entry.kind &&
              l.text === entry.text &&
              l.subject === entry.subject,
          );
          // An unchanged coordinate retains what the reviewer actually saw.
          return previous
            ? {
                ...previous,
                ...(entry.note === undefined
                  ? {}
                  : { note: str(entry, "note") }),
              }
            : location(entry, p);
        });
        break;
    }
  }
  if (!isFinding && !readRecord(p, (result as OccurrenceRecord).findingId))
    throw new InputError("The occurrence's finding does not exist");
  checkState(result, p);
  return result;
}
function savedPatch(record: RecordBase, patch: Json): Json {
  return Object.fromEntries(
    Object.keys(patch).map((key) => [
      key,
      (record as unknown as Json)[key] ?? null,
    ]),
  );
}
function mutation<T extends RecordBase>(record: T, patch: Json, args: Json): T {
  if (
    !Number.isInteger(args.expectedRevision) ||
    args.expectedRevision !== record.revision
  )
    throw new InputError(
      `Revision conflict: expectedRevision must match current revision ${record.revision}`,
    );
  const revision = record.revision + 1,
    at = now(),
    actor = args.actor === undefined ? "agent" : str(args, "actor");
  return {
    ...record,
    revision,
    updatedAt: at,
    history: [...record.history, { at, actor, revision, patch }],
  };
}
function publish(p: TargetPaths): void {
  upsertRegistry(p.repo, p.target, now());
}
const mustFinding = (p: TargetPaths, id: string): FindingRecord => {
  const record = readRecord(p, validId(id));
  if (!record) throw new InputError(`No finding ${id}`);
  return record;
};
const mustOccurrence = (p: TargetPaths, id: string): OccurrenceRecord => {
  const record = readOccurrence(p, validId(id));
  if (!record) throw new InputError(`No occurrence ${id}`);
  return record;
};

export function createFindingRecord(raw: unknown, repo: string): FindingRecord {
  const args = requireObject(raw),
    p = paths(args, repo);
  return withRecords(p, () => {
    const key =
      args.idempotencyKey === undefined
        ? undefined
        : str(args, "idempotencyKey");
    if (key) {
      const prior = findingRecords(p).find((f) => f.creationKey === key);
      if (prior) return prior;
    }
    const data = requireObject(args.finding);
    const record = apply<FindingRecord>(
      {
        ...baseRecord("pending"),
        verdict: "undecided",
        title: "",
        description: "",
        rules: [],
        priority: "p2",
        tags: [],
        origins: [],
        metadata: {},
      },
      data,
      p,
    );
    if (!record.title) throw new InputError("title is required");
    const id = nextRecordId(p, args.prefix === undefined ? "G" : str(args, "prefix"));
    record.id = id;
    if (key) record.creationKey = key;
    record.history = [
      {
        at: record.createdAt,
        actor: args.actor === undefined ? "agent" : str(args, "actor"),
        revision: 1,
        patch: savedPatch(record, data),
      },
    ];
    atomicJson(findingFile(p, id), record);
    publish(p);
    return record;
  });
}
/** Flatten an explicitly aggregated duplicate set. Superseded records are audit history only. */
export function mergeFindingRecords(raw: unknown, repo: string): FindingRecord {
  const args = requireObject(raw), p = paths(args, repo);
  const ids = strings(args.ids, "ids");
  if (!ids.length || new Set(ids).size !== ids.length) throw new InputError("Supply distinct finding ids");
  return withRecords(p, () => {
    const records = ids.map(id => mustFinding(p, id));
    const into = records[0]!;
    if (records.length === 1) return into;
    const others = records.slice(1);
    if (others.every(f => f.closure?.reason === "superseded" && f.closure.supersededBy?.includes(into.id))) return into;
    if (records.some(f => f.state !== "open" || f.verdict !== into.verdict) || new Set(records.flatMap(f => f.note ? [f.note] : [])).size > 1)
      throw new InputError("Resolve differing dispositions or notes explicitly before merging findings");
    const union = <T,>(values: T[]): T[] => [...new Map(values.map(v => [JSON.stringify(v), v])).values()];
    const entries = <T extends {id:string}>(values:T[]):T[] => {
      const result:T[]=[];
      for(const entry of union(values)) result.push(result.some(e=>e.id===entry.id) ? {...entry,id:recordId("M")} : entry);
      return result;
    };
    const mergedRules = new Map<string, RuleLink>();
    for (const rule of records.flatMap(f => f.rules)) {
      const prior = mergedRules.get(rule.id);
      const notes = union([prior?.note, rule.note].filter((v): v is string => !!v));
      mergedRules.set(rule.id, {...rule, ...prior, ...(notes.length ? {note:notes.join("\n\n")} : {})});
    }
    const patch = {
      rules: [...mergedRules.values()], origins: union(records.flatMap(f=>f.origins)),
      evidence: entries(records.flatMap(f=>f.evidence)), assessments: entries(records.flatMap(f=>f.assessments)),
      links: entries(records.flatMap(f=>f.links)), tags: union(records.flatMap(f=>f.tags)),
      priority: PRIORITY.find(level=>records.some(f=>f.priority===level))!,
      ...(records.some(f=>f.note) ? {note:records.find(f=>f.note)!.note} : {}),
      ...(records.some(f=>f.reportedAt) ? {reportedAt:records.flatMap(f=>f.reportedAt?[f.reportedAt]:[]).sort()[0]} : {}),
    };
    const merged = {...mutation(into, patch, {...args,expectedRevision:into.revision}), ...patch};
    const changes: {file:string; before:FindingRecord|OccurrenceRecord; after:FindingRecord|OccurrenceRecord}[] = [];
    for(const occurrence of occurrenceRecords(p).filter(o=>ids.slice(1).includes(o.findingId))) {
      const patch={findingId:into.id};
      changes.push({file:occurrenceFile(p,occurrence.id),before:occurrence,after:{...mutation(occurrence,patch,{...args,expectedRevision:occurrence.revision}),...patch}});
    }
    for(const old of others) {
      // Scoped evidence moves with its occurrence; the original remains in this record's history.
      const patch={state:"closed" as const,closure:{reason:"superseded" as const,explanation:`Merged into ${into.id}`,supersededBy:[into.id]},evidence:[]};
      changes.push({file:findingFile(p,old.id),before:old,after:{...mutation(old,patch,{...args,expectedRevision:old.revision}),...patch}});
    }
    changes.push({file:findingFile(p,into.id),before:into,after:merged});
    const saved:typeof changes=[];
    try {
      for(const change of changes){saved.push(change);atomicJson(change.file,change.after);}
    } catch(error) {
      for(const change of saved.reverse())atomicJson(change.file,change.before);
      throw error;
    }
    publish(p);
    return merged;
  });
}

export function getFindingRecord(raw: unknown, repo: string): FindingRecord {
  const args = requireObject(raw),
    p = paths(args, repo);
  return withRecords(p, () => mustFinding(p, str(args, "id")));
}
export function listFindingRecords(
  raw: unknown,
  repo: string,
): FindingRecord[] {
  const args = requireObject(raw),
    p = paths(args, repo);
  return withRecords(p, () =>
    findingRecords(p).filter(
      (f) =>
        (args.state === undefined ||
          f.state === enumValue(args.state, ["open", "closed"], "state")) &&
        (args.verdict === undefined ||
          f.verdict ===
            enumValue(
              args.verdict,
              ["undecided", "accepted", "invalid", "tolerated"],
              "verdict",
            )) &&
        (args.reason === undefined || f.closure?.reason === args.reason) &&
        (args.rule === undefined || f.rules.some((r) => r.id === args.rule)) &&
        (args.run === undefined || f.origins.some((o) => o.run === args.run)) &&
        (args.unit === undefined ||
          f.origins.some((o) => o.unit === args.unit)),
    ),
  );
}
export function updateFindingRecord(raw: unknown, repo: string): FindingRecord {
  const args = requireObject(raw),
    p = paths(args, repo);
  return withRecords(p, () => {
    const old = mustFinding(p, str(args, "id")),
      patch = requireObject(args.patch);
    const result = apply(mutation(old, patch, args), patch, p);
    result.history[result.history.length - 1]!.patch = savedPatch(
      result,
      patch,
    );
    atomicJson(findingFile(p, result.id), result);
    publish(p);
    return result;
  });
}
export function deleteFindingRecord(
  raw: unknown,
  repo: string,
): { deleted: string } {
  const args = requireObject(raw),
    p = paths(args, repo);
  return withRecords(p, () => {
    const old = mustFinding(p, str(args, "id"));
    mutation(old, {}, args);
    if (occurrenceRecords(p).some((o) => o.findingId === old.id))
      throw new InputError(
        "Delete or reassign this finding's occurrences first",
      );
    const references = [...findingRecords(p), ...occurrenceRecords(p)].filter(
      (f) => f.closure?.supersededBy?.includes(old.id),
    );
    if (references.length)
      throw new InputError(
        "Other findings reference this finding; remove those references before deleting",
      );
    archive(p, mutation(old, { deleted: true }, args));
    fs.rmSync(findingFile(p, old.id));
    publish(p);
    return { deleted: old.id };
  });
}
/** Resolving the remaining scope also resolves its finding. Other dispositions stay independent. */
function occurrenceResolution(
  p: TargetPaths,
  occurrence: OccurrenceRecord,
  args: Json,
): FindingRecord | null {
  const finding = mustFinding(p, occurrence.findingId);
  let patch: Json;
  if (
    finding.state === "closed" &&
    finding.closure?.reason === "resolved" &&
    occurrence.state === "open"
  ) {
    patch = { state: "open", closure: null };
  } else if (
    finding.state === "open" &&
    occurrence.state === "closed" &&
    occurrence.closure?.reason === "resolved"
  ) {
    const others = occurrenceRecords(p).filter(
      (o) => o.findingId === finding.id && o.id !== occurrence.id,
    );
    if (
      !others.every(
        (o) => o.state === "closed" && o.closure?.reason === "resolved",
      )
    )
      return null;
    patch = {
      state: "closed",
      closure: {
        reason: "resolved",
        explanation: "All occurrences are resolved.",
      },
    };
  } else return null;
  return apply(
    mutation(finding, patch, { ...args, expectedRevision: finding.revision }),
    patch,
    p,
  );
}

/** The shared lock keeps readers from seeing the intermediate write; roll back on an ordinary write failure. */
function saveOccurrenceWithFinding(
  p: TargetPaths,
  occurrence: OccurrenceRecord,
  args: Json,
  previous?: OccurrenceRecord,
): void {
  const finding = occurrenceResolution(p, occurrence, args);
  atomicJson(occurrenceFile(p, occurrence.id), occurrence);
  try {
    if (finding) atomicJson(findingFile(p, finding.id), finding);
  } catch (error) {
    if (previous) atomicJson(occurrenceFile(p, previous.id), previous);
    else fs.rmSync(occurrenceFile(p, occurrence.id));
    throw error;
  }
}

export function createOccurrence(raw: unknown, repo: string): OccurrenceRecord {
  const args = requireObject(raw),
    p = paths(args, repo);
  return withRecords(p, () => {
    const key =
      args.idempotencyKey === undefined
        ? undefined
        : str(args, "idempotencyKey");
    if (key) {
      const prior = occurrenceRecords(p).find((o) => o.creationKey === key);
      if (prior) return prior;
    }
    const data = requireObject(args.occurrence);
    const result = apply<OccurrenceRecord>(
      { ...baseRecord("pending"), findingId: "", locations: [] },
      data,
      p,
    );
    result.id = nextRecordId(p, args.prefix === undefined ? "O" : str(args, "prefix"));
    if (key) result.creationKey = key;
    result.history = [
      {
        at: result.createdAt,
        actor: args.actor === undefined ? "agent" : str(args, "actor"),
        revision: 1,
        patch: savedPatch(result, data),
      },
    ];
    saveOccurrenceWithFinding(p, result, args);
    publish(p);
    return result;
  });
}
export function getOccurrence(raw: unknown, repo: string): OccurrenceRecord {
  const args = requireObject(raw),
    p = paths(args, repo);
  return withRecords(p, () => mustOccurrence(p, str(args, "id")));
}
export function listOccurrences(
  raw: unknown,
  repo: string,
): OccurrenceRecord[] {
  const args = requireObject(raw),
    p = paths(args, repo);
  return withRecords(p, () =>
    occurrenceRecords(p).filter(
      (o) =>
        (args.findingId === undefined || o.findingId === args.findingId) &&
        (args.state === undefined ||
          o.state === enumValue(args.state, ["open", "closed"], "state")),
    ),
  );
}
export function updateOccurrence(raw: unknown, repo: string): OccurrenceRecord {
  const args = requireObject(raw),
    p = paths(args, repo);
  return withRecords(p, () => {
    const old = mustOccurrence(p, str(args, "id")),
      patch = requireObject(args.patch);
    const result = apply(mutation(old, patch, args), patch, p);
    if (result.findingId !== old.findingId) {
      const references = [...findingRecords(p), ...occurrenceRecords(p)]
        .filter((f) => f.id !== old.id)
        .some((f) => f.evidence.some((e) => e.occurrenceIds?.includes(old.id)));
      if (
        references ||
        result.evidence.some((e) =>
          e.occurrenceIds?.some((id) => id !== old.id),
        )
      )
        throw new InputError(
          "Remove or re-scope occurrence evidence references before reassigning",
        );
    }
    result.history[result.history.length - 1]!.patch = savedPatch(
      result,
      patch,
    );
    if (["state", "closure", "findingId"].some((key) => key in patch))
      saveOccurrenceWithFinding(p, result, args, old);
    else atomicJson(occurrenceFile(p, result.id), result);
    publish(p);
    return result;
  });
}
export function deleteOccurrence(
  raw: unknown,
  repo: string,
): { deleted: string } {
  const args = requireObject(raw),
    p = paths(args, repo);
  return withRecords(p, () => {
    const old = mustOccurrence(p, str(args, "id"));
    mutation(old, {}, args);
    const references = [...findingRecords(p), ...occurrenceRecords(p)].some(
      (f) => f.evidence.some((e) => e.occurrenceIds?.includes(old.id)),
    );
    if (references)
      throw new InputError(
        "Evidence references this occurrence; remove those references before deleting",
      );
    archive(p, mutation(old, { deleted: true }, args));
    fs.rmSync(occurrenceFile(p, old.id));
    publish(p);
    return { deleted: old.id };
  });
}
function archive(p: TargetPaths, record: RecordBase): void {
  atomicJson(
    path.join(
      p.dir,
      ".deleted",
      `${record.id}-${record.revision}-${recordId("D")}.json`,
    ),
    { ...record, deletedAt: now() },
  );
}
export function summarizeOccurrences(
  occurrences: OccurrenceRecord[],
): OccurrenceSummary {
  return {
    revisionKey: createHash("sha256")
      .update(
        occurrences
          .map((o) => `${o.id}:${o.revision}`)
          .sort()
          .join("|"),
      )
      .digest("hex"),
    updatedAt: occurrences
      .map((o) => o.updatedAt)
      .sort()
      .at(-1),
    total: occurrences.length,
    open: occurrences.filter((o) => o.state === "open").length,
    closed: occurrences.filter((o) => o.state === "closed").length,
    resolved: occurrences.filter((o) => o.closure?.reason === "resolved")
      .length,
  };
}
