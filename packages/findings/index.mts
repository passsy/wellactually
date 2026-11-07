/**
 * The findings server, from the outside.
 *
 * Files on disk are the source of truth; review.html and findings.sarif are
 * generated views of them. Everything that writes a finding goes through
 * api.mts, whether it arrived as an MCP tool call or an HTTP request.
 *
 * This file is the module's only address. Both plugins load it by path, so
 * everything beside it can be moved without telling anybody:
 *
 *   model/   what a finding is — the vocabulary, and the rules of the thing.
 *            Pure, and the part the browser imports as it stands.
 *   store/   where it lives — one file per finding, and the paths, the
 *            registry and the read receipts around them.
 *   serve/   the doors, and what they hand out: MCP, HTTP, the port they
 *            argue over, and the built page.
 *   views/   the generated report and SARIF.
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
  createCandidates,
  createFinding,
  createObservation,
  documentPath,
  dropObservation,
  exportDismissals,
  getFinding,
  listDocuments,
  readDocument,
  linkFixCommit,
  linkPrComment,
  listFindings,
  listCandidates,
  listObservations,
  listRepos,
  listReviews,
  markFindingsSeen,
  readSource,
  regenerateViews,
  reportFinding,
  resolveCandidates,
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
export { upgrade } from "./store/legacy.mts";
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
export { toHtml } from "./views/html.mts";
export { toSarif, FINGERPRINT_KEY } from "./views/sarif.mts";

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
  Observation,
  ObservationStatus,
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
  OBSERVATION_STATUS,
  PRIORITY,
  RESOLUTION,
  VERDICT,
} from "./model/types.mts";
