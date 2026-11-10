import type { Tool } from "./tools.mts";
import {
  createFindingRecord,
  getFindingRecord,
  listFindingRecords,
  updateFindingRecord,
  deleteFindingRecord,
  createOccurrence,
  getOccurrence,
  listOccurrences,
  updateOccurrence,
  deleteOccurrence,
} from "./crud.mts";
const string = { type: "string" };
const prefix = { type: "string", pattern: "^[A-Za-z]$", description: "ID letter. Creation assigns the next number starting at 1 for this letter in this review. Defaults to G for findings, O for occurrences." };
const strings = { type: "array", items: string };
const entry = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "object", properties, required, additionalProperties: false });
const entries = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "array", items: entry(properties, required) });
const state = { type: "string", enum: ["open", "closed"] };
const closure = {
  anyOf: [
    { type: "null" },
    entry(
      {
        reason: {
          type: "string",
          enum: ["resolved", "rejected", "disproven", "superseded"],
        },
        explanation: string,
        supersededBy: strings,
      },
      ["reason", "explanation"],
    ),
  ],
};
const evidence = entries(
  {
    id: string,
    kind: { type: "string", enum: ["source", "reasoning", "test"] },
    polarity: { type: "string", enum: ["supports", "contradicts"] },
    description: string,
    artifacts: {
      ...strings,
      description: "Artifact paths are relative to the reviewed repository, never to the agent working directory. For proofs stored beside the checkout, pass an absolute path. For test evidence, attach only a runnable test/probe source file or a Markdown proof document containing the complete test or reproduction, exact run command, prerequisites, expected/actual result and limits. Prefer one self-contained proof per claim. Do not attach raw stdout/stderr .txt or .log dumps, standalone patches/diffs, grep output or baseline dumps; keep those as internal working files and summarize decisive results in the proof document. A test that did not run is a limitation, not executable proof.",
    },
    occurrenceIds: strings,
  },
  ["kind", "polarity", "description"],
);
const assessments = entries(
  {
    id: string,
    author: string,
    authorType: { type: "string", enum: ["human", "agent"] },
    conclusion: string,
    reason: string,
    at: string,
  },
  ["author", "authorType", "conclusion", "reason"],
);
const links = entries(
  {
    id: string,
    kind: string,
    url: string,
    commit: string,
    description: string,
  },
  ["kind"],
);
const common = { state, closure, evidence, assessments, links };
const finding = {
  ...common,
  verdict: {
    type: "string",
    enum: ["undecided", "accepted", "invalid", "tolerated"],
  },
  reportedAt: {
    type: ["string", "null"],
    description:
      "ISO timestamp when the author was told. Null clears reporting. Independent of verdict, resolution and comment links.",
  },
  title: string,
  description: string,
  rules: entries({ id: string, url: string, note: string }, ["id"]),
  priority: { type: "string", enum: ["p0", "p1", "p2", "p3", "p4"] },
  tags: strings,
  note: { type: ["string", "null"] },
  origins: entries(
    { run: string, source: string, unit: string, rule: string, quote: string },
    ["run", "source", "unit"],
  ),
  metadata: { type: "object", additionalProperties: true },
};
const location = {
  file: string,
  line: { type: "integer", minimum: 1 },
  endLine: { type: "integer", minimum: 1 },
  commit: string,
  note: string,
  kind: { type: "string", enum: ["metadata"] },
  subject: { type: "string", enum: ["pr-title", "pr-body", "commit-message"] },
  text: string,
};
const occurrence = {
  ...common,
  findingId: string,
  description: { type: ["string", "null"] },
  locations: entries(location, ["file", "line"]),
};
const address = { repo: string, target: string, actor: string };
const revision = {
  id: string,
  expectedRevision: { type: "integer", minimum: 1 },
};
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  run: Tool["run"],
  readOnlyHint = false,
): Tool {
  return {
    name,
    description,
    inputSchema: entry({ ...address, ...properties }, ["target", ...required]),
    annotations: {
      readOnlyHint,
      destructiveHint: name.startsWith("delete_"),
      openWorldHint: false,
    },
    run,
    inCardServer: ["get_finding", "list_findings", "update_finding"].includes(
      name,
    )
      ? "model"
      : undefined,
  };
}
export const CRUD_TOOLS: Tool[] = [
  tool(
    "create_finding",
    "Create a finding with a short defect-first title and a concise author-facing description: consequence, essential cause, remedy. Keep investigation detail in evidence/assessments and locations on occurrences. No candidate kind or verification status. User verdict, reportedAt, evidence, assessments, links and lifecycle are independent. Add separately addressable occurrences with create_occurrence. Optional idempotencyKey makes retries return the original record.",
    { finding: entry(finding, ["title"]), prefix, idempotencyKey: string },
    ["finding"],
    createFindingRecord,
  ),
  tool(
    "get_finding",
    "Read one canonical finding, including its revision, multiple rules, evidence, assessments, links and change history. Occurrences are separate records queried with list_occurrences.",
    { id: string },
    ["id"],
    getFindingRecord,
    true,
  ),
  tool(
    "list_findings",
    "List canonical findings for a target, optionally filtered by state, user verdict, closure reason, linked rule or origin. Includes findings immediately after creation; no verification gate.",
    {
      state,
      verdict: finding.verdict,
      reason: string,
      rule: string,
      run: string,
      unit: string,
    },
    [],
    listFindingRecords,
    true,
  ),
  tool(
    "update_finding",
    "Patch independent finding fields. Supply expectedRevision from get/list to prevent lost updates. Arrays replace the whole collection; entries have stable IDs, so edit/remove entries by retaining the others. null clears note, reportedAt or closure. Closing needs closure; reopening needs state:open and closure:null. Attaching commits or comments does not close or accept the finding. After completing and verifying a requested fix, explicitly set state:closed and closure:{reason:resolved,explanation:...}, alongside its work links, then read back the saved state before reporting done. Partial fixes remain open. Resolving a finding does not require resolving its occurrences; fixed statistics follow the finding itself after the grace period.",
    { ...revision, patch: entry(finding) },
    ["id", "expectedRevision", "patch"],
    updateFindingRecord,
  ),
  tool(
    "delete_finding",
    "Delete a finding, retaining an audit archive. Delete or reassign its occurrences and remove incoming supersededBy references first. Closing with a reason preserves the record for normal review history.",
    revision,
    ["id", "expectedRevision"],
    deleteFindingRecord,
  ),
  {
    ...tool(
      "create_occurrence",
      "Create one independently trackable instance of a finding. Several locations can jointly describe this one defect. Captures source context when available. Its evidence, links and lifecycle are independent of the parent. Optional idempotencyKey makes retries return the existing occurrence.",
      { occurrence: entry(occurrence, ["findingId"]), prefix, idempotencyKey: string },
      ["occurrence"],
      createOccurrence,
    ),
    inCardServer: "model",
  },
  {
    ...tool(
      "get_occurrence",
      "Read one occurrence, its locations, evidence, work links, history and revision.",
      { id: string },
      ["id"],
      getOccurrence,
      true,
    ),
    inCardServer: "model",
  },
  {
    ...tool(
      "list_occurrences",
      "List separately stored occurrences, optionally filtered by findingId and state. A finding can stay open while some occurrences are resolved.",
      { findingId: string, state },
      [],
      listOccurrences,
      true,
    ),
    inCardServer: "model",
  },
  {
    ...tool(
      "update_occurrence",
      "Patch one occurrence with expectedRevision. Resolve individual occurrences with state:closed and closure:{reason:resolved,explanation:...}. Link any number of commits/PRs independently. findingId can move it to another finding when evidence references remain valid. Resolving the last unresolved occurrence also resolves an open parent finding. Reopening an occurrence reopens a resolved parent. Verdict and reporting are preserved.",
      { ...revision, patch: entry(occurrence) },
      ["id", "expectedRevision", "patch"],
      updateOccurrence,
    ),
    inCardServer: "model",
  },
  tool(
    "delete_occurrence",
    "Delete one occurrence, retaining an audit archive. Remove scoped evidence references first. Other occurrences and the parent finding are unchanged.",
    revision,
    ["id", "expectedRevision"],
    deleteOccurrence,
  ),
];
