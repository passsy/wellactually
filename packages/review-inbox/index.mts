/**
 * The findings server, from the outside.
 *
 * Files on disk are the source of truth. Canonical finding/occurrence CRUD
 * lives in crud.mts; api.mts adapts existing UI controls and saved review sessions.
 *
 * This file is the module's only address. Both plugins load it by path, so
 * everything beside it can be moved without telling anybody:
 *
 *   model/   what a finding is — the vocabulary, and the rules of the thing.
 *            Pure, and the part the browser imports as it stands.
 *   store/   where it lives — separate finding and occurrence files, and the
 *            registry and the read receipts around them.
 *   serve/   the doors, and what they hand out: MCP, HTTP, the port they
 *            argue over, and the built page.
 *   web/     the pages themselves, which are compiled rather than written.
 *
 *   api.mts  the one core. Both doors call this and add no rules of their
 *            own, so a finding accepted from a browser and one accepted from
 *            a tool call go through the same checks.
 */

export { claimReviewSession, getReviewSession, claimReviewWork, completeReviewWork, beginVerification, retryVerification, blockReviewWork } from "./queues.mts";
export {
  addLocation,
  baselineCheck,
  createFinding,
  documentPath,
  getFinding,
  listDocuments,
  readDocument,
  linkFixCommit,
  linkPrComment,
  listFindings,
  listRepos,
  listReviews,
  markFindingsSeen,
  readSource,
  reviewStatus,
  setNote,
  setReported,
  setResolution,
  setStage,
  setVerdict,
  startReview,
  updateFinding,
} from "./api.mts";
export type {
  BaselineResult,
  DismissedExport,
  DocumentEntry,
  FindingList,
  ReviewCounts,
  ReviewDocument,
  ReviewStatus,
  ReviewSummary,
  SourceFile,
} from "./api.mts";

export {
  checkResolution,
  checkVerdict,
  nextResolutions,
  TransitionError,
} from "./model/transitions.mts";
export { fingerprintOf, normalize, snippetAt } from "./model/fingerprint.mts";
export { InputError } from "./validate.mts";
export { readRegistry, upsertRegistry } from "./store/registry.mts";
export {
  GLOBAL_ROOT,
  REGISTRY_FILE,
  REVIEW_DIR,
  headCommit,
  repoRoot,
  slugTarget,
  targetPaths,
} from "./store/paths.mts";
export { UI_PORT } from "./serve/port.mts";
export { currentWorkspace, isPluginInstall } from "./store/workspace.mts";
export type { Workspace } from "./store/workspace.mts";
export { TOOLS, TOOL_NAMES, toolNamed } from "./tools.mts";
export type { Tool } from "./tools.mts";
export { createMcpServer, serveStdio } from "./serve/mcp.mts";
export { startUi } from "./serve/http.mts";
export type { Ui } from "./serve/http.mts";
export { main } from "./serve/server.mts";

export {
  captureAt,
  captureContext,
  captureDiff,
  hunksAround,
  lastLine,
} from "./model/context.mts";
export type { Span } from "./model/context.mts";

export { classifyAuthorship } from "./model/authorship.mts";

export type {
  Actor,
  Anchor,
  Authorship,
  Evidence,
  Finding,
  Priority,
  RelatedLocation,
  Resolution,
  SourceContext,
  TargetMeta,
  TransitionEntry,
  Verdict,
} from "./model/types.mts";
export {
  ACTOR,
  AUTHORSHIP,
  AUTHORSHIP_SAYS,
  EVIDENCE,
  PRIORITY,
  RESOLUTION,
  VERDICT,
} from "./model/types.mts";

// Canonical CRUD API. Presentation operations above drive the UI controls.
export { createFindingRecord, getFindingRecord, listFindingRecords, updateFindingRecord, deleteFindingRecord, createOccurrence, getOccurrence, listOccurrences, updateOccurrence, deleteOccurrence } from "./crud.mts";
export type { FindingRecord, FindingVerdict, OccurrenceRecord, OccurrenceLocation, EvidenceEntry, Assessment, RecordLink, RuleLink, Closure } from "./model/records.mts";
