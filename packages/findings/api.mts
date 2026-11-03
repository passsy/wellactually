/**
 * Every operation the findings server offers, once.
 *
 * MCP tools and the HTTP endpoints are two doors into this module and add no
 * rules of their own. That is deliberate: a finding accepted from a browser
 * and a finding accepted from a tool call have to go through the same
 * transition check, or the two surfaces drift into two different products.
 *
 * Nothing here imports MCP or HTTP, so a test can drive the whole thing with
 * plain function calls.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import {
  ACTOR,
  CANDIDATE_STATUS,
  EVIDENCE,
  MAX_TAGS,
  type Authorship,
  MAX_TAG_LENGTH,
  OBSERVATION_STATUS,
  PRIORITY,
  REPORTER,
  RESOLUTION,
  VERDICT,
  type Actor,
  type Finding,
  type Observation,
  type ReviewCandidate,
  type RelatedLocation,
  type Resolution,
  type ReviewPr,
  type FindingList,
  type ReviewCounts,
  type ReviewState,
  type ReviewStatus,
  type ReviewSummary,
  type TargetMeta,
  type Verdict,
} from "./model/types.mts";
import {
  GLOBAL_ROOT,
  REVIEW_DIR,
  headCommit,
  repoRelative,
  targetPaths,
  type TargetPaths,
} from "./store/paths.mts";
import { fingerprintOf, snippetAt } from "./model/fingerprint.mts";
import { captureAt, lastLine, type Span } from "./model/context.mts";
import { checkResolution, checkVerdict } from "./model/transitions.mts";
import {
  allocateFindingId,
  allocateCandidateId,
  allocateObservationId,
  claimCandidate,
  claimFinding,
  claimObservation,
  ensureTarget,
  letterFor,
  listCandidates as readCandidates,
  listFindings as readFindings,
  listObservations as readObservations,
  listTargets,
  readFinding,
  readCandidate,
  readMeta,
  reviewActivity,
  readObservation,
  writeFinding,
  writeCandidate,
  writeMeta,
  writeObservation,
  writeView,
} from "./store/findings.mts";
import { readRegistry, upsertRegistry } from "./store/registry.mts";
import { readRule, reviewRules, type ReviewRules } from "./rules.mts";
import {
  markFollow,
  markSeen,
  readFollow,
  readSeen,
  type SeenMap,
} from "./store/reader.mts";
import { groupOf } from "./model/groups.mts";
import { countsOf } from "./model/counts.mts";
import { levelsOf, type LevelDocument } from "./model/levels.mts";
import { UI_PORT } from "./serve/port.mts";
import { openInBrowser } from "./serve/browser.mts";
import {
  COMPLAINTS,
  file as fileIssue,
  HOME,
  prepare,
  type Complaint,
} from "./report/issue.mts";
import { toHtml } from "./views/html.mts";
import { toSarif } from "./views/sarif.mts";
import {
  flag,
  InputError,
  object,
  oneOf,
  optionalArray,
  optionalOneOf,
  optionalStr,
  positiveInt,
  requireObject,
  str,
  text,
} from "./validate.mts";

export type { FindingList, ReviewCounts, ReviewStatus, ReviewSummary };

/** ISO 8601 with timezone, everywhere a timestamp is written. */
function now(): string {
  return new Date().toISOString();
}

/** Anything a caller may point at another repository than the server's own. */
function repoOf(args: Record<string, unknown>, fallback: string): string {
  const explicit = optionalStr(args, "repo");
  if (explicit) return explicit;
  // An empty fallback means the process could not tell which project it is
  // for. Asking is the only safe answer: guessing writes one project's
  // findings into another, and nothing about that failure looks wrong.
  if (fallback === "") {
    throw new InputError(
      'this server cannot tell which project you mean, because it was started from a plugin installation rather than from a repository. Pass "repo" with the absolute path of the repository you are reviewing.',
    );
  }
  return fallback;
}

function pathsOf(args: Record<string, unknown>, repo: string): TargetPaths {
  return targetPaths(repoOf(args, repo), str(args, "target"));
}

function mustFind(paths: TargetPaths, id: string): Finding {
  const finding = readFinding(paths, id);
  if (!finding) {
    const known = readFindings(paths).map((each) => each.id);
    throw new InputError(
      `no finding "${id}" in target "${paths.target}". Known ids: ${known.join(", ") || "none yet"}.`,
    );
  }
  return finding;
}

// A writer that keeps landing mid-rebuild publishes its own views anyway, so
// giving up after a few passes costs nothing that its publish does not heal.
const MAX_PUBLISH_PASSES = 5;

/**
 * Rewrites both views and records the target machine-wide.
 *
 * Called after every mutation. A target holds dozens of findings, so
 * rebuilding from scratch is cheaper than working out what changed, and it
 * cannot leave the views disagreeing with the files.
 *
 * A view that cannot be written does not fail the mutation. The finding is
 * already on disk by the time this runs, and an error here made a saved
 * mutation report failure — the caller then retried a write that had
 * happened, or gave up on one that had not needed giving up on. The views
 * are rebuilt whole on every mutation, so the next successful one heals
 * them; the failure is said on stderr rather than to the caller.
 *
 * Every session runs its own server, and two of them writing at once each
 * rebuild the views from what they read. The rename that lands last wins, and
 * it can carry the older read: two processes writing ten findings each left
 * twenty findings on disk and nineteen in the SARIF. So the findings are read
 * again after the views are written, and a change since the first read means
 * a write slipped in and the views are rebuilt from the newer state. The
 * process whose rename lands last is always the one checking afterwards, so
 * the views end on what is on disk.
 */
function publish(paths: TargetPaths): void {
  ensureTarget(paths);
  let findings = readFindings(paths);
  const at = now();
  try {
    for (let pass = 0; pass < MAX_PUBLISH_PASSES; pass++) {
      writeView(
        paths.html,
        toHtml(
          { repo: paths.repo, target: paths.target, generatedAt: at },
          findings,
        ),
      );
      writeView(paths.sarif, toSarif(paths.target, findings));
      const latest = readFindings(paths);
      if (JSON.stringify(latest) === JSON.stringify(findings)) break;
      findings = latest;
    }
  } catch (error) {
    console.error(
      `wellactually: the mutation is saved, but rebuilding the views of "${paths.target}" failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  upsertRegistry(paths.repo, paths.target, at);
}

/**
 * The marked lines of a location: one, or a block.
 *
 * A block that runs on for pages is not an anchor, it is a file, and it would
 * put that file into every view. So there is a ceiling, and hitting it is an
 * error that says to anchor on the part that is actually wrong.
 */
const MAX_MARKED_LINES = 200;

function spanOf(location: Record<string, unknown>): Span {
  const line = positiveInt(location, "line");
  const endLine =
    location["endLine"] === undefined
      ? undefined
      : positiveInt(location, "endLine");
  if (endLine === undefined) return { line };
  if (endLine < line) {
    throw new InputError(
      `"endLine" (${endLine}) is before "line" (${line}). A marked block runs forwards.`,
    );
  }
  if (endLine - line + 1 > MAX_MARKED_LINES) {
    throw new InputError(
      `${endLine - line + 1} marked lines is too many. Mark at most ${MAX_MARKED_LINES}, and anchor on the part that is wrong rather than the whole region.`,
    );
  }
  return { line, endLine };
}

/**
 * The other places a finding points at, each with its own code captured.
 *
 * A note per location, because "here is more code" is not an argument. The
 * note is what says why this second place belongs to the first one.
 */
function relatedFrom(
  args: Record<string, unknown>,
  repo: string,
  base: string | undefined,
): RelatedLocation[] {
  return optionalArray(args, "related").map((entry) => {
    const location = requireObject(entry);
    const file = repoRelative(repo, str(location, "file"));
    const span = spanOf(location);
    const note = optionalStr(location, "note");
    return {
      file,
      ...span,
      ...(note ? { note } : {}),
      ...captureAt(repo, file, span, base),
    };
  });
}

/**
 * The tags a call carries, in a shape two findings can be clustered by.
 *
 * Free text, so the only job here is making "Race", "race " and "race" the
 * same tag. Anything beyond that is policing wording, and the whole point of
 * letting the review name these itself is that nobody has to agree on the
 * vocabulary first.
 *
 * The two ceilings are what keeps a tag a tag. A finding wearing nine of them
 * clusters with everything, and a tag long enough to be a sentence is the
 * title written twice.
 */
function tagsFrom(args: Record<string, unknown>): string[] {
  const given = optionalArray(args, "tags")
    .map((tag) => String(tag).trim().replace(/\s+/g, " ").toLowerCase())
    .filter((tag) => tag !== "");
  const tags = [...new Set(given)];
  if (tags.length > MAX_TAGS) {
    throw new InputError(
      `${tags.length} tags is too many. Use at most ${MAX_TAGS}, and usually one: a tag is what this finding clusters with, not a description of it.`,
    );
  }
  const long = tags.find((tag) => tag.length > MAX_TAG_LENGTH);
  if (long) {
    throw new InputError(
      `the tag "${long}" is longer than ${MAX_TAG_LENGTH} characters. A tag is a couple of words, e.g. "race" or "missing test"; what it is about belongs in the title.`,
    );
  }
  return tags;
}

/**
 * What a write answers with: the finding as stored, and — when the server
 * judged the finding to be about something other than the author's own work —
 * one warning, made here because this is the moment the reviewer can still
 * re-anchor, re-argue, or accept the judgement. The warning is not part of
 * the finding and is never written to disk; the stored `authorship` field and
 * the tag are what the views read.
 */
export type NoticedFinding = Finding & { notice?: string };

/**
 * The tag the server adds when no marked line is the author's own edit.
 *
 * A tag rather than a field, because it is exactly what tags are for — a
 * pile the triage page can hold the queue to — and because it is a judgement
 * a human may overrule by taking it off, which fields do not invite.
 */
export const PRE_EXISTING_TAG = "pre-existing";

/**
 * Whether the finding is about the change under review at all.
 *
 * One authored line anywhere on the finding is enough: plenty of findings
 * legitimately anchor on old code that a new edit somewhere else breaks, and
 * the related location pointing at that edit is what says so. Judged only
 * when at least one location could be classified — a run without a base, or
 * git unable to answer, is no evidence of anything.
 */
function concernsChange(
  locations: (Authorship | undefined)[],
): boolean | undefined {
  if (!locations.some(Boolean)) return undefined;
  return locations.includes("changed");
}

/**
 * Said to the reviewer, not to the reader. The two deceptive authorship
 * answers look like changed code in every diff view, which is how findings
 * end up presented as comments on the author's work when the author only
 * re-indented or moved what was already there.
 */
const ANCHOR_SAYS: Partial<Record<Authorship, string>> = {
  "whitespace-only":
    "The anchor differs from the base only in whitespace: the author re-indented this code — wrapping or moving what was already there — and did not write it.",
  moved:
    "The anchor is code the author moved here, not code they wrote: the same lines exist on the base side.",
  untouched: "The anchor is identical to the base.",
};

/**
 * The one warning a write is answered with, when there is something to say.
 *
 * A finding that misses the change entirely gets the full judgement and what
 * to do about it. A finding that does concern the change but anchors on lines
 * the author never wrote gets told to move the anchor — that is where a pull
 * request comment lands, and it should land on the author's own edit.
 */
function noticeFor(
  authorship: Authorship | undefined,
  preExisting: boolean | undefined,
  tagged: boolean,
): string | undefined {
  const anchor = authorship && ANCHOR_SAYS[authorship];
  if (preExisting) {
    return [
      anchor,
      "No marked line is the author's own edit, so this finding is about the code, not about the change under review.",
      tagged ? `Tagged "${PRE_EXISTING_TAG}".` : undefined,
      `If an edit in this change is what causes the problem, add it with add_location — that takes the tag off — or re-anchor there with update_finding. If the problem predates the change, keep the tag and say so in the body.`,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (authorship === "whitespace-only" || authorship === "moved") {
    return `${anchor ?? ""} A comment posted here lands on code the author never touched. Anchor on the author's own edit — one of this finding's related locations is one — and name this line in the text instead.`;
  }
  return undefined;
}

function createFindingStored(
  raw: unknown,
  repo: string,
  publishAfter: boolean,
): NoticedFinding {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  const anchor = object(args, "anchor");
  const evidence = oneOf(args, "evidence", EVIDENCE);
  const provenTest = optionalStr(args, "provenTest");

  // The handbook's own rule: a Proven finding names the test that fails.
  // Rejecting here is what keeps the label from decaying into a synonym for
  // "I am confident".
  if (evidence === "Proven" && !provenTest) {
    throw new InputError(
      'evidence "Proven" requires "provenTest" as "file:line" of the failing test. Use "Reasoned" when no test exists.',
    );
  }

  const metadata = metadataAnchor(anchor);
  const file = metadata ? str(anchor, "file") : repoRelative(paths.repo, str(anchor, "file"));
  const span = spanOf(anchor);
  const line = span.line;
  const rule = optionalStr(args, "rule");
  // The first marked line is the identity, whatever else is marked with it.
  // Widening a block on a re-run must not turn it into a different finding.
  const snippet = metadata ? metadata.text.split("\n")[line - 1]! : snippetAt(paths.repo, file, line);
  const fingerprint = fingerprintOf(rule, file, snippet);

  // The same rule on the same line, twice, is the same finding written twice.
  // The line has to be part of that judgement: the fingerprint deliberately
  // ignores it so a finding survives code moving above it, which means two
  // identical-looking lines in one file share a fingerprint without being the
  // same problem. One file carrying several findings is the normal case.
  // Failed findings block too, and that is most of what failing one buys: a
  // detector that misfires here will misfire here on every run, and the
  // verdict is what stops the same noise being filed again as new.
  const clash = readFindings(paths).find(
    (each) =>
      each.fingerprint === fingerprint &&
      each.anchor.line === line &&
      each.title === str(args, "title"),
  );
  if (clash) {
    throw new InputError(
      `${clash.id} already covers ${file}:${line} with the same rule ("${clash.title}"). Add to that finding with add_location, or anchor this one on the line its own problem lives on.`,
    );
  }

  const promoted = optionalStr(args, "fromObservation");
  const observation = promoted ? readObservation(paths, promoted) : null;
  if (promoted && !observation) {
    throw new InputError(
      `no observation "${promoted}" in target "${paths.target}".`,
    );
  }

  // The base belongs to the run. Whichever call carries it first sets it for
  // the target, so every later finding gets its diff without repeating it.
  //
  // The same call stamps when the review started, for a run that never called
  // `start_review`: the first finding is the earliest moment the server can
  // prove the review existed, and the inbox sorts on it.
  const at = now();
  const meta = readMeta(paths);
  const base = optionalStr(args, "base") ?? meta.base;
  const stamped: TargetMeta = {
    ...meta,
    ...(base ? { base } : {}),
    // The same instant the finding is stamped with, not a second reading of
    // the clock: the review started when its first finding was written, and
    // two timestamps a millisecond apart for one event is a lie about which.
    startedAt: meta.startedAt ?? at,
  };
  if (stamped.base !== meta.base || stamped.startedAt !== meta.startedAt) {
    writeMeta(paths, stamped);
  }
  const captured = metadata ? { context: { start: 1, lines: metadata.text.split("\n") } } : captureAt(paths.repo, file, span, base);
  const related = relatedFrom(args, paths.repo, base);

  // Who found it. The review is the default because the review is what calls
  // this: a finding arriving with nothing said about its origin came from the
  // run that is writing it.
  const reporter = optionalOneOf(args, "reporter", REPORTER) ?? "review";
  const reporterName = optionalStr(args, "reporterName");
  if (reporter === "pr-comment" && !reporterName) {
    throw new InputError(
      'reporter "pr-comment" requires "reporterName": the login of whoever left it. A comment nobody is named for cannot be answered.',
    );
  }

  // The double check: does this finding concern the change at all? One
  // authored line among its locations says yes. None says the review is
  // commenting on code the author never touched, which is worth a tag the
  // triage page can hold the queue to and a human can take off.
  const preExisting = !metadata &&
    concernsChange([
      captured.authorship,
      ...related.map((each) => each.authorship),
    ]) === false;
  const tags = tagsFrom(args);
  const tagged =
    preExisting && !tags.includes(PRE_EXISTING_TAG) && tags.length < MAX_TAGS;
  if (tagged) tags.push(PRE_EXISTING_TAG);
  const letter = letterFor(optionalStr(args, "level"));
  const draft = (id: string): Finding => ({
    id,
    title: str(args, "title"),
    body: str(args, "body"),
    evidence,
    priority: oneOf(args, "priority", PRIORITY),
    ...(tags.length > 0 ? { tags } : {}),
    ...(rule ? { rule } : {}),
    ...(provenTest ? { provenTest } : {}),
    anchor: {
      ...metadata,
      file,
      ...span,
      commit: optionalStr(anchor, "commit") ?? headCommit(paths.repo),
    },
    snippet,
    ...captured,
    ...(related.length > 0 ? { related } : {}),
    fingerprint,
    verdict: "undecided",
    resolution: "unresolved",
    history: [{ at, actor: "review", verdict: "undecided" }],
    links: {},
    ...(promoted ? { fromObservation: promoted } : {}),
    ...(optionalStr(args, "fromCandidate")
      ? { fromCandidate: optionalStr(args, "fromCandidate") }
      : {}),
    ...(optionalStr(args, "verificationStatus")
      ? {
          verification: {
            status: optionalStr(args, "verificationStatus") as
              "confirmed" | "plausible",
            ...(optionalStr(args, "verificationReason")
              ? { reason: optionalStr(args, "verificationReason") }
              : {}),
          },
        }
      : {}),
    ...(reporter === "review" ? {} : { reporter }),
    ...(reporterName ? { reporterName } : {}),
    createdAt: at,
  });

  const finding = claim(paths, letter, draft);
  if (observation) {
    writeObservation(paths, {
      ...observation,
      status: "promoted",
      promotedTo: finding.id,
    });
  }
  if (publishAfter) publish(paths);
  const notice = noticeFor(
    finding.authorship,
    preExisting,
    tagged || tags.includes(PRE_EXISTING_TAG),
  );
  return notice ? { ...finding, notice } : finding;
}

/** Record one finding and refresh its generated views. */
export function createFinding(raw: unknown, repo: string): NoticedFinding {
  return createFindingStored(raw, repo, true);
}

export interface CreateCandidatesResult {
  created: { id: string; source: string; unit: string }[];
  errors: { index: number; message: string }[];
}

function candidateDraft(raw: unknown, id: string, at: string): ReviewCandidate {
  const args = requireObject(raw);
  const anchor = object(args, "anchor");
  const tags = tagsFrom(args);
  const optionalPositiveInt = (
    input: Record<string, unknown>,
    field: string,
  ): number | undefined =>
    input[field] === undefined ? undefined : positiveInt(input, field);
  const related = optionalArray(args, "related").map((rawLocation) => {
    const location = requireObject(rawLocation);
    return {
      file: str(location, "file"),
      line: positiveInt(location, "line"),
      ...(optionalPositiveInt(location, "endLine") !== undefined
        ? { endLine: optionalPositiveInt(location, "endLine") }
        : {}),
      ...(optionalStr(location, "note")
        ? { note: optionalStr(location, "note") }
        : {}),
    };
  });
  return {
    id,
    source: str(args, "source"),
    run: str(args, "run"),
    unit: str(args, "unit"),
    title: str(args, "title"),
    body: str(args, "body"),
    evidence: oneOf(args, "evidence", EVIDENCE),
    priority: oneOf(args, "priority", PRIORITY),
    ...(tags.length ? { tags } : {}),
    ...(optionalStr(args, "level")
      ? { level: optionalStr(args, "level") }
      : {}),
    ...(optionalStr(args, "rule") ? { rule: optionalStr(args, "rule") } : {}),
    ...(optionalStr(args, "provenTest")
      ? { provenTest: optionalStr(args, "provenTest") }
      : {}),
    anchor: {
      ...metadataAnchor(anchor),
      file: str(anchor, "file"),
      line: positiveInt(anchor, "line"),
      ...(optionalPositiveInt(anchor, "endLine") !== undefined
        ? { endLine: optionalPositiveInt(anchor, "endLine") }
        : {}),
      ...(optionalStr(anchor, "commit")
        ? { commit: optionalStr(anchor, "commit") }
        : {}),
    },
    ...(related.length ? { related } : {}),
    ...(optionalStr(args, "scope")
      ? { scope: optionalStr(args, "scope") }
      : {}),
    ...(optionalStr(args, "quote")
      ? { quote: optionalStr(args, "quote") }
      : {}),
    status: "pending",
    createdAt: at,
    updatedAt: at,
  };
}

/** Store possible findings immediately, before independent verification. */
export function createCandidates(
  raw: unknown,
  repo: string,
): CreateCandidatesResult {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  const run = str(args, "run");
  const candidates = optionalArray(args, "candidates");
  if (candidates.length === 0) {
    throw new InputError('"candidates" must contain at least one candidate.');
  }
  if (candidates.length > 100) {
    throw new InputError('"candidates" may contain at most 100 candidates.');
  }
  const existingBySource = new Map(
    readCandidates(paths)
      .filter((candidate) => candidate.run === run)
      .map((candidate) => [candidate.source, candidate]),
  );
  const created: CreateCandidatesResult["created"] = [];
  const errors: CreateCandidatesResult["errors"] = [];
  for (const [index, rawCandidate] of candidates.entries()) {
    try {
      const source = str(requireObject(rawCandidate), "source");
      const existing = existingBySource.get(source);
      if (existing) {
        created.push({
          id: existing.id,
          source: existing.source,
          unit: existing.unit,
        });
        continue;
      }
      let candidate: ReviewCandidate | null = null;
      for (
        let attempt = 0;
        attempt < CLAIM_ATTEMPTS && !candidate;
        attempt += 1
      ) {
        const at = now();
        const next = candidateDraft(
          { ...requireObject(rawCandidate), run },
          allocateCandidateId(paths),
          at,
        );
        if (claimCandidate(paths, next)) candidate = next;
      }
      if (!candidate) {
        throw new InputError(
          "could not allocate a candidate id; retry the call.",
        );
      }
      existingBySource.set(candidate.source, candidate);
      created.push({
        id: candidate.id,
        source: candidate.source,
        unit: candidate.unit,
      });
    } catch (error) {
      errors.push({
        index,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (created.length) upsertRegistry(paths.repo, paths.target, now());
  return { created, errors };
}

/** Read pending or resolved review candidates without consulting local files. */
export function listCandidates(raw: unknown, repo: string): ReviewCandidate[] {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  const run = optionalStr(args, "run");
  const unit = optionalStr(args, "unit");
  const status = optionalOneOf(args, "status", CANDIDATE_STATUS);
  return readCandidates(paths)
    .filter((candidate) => !run || candidate.run === run)
    .filter((candidate) => !unit || candidate.unit === unit)
    .filter((candidate) => !status || candidate.status === status);
}

export interface ResolveCandidatesResult {
  resolved: {
    id: string;
    status: ReviewCandidate["status"];
    findingId?: string;
  }[];
  errors: { index: number; id?: string; message: string }[];
}

/**
 * Finish independent verification in one round trip.
 *
 * Refuted candidates remain as calibration evidence. Confirmed and plausible
 * candidates atomically become ordinary undecided findings for human triage.
 */
export function resolveCandidates(
  raw: unknown,
  repo: string,
): ResolveCandidatesResult {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  const decisions = optionalArray(args, "decisions");
  if (decisions.length === 0) {
    throw new InputError('"decisions" must contain at least one decision.');
  }
  if (decisions.length > 100) {
    throw new InputError('"decisions" may contain at most 100 decisions.');
  }
  const target = str(args, "target");
  const explicitRepo = optionalStr(args, "repo");
  const base = optionalStr(args, "base");
  const resolved: ResolveCandidatesResult["resolved"] = [];
  const errors: ResolveCandidatesResult["errors"] = [];
  let published = false;

  for (const [index, rawDecision] of decisions.entries()) {
    let id: string | undefined;
    try {
      const decision = requireObject(rawDecision);
      id = str(decision, "id");
      const candidate = readCandidate(paths, id);
      if (!candidate)
        throw new InputError(
          `no candidate "${id}" in target "${paths.target}".`,
        );
      if (candidate.status !== "pending" && args["reverify"] !== true) {
        resolved.push({
          id: candidate.id,
          status: candidate.status,
          ...(candidate.findingId ? { findingId: candidate.findingId } : {}),
        });
        continue;
      }
      const status = oneOf(decision, "status", [
        "confirmed",
        "plausible",
        "refuted",
      ] as const);
      const reason = optionalStr(decision, "reason");
      const proof = optionalStr(decision, "proof");
      if (status === "plausible" && !reason) {
        throw new InputError(
          `candidate ${id} is plausible and needs a reason.`,
        );
      }
      if (status === "refuted" && !proof && !reason) {
        throw new InputError(
          `candidate ${id} is refuted and needs proof or a reason.`,
        );
      }
      const at = now();
      if (status === "refuted") {
        if (candidate.findingId) {
          const previous = mustFind(paths, candidate.findingId);
          writeFinding(paths, { ...previous, verification: { status: "refuted", ...(reason || proof ? { reason: reason ?? proof } : {}) } });
          published = true;
        }
        const updated: ReviewCandidate = {
          ...candidate,
          status,
          ...(reason ? { verificationReason: reason } : {}),
          ...(proof ? { proof } : {}),
          updatedAt: at,
        };
        writeCandidate(paths, updated);
        resolved.push({ id, status });
        continue;
      }

      const correction =
        decision["finding"] === undefined
          ? {}
          : requireObject(decision["finding"]);
      const final = { ...candidate, ...correction } as Record<string, unknown>;
      const scope =
        typeof final["scope"] === "string" ? final["scope"] : undefined;
      const rawTags = Array.isArray(final["tags"])
        ? final["tags"].filter((tag): tag is string => typeof tag === "string")
        : [];
      const scopeTag = scope ? `scope:${scope}` : undefined;
      const tags =
        scopeTag && !rawTags.includes(scopeTag) && rawTags.length < MAX_TAGS
          ? [...rawTags, scopeTag]
          : rawTags;
      const duplicate = candidate.findingId ? mustFind(paths, candidate.findingId) : readFindings(paths).find(
        (finding) =>
          finding.title === final["title"] &&
          finding.body === final["body"] &&
          finding.rule === final["rule"] &&
          finding.anchor.file ===
            (final["anchor"] as { file?: unknown })?.file &&
          finding.anchor.line === (final["anchor"] as { line?: unknown })?.line,
      );
      const stored =
        (duplicate ? updateFinding({ ...correction, ...(typeof correction["scope"] === "string" && correction["tags"] === undefined ? { tags: [...(duplicate.tags ?? []).filter(tag => !tag.startsWith("scope:")), `scope:${correction["scope"]}`] } : {}), id: duplicate.id, target, ...(explicitRepo ? { repo: explicitRepo } : {}) }, repo) : undefined) ??
        createFindingStored(
          {
            ...final,
            tags,
            target,
            ...(explicitRepo ? { repo: explicitRepo } : {}),
            ...(base ? { base } : {}),
            fromCandidate: id,
            verificationStatus: status,
            ...(reason ? { verificationReason: reason } : {}),
          },
          repo,
          false,
        );
      const { verificationBlock: _, ...unblocked } = stored;
      writeFinding(paths, { ...unblocked, verification: { status, ...(reason ? { reason } : {}), ...(proof ? { proof } : {}),
        ...(decision["method"] ? { method: decision["method"] as "source" | "executable" | "unverified" } : {}),
        ...(Array.isArray(args["proofs"]) ? { proofs: args["proofs"] as string[] } : {}),
        ...(Array.isArray(args["limits"]) ? { limits: args["limits"] as string[] } : {}) } });
      const updated: ReviewCandidate = {
        ...candidate,
        ...(correction as Partial<ReviewCandidate>),
        status,
        ...(reason ? { verificationReason: reason } : {}),
        findingId: stored.id,
        updatedAt: at,
      };
      writeCandidate(paths, updated);
      resolved.push({ id, status, findingId: stored.id });
      published = true;
    } catch (error) {
      errors.push({
        index,
        ...(id ? { id } : {}),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (published) publish(paths);
  return { resolved, errors };
}

/** Make stopped proof claims visible for human review without calling them verified. */
export function recordVerificationBlock(raw: unknown, repo: string): { findings: string[]; errors: string[] } {
  const args = requireObject(raw), paths = pathsOf(args, repo), reason = str(args, "reason");
  const ids = optionalArray(args, "candidates").map(String), findings = new Set<string>(), errors: string[] = [];
  for (const id of ids) {
    let candidate = readCandidate(paths, id);
    if (!candidate) { errors.push(`Unknown candidate ${id}`); continue; }
    if (candidate.status === "pending") {
      const result = resolveCandidates({ target: paths.target, repo: paths.repo, decisions: [{ id, status: "plausible", reason: `Unverified: verification was blocked. ${reason}` }] }, paths.repo);
      errors.push(...result.errors.map(error => error.message));
      candidate = readCandidate(paths, id)!;
    }
    if (!candidate.findingId) continue; // A previously deduplicated/refuted alias stays calibration evidence.
    const finding = mustFind(paths, candidate.findingId);
    writeFinding(paths, { ...finding, verificationBlock: { reason, at: now(), candidates: ids }, ...(finding.verification?.status === "plausible" ? { verification: { status: "plausible", reason: `Unverified: verification was blocked. ${reason}` } } : {}) });
    findings.add(finding.id);
  }
  if (findings.size) publish(paths);
  return { findings: [...findings], errors };
}

/**
 * How many ids to try before giving up.
 *
 * Every attempt loses only to a finding written since the last one, so more
 * than a couple means something other than a race, and a loop that never ends
 * is worse than an error that says what happened.
 */
const CLAIM_ATTEMPTS = 25;

/** Takes the next free id, retrying whoever else took it first. */
function claim(
  paths: TargetPaths,
  letter: string,
  draft: (id: string) => Finding,
): Finding {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const finding = draft(allocateFindingId(paths, letter));
    if (claimFinding(paths, finding)) return finding;
  }
  throw new InputError(
    `could not take an id for a new "${letter}" finding after ${CLAIM_ATTEMPTS} tries. Something else is writing to this target as fast as this is.`,
  );
}

/** Adds another place to a finding that turned out to be about more. */
export function addLocation(raw: unknown, repo: string): NoticedFinding {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  const finding = mustFind(paths, str(args, "id"));
  const [location] = relatedFrom(
    { related: [args] },
    paths.repo,
    readMeta(paths).base,
  );
  if (!location) throw new InputError('"file" and "line" are required.');
  const updated: Finding = {
    ...finding,
    related: [...(finding.related ?? []), location],
  };
  // The judgement behind the tag was "no marked line is the author's own
  // edit". An authored line arriving is exactly the evidence that overturns
  // it, so the tag comes off the same way it went on — by the server, said
  // out loud rather than done silently.
  let notice: string | undefined;
  if (
    location.authorship === "changed" &&
    (finding.tags ?? []).includes(PRE_EXISTING_TAG)
  ) {
    const kept = (finding.tags ?? []).filter(
      (each) => each !== PRE_EXISTING_TAG,
    );
    if (kept.length > 0) updated.tags = kept;
    else delete updated.tags;
    notice = `The added location is the author's own edit, so the "${PRE_EXISTING_TAG}" tag came off: the finding concerns the change after all.`;
  }
  writeFinding(paths, updated);
  publish(paths);
  return notice ? { ...updated, notice } : updated;
}

/**
 * Correcting a finding that was written wrong.
 *
 * Everything else on this server appends. A finding could be accepted,
 * dismissed, resolved, given a note and given more locations, but the words
 * it was created with were final, and `create_finding` refuses a second
 * finding on the same rule and line. So an agent that mistyped a title, put
 * the anchor on the wrong line, or argued from something it then found to be
 * untrue had nothing it could do about it, and nothing it could do instead.
 *
 * Only the fields the writer authored. The verdict and the resolution are
 * decisions with their own tools and their own checks; the note belongs to
 * Pascal; the id is identity. Moving the anchor recomputes what was derived
 * from it, because a fingerprint left over from the old line is what makes a
 * later `baseline_check` report a finding that never went away.
 *
 * The edit is recorded rather than gated. Blocking a correction because a
 * human already ruled on the finding leaves the wrong text in front of
 * whoever fixes it, which is worse than a history that says the words moved
 * after the verdict landed.
 */
export function updateFinding(raw: unknown, repo: string): NoticedFinding {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  const finding = mustFind(paths, str(args, "id"));

  const changed: string[] = [];
  const take = <T,>(field: string, given: T | undefined, current: T): T => {
    if (given === undefined || given === current) return current;
    changed.push(field);
    return given;
  };

  const evidence = take(
    "evidence",
    optionalOneOf(args, "evidence", EVIDENCE),
    finding.evidence,
  );
  const provenTest = take(
    "provenTest",
    optionalStr(args, "provenTest"),
    finding.provenTest,
  );
  if (evidence === "Proven" && !provenTest) {
    throw new InputError(
      'evidence "Proven" requires "provenTest" as "file:line" of the failing test. Use "Reasoned" when no test exists.',
    );
  }
  const rule = take("rule", optionalStr(args, "rule"), finding.rule);
  const title = take("title", optionalStr(args, "title"), finding.title);
  const body = take("body", optionalStr(args, "body"), finding.body);
  const priority = take(
    "priority",
    optionalOneOf(args, "priority", PRIORITY),
    finding.priority,
  );
  // All of them or none: tags are a set, and merging a correction into what is
  // already there leaves no way to take one off.
  const tags = take(
    "tags",
    args["tags"] === undefined ? undefined : tagsFrom(args),
    finding.tags,
  );

  // The anchor is all or nothing: a line without its file is a line in
  // whichever file the finding used to be about, which is how a correction
  // becomes a worse mistake than the one it was fixing.
  const moved = args["anchor"] === undefined ? null : object(args, "anchor");
  const anchored = moved
    ? anchorOf(moved, paths, rule, finding)
    : {
        anchor: finding.anchor,
        snippet: finding.snippet,
        fingerprint: finding.fingerprint,
      };
  if (moved) changed.push("anchor");

  if (changed.length === 0) return finding;

  const captured = moved
    ? anchored.anchor.kind === "metadata" ? { context: { start: 1, lines: anchored.anchor.text!.split("\n") }, diff: undefined, authorship: undefined } : captureAt(
        paths.repo,
        anchored.anchor.file,
        spanOf(moved),
        readMeta(paths).base,
      )
    : {
        ...(finding.context ? { context: finding.context } : {}),
        ...(finding.diff ? { diff: finding.diff } : {}),
      };

  const updated: Finding = {
    ...finding,
    title,
    body,
    evidence,
    priority,
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(rule ? { rule } : {}),
    ...(provenTest ? { provenTest } : {}),
    anchor: anchored.anchor,
    snippet: anchored.snippet,
    fingerprint: anchored.fingerprint,
    ...captured,
    history: [
      ...finding.history,
      {
        at: now(),
        actor: optionalOneOf(args, "actor", ACTOR) ?? "review",
        edited: [...new Set(changed)].sort(),
      },
    ],
  };

  // A re-capture that produced no view must not leave the old anchor's
  // standing: after a move, an absent key is an absent fact about the new
  // anchor, not an unchanged one about the old.
  if (moved) {
    if (!("context" in captured)) delete updated.context;
    if (!("diff" in captured)) delete updated.diff;
    if (!("authorship" in captured)) delete updated.authorship;
  }

  // Re-anchoring is the way out the create-time notice recommends, so the
  // judgement runs again over the new anchor and the locations that stayed:
  // the tag follows the evidence in both directions, said out loud each time.
  let notice: string | undefined;
  if (moved) {
    const concerns = concernsChange([
      updated.authorship,
      ...(updated.related ?? []).map((each) => each.authorship),
    ]);
    const worn = updated.tags ?? [];
    if (concerns === true && worn.includes(PRE_EXISTING_TAG)) {
      const kept = worn.filter((each) => each !== PRE_EXISTING_TAG);
      if (kept.length > 0) updated.tags = kept;
      else delete updated.tags;
      notice = `The new anchor is the author's own edit, so the "${PRE_EXISTING_TAG}" tag came off: the finding concerns the change after all.`;
    } else if (concerns === false) {
      const tagged = !worn.includes(PRE_EXISTING_TAG) && worn.length < MAX_TAGS;
      if (tagged) updated.tags = [...worn, PRE_EXISTING_TAG];
      notice = noticeFor(
        updated.authorship,
        true,
        tagged || worn.includes(PRE_EXISTING_TAG),
      );
    }
  }

  writeFinding(paths, updated);
  publish(paths);
  return notice ? { ...updated, notice } : updated;
}

/** The anchor a correction moves to, with everything derived from it. */
function anchorOf(
  moved: Record<string, unknown>,
  paths: TargetPaths,
  rule: string | undefined,
  finding: Finding,
): { anchor: Finding["anchor"]; snippet: string; fingerprint: string } {
  const metadata = metadataAnchor(moved);
  const file = metadata ? str(moved, "file") : repoRelative(paths.repo, str(moved, "file"));
  const span = spanOf(moved);
  const snippet = metadata ? metadata.text.split("\n")[span.line - 1]! : snippetAt(paths.repo, file, span.line);
  return {
    anchor: {
      ...metadata,
      file,
      ...span,
      commit: optionalStr(moved, "commit") ?? finding.anchor.commit,
    },
    snippet,
    fingerprint: fingerprintOf(rule, file, snippet),
  };
}

/** Metadata has real identity and quoted content, never a fabricated code line. */
function metadataAnchor(anchor: Record<string, unknown>): { kind: "metadata"; subject: "pr-title" | "pr-body" | "commit-message"; text: string } | undefined {
  if (anchor["kind"] === undefined) return undefined;
  if (anchor["kind"] !== "metadata") throw new InputError("Unknown anchor kind");
  const subject = oneOf(anchor, "subject", ["pr-title", "pr-body", "commit-message"] as const);
  const original = str(anchor, "text");
  let url: URL;
  try { url = new URL(str(anchor, "file")); } catch { throw new InputError("Metadata anchor file must be an authoritative HTTP(S) URL"); }
  if (!["https:", "http:"].includes(url.protocol)) throw new InputError("Metadata anchor requires an HTTP(S) URL");
  const span = spanOf(anchor);
  if ((span.endLine ?? span.line) > original.split("\n").length) throw new InputError("Metadata anchor line is outside its original text");
  return { kind: "metadata", subject, text: original };
}

/** Which of the three the panel is showing. See readSource. */
export const SOURCE_VIEW = ["new", "old", "diff"] as const;
export type SourceView = (typeof SOURCE_VIEW)[number];

export interface SourceFile {
  path: string;
  /** The commit the content came from, or "working tree". */
  ref: string;
  lines: string[];
  /** Which view these lines are. Absent means "new", for older callers. */
  view?: SourceView;
  /**
   * What the change is measured against, when the target remembers a base.
   * The page needs it to know whether there is an old version to offer at
   * all: a review run without a base has one version of everything.
   */
  base?: string;
}

/**
 * A whole file, for the reader who wants more than the lines around a finding.
 *
 * Three views of it, because a reviewer asks three different questions of the
 * same file: what does this say now, what did it say before, and what did the
 * author do to it. The old and the diff need a base, so they are offered only
 * when the target remembers one.
 *
 * The only read this server does outside its own review directories, so it is
 * also the only place a path from a browser turns into a path on disk. Three
 * things hold: the repository has to be one the server already knows, the
 * resolved path has to stay inside it after symlinks, and the file has to be
 * small enough to be a source file rather than an artifact.
 */
export function readSource(raw: unknown, repo: string): SourceFile {
  const args = requireObject(raw);
  const root = repoOf(args, repo);
  const known =
    root === repo || readRegistry().repos.some((entry) => entry.path === root);
  if (!known) {
    throw new InputError(
      `${root} is not a repository this server has findings for.`,
    );
  }

  const path = str(args, "path");
  if (/^https?:\/\//.test(path)) {
    const target = str(args, "target");
    const finding = readFindings(targetPaths(root, target)).find(each => each.anchor.kind === "metadata" && each.anchor.file === path);
    if (!finding) throw new InputError("No saved metadata at this URL in this target");
    return { path, ref: finding.anchor.subject!, lines: finding.anchor.text!.split("\n") };
  }
  const full = resolve(root, path);
  // Two forms of the root, because /var is a symlink on macOS and a repository
  // reached through one would otherwise fail its own containment check. The
  // resolved path is checked as well, so a symlink inside the repository
  // cannot point out of it. A file that does not exist resolves to itself and
  // fails later with a better message than this one.
  const roots = [root, realOf(root)];
  const contained = (candidate: string): boolean =>
    roots.some(
      (base) => candidate === base || candidate.startsWith(base + sep),
    );
  if (!contained(full) || !contained(realOf(full))) {
    throw new InputError(`${path} is outside ${root}.`);
  }

  // The base belongs to the target, so asking for anything but the current
  // file means saying which review is asking.
  const target = optionalStr(args, "target");
  const base = target
    ? readMeta(targetPaths(root, target)).base
    : optionalStr(args, "base");
  const view = optionalOneOf(args, "view", SOURCE_VIEW) ?? "new";
  const inside = relative(root, full);

  if (view !== "new") {
    if (!base) {
      throw new InputError(
        `this review has no base, so there is only one version of ${path}. Pass "base" on the first finding of a run to get the other two.`,
      );
    }
    const lines =
      view === "old"
        ? showAt(root, `${base.split("..")[0]}`, inside)
        : fileDiff(root, base, inside);
    if (lines === undefined) {
      throw new InputError(
        view === "old"
          ? `${path} does not exist at ${base}. It is new in this change.`
          : `git could not diff ${path} against ${base}.`,
      );
    }
    return { path, ref: base, view, base, lines: lines.split(/\r?\n/) };
  }

  const ref = optionalStr(args, "ref");
  const fromGit = ref ? showAt(root, ref, inside) : undefined;
  if (ref && fromGit !== undefined) {
    return {
      path,
      ref,
      view,
      ...(base ? { base } : {}),
      lines: fromGit.split(/\r?\n/),
    };
  }

  const stats = statSync(full, { throwIfNoEntry: false });
  if (!stats?.isFile()) throw new InputError(`no file ${path} in ${root}.`);
  if (stats.size > MAX_SOURCE_BYTES) {
    throw new InputError(
      `${path} is ${Math.round(stats.size / 1024)} kB, too big to show as source.`,
    );
  }
  return {
    path,
    ref: "working tree",
    view,
    ...(base ? { base } : {}),
    lines: readFileSync(full, "utf8").split(/\r?\n/),
  };
}

/** A source file no reader wants past this. Also what keeps the UI alive. */
const MAX_SOURCE_BYTES = 2_000_000;

function realOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The file as some commit had it, or nothing if that commit does not. */
function showAt(root: string, ref: string, path: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: MAX_SOURCE_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/**
 * The whole file's diff against the base, not just the hunks near a finding.
 *
 * The same range the review compares, so a base branch that moved on since
 * the work started does not turn up here as somebody else's changes.
 *
 * An empty answer is kept as an empty answer: a file the change never touched
 * diffs to nothing, and saying so is better than an error that reads as the
 * diff having failed.
 */
function fileDiff(
  root: string,
  base: string,
  path: string,
): string | undefined {
  const range = base.includes("..") ? base : `${base}...HEAD`;
  try {
    return execFileSync("git", ["diff", range, "--", path], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: MAX_SOURCE_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/**
 * What the server generates and therefore does not offer as a document.
 *
 * Everything else in a target directory was written by the review: the level
 * documents, the README, the problem statement, the solutions a sub-agent
 * produced, whatever was attached. Listing by exclusion rather than by a
 * pattern is what keeps a document the skill invents tomorrow visible without
 * anyone teaching this file about it.
 */
const GENERATED = new Set([
  "findings",
  "observations",
  "target.json",
  "review.html",
  "findings.sarif",
  "seen.json",
  "follow.json",
]);

export interface DocumentEntry {
  /** Relative to the target directory, e.g. "Level-1/solution-2.md". */
  path: string;
  bytes: number;
  /** ISO timestamp of the last write. */
  changed: string;
}

/** Level-2 before Level-10, and the README before either. */
function byDocument(a: string, b: string): number {
  const first = (path: string): number =>
    path.toLowerCase().startsWith("readme") ? 0 : 1;
  return (
    first(a) - first(b) ||
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
  );
}

export function listDocuments(raw: unknown, repo: string): DocumentEntry[] {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  const found: DocumentEntry[] = [];

  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (prefix === "" && GENERATED.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      const stats = statSync(full, { throwIfNoEntry: false });
      if (!stats) continue;
      found.push({
        path: relative,
        bytes: stats.size,
        changed: stats.mtime.toISOString(),
      });
    }
  };

  if (existsSync(paths.dir)) walk(paths.dir, "");
  return found.sort((a, b) => byDocument(a.path, b.path));
}

export interface ReviewDocument {
  path: string;
  bytes: number;
  /** Absent when the file is not text. */
  text?: string;
  binary?: boolean;
}

/**
 * One document the review wrote.
 *
 * Confined to the target directory, and read as text only when it is text:
 * a level document can have a PDF next to it, and handing a browser a
 * megabyte of binary as a string helps nobody.
 */
export function readDocument(raw: unknown, repo: string): ReviewDocument {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  const full = documentPath(paths, str(args, "path"));

  const stats = statSync(full, { throwIfNoEntry: false });
  if (!stats?.isFile()) {
    throw new InputError(
      `no document "${str(args, "path")}" in target "${paths.target}".`,
    );
  }
  if (stats.size > MAX_SOURCE_BYTES) {
    throw new InputError(
      `${str(args, "path")} is ${Math.round(stats.size / 1024)} kB, too big to show.`,
    );
  }

  const bytes = readFileSync(full);
  // A NUL in the first stretch of a file is the oldest test there is, and it
  // beats an extension list that a new kind of attachment falls off.
  if (bytes.subarray(0, 8000).includes(0)) {
    return { path: str(args, "path"), bytes: stats.size, binary: true };
  }
  return {
    path: str(args, "path"),
    bytes: stats.size,
    text: bytes.toString("utf8"),
  };
}

/** The one place a document path from a browser becomes a path on disk. */
export function documentPath(paths: TargetPaths, path: string): string {
  const full = resolve(paths.dir, path);
  const root = realOf(paths.dir);
  const inside = (candidate: string): boolean =>
    candidate.startsWith(paths.dir + sep) || candidate.startsWith(root + sep);
  if (!inside(full) || !inside(realOf(full))) {
    throw new InputError(`${path} is outside the review directory.`);
  }
  const [top] = relative(paths.dir, full).split(sep);
  if (top && GENERATED.has(top)) {
    throw new InputError(`${path} is generated, not a review document.`);
  }
  return full;
}

/**
 * A finding with the captured code taken back out of it.
 *
 * Measured on a real review of 24 findings: the whole list is 25k tokens, and
 * the captured source and diffs are two thirds of that. That is a response no
 * host hands over intact, so the list arrives truncated and the reader falls
 * back to fetching findings one at a time — more calls, from the call that was
 * supposed to save them.
 *
 * Only what can be asked for again is dropped: `context` and `diff`, here and
 * on every related location. Both are optional on a finding already, so what
 * comes back is a finding with less in it rather than a different shape.
 *
 * The related locations themselves stay. "the other writer, line 118" is the
 * part that carries the argument; the lines captured around it are not.
 */
function withoutCode(finding: Finding): Finding {
  const { context, diff, ...rest } = finding;
  return {
    ...rest,
    ...(rest.related
      ? {
          related: rest.related.map(
            ({ context: at, diff: hunk, ...place }) => place,
          ),
        }
      : {}),
  };
}

/**
 * The findings of a target, filtered.
 *
 * The captured code is left out unless `code` asks for it. The browser asks,
 * because it is rendering the code and has no context window to spend; an
 * agent should filter first and ask for code on the handful it is about to
 * act on.
 */
export function listFindings(raw: unknown, repo: string): FindingList[] {
  const args = requireObject(raw);
  const root = repoOf(args, repo);
  const target = optionalStr(args, "target");
  const verdict = optionalOneOf(args, "verdict", VERDICT);
  const resolution = optionalOneOf(args, "resolution", RESOLUTION);
  const priority = optionalOneOf(args, "priority", PRIORITY);
  const tag = optionalStr(args, "tag")?.trim().toLowerCase();
  const code = flag(args, "code");
  const targets = target
    ? [targetPaths(root, target).target]
    : listTargets(join(root, REVIEW_DIR));

  return targets.map((name) => {
    const paths = targetPaths(root, name);
    const findings = readFindings(paths)
      .filter((finding) => !verdict || finding.verdict === verdict)
      .filter((finding) => !resolution || finding.resolution === resolution)
      .filter((finding) => !priority || finding.priority === priority)
      .filter((finding) => !tag || (finding.tags ?? []).includes(tag))
      .map((finding) => (code ? finding : withoutCode(finding)));
    return {
      target: paths.target,
      findings,
      seen: readSeen(paths),
      follow: readFollow(paths),
    };
  });
}

/**
 * Records that Pascal has read these findings, or that he has not.
 *
 * Only the triage page calls this, and only about the row it is showing. There
 * is deliberately no tool for it: what an agent has read is not interesting,
 * and an agent that could mark findings read could empty the queue's one signal
 * for which of them are new.
 *
 * `read: false` puts one back, which is the only way out of a queue that would
 * otherwise be emptied by looking at it.
 */
export function markFindingsSeen(raw: unknown, repo: string): SeenMap {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  const ids = optionalArray(args, "ids").map(String);
  for (const id of ids) mustFind(paths, id);
  // Absent means read, because that is what every existing caller means by it.
  const read = args["read"] === undefined ? true : flag(args, "read");
  return markSeen(paths, ids, read ? now() : null);
}

/**
 * Marks findings to come back to, or takes the mark off.
 *
 * The page's own, like the read receipts beside it: nothing an agent does
 * should decide what a person is not finished thinking about, which is why
 * there is no tool of this name either.
 */
export function markFindingsFollowed(raw: unknown, repo: string): SeenMap {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  const ids = optionalArray(args, "ids").map(String);
  for (const id of ids) mustFind(paths, id);
  const on = args["follow"] === undefined ? true : flag(args, "follow");
  return markFollow(paths, ids, on ? now() : null);
}

export function getFinding(raw: unknown, repo: string): Finding {
  const args = requireObject(raw);
  return mustFind(pathsOf(args, repo), str(args, "id"));
}

/** What Pascal decided about a finding. Nobody else may call this. */
export function setVerdict(raw: unknown, repo: string): Finding {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  const finding = mustFind(paths, str(args, "id"));
  const to = oneOf(args, "to", VERDICT) as Verdict;
  const actor = oneOf(args, "actor", ACTOR) as Actor;

  checkVerdict(finding.verdict, to, actor);

  const note = optionalStr(args, "note");
  const updated: Finding = {
    ...finding,
    verdict: to,
    history: [
      ...finding.history,
      {
        at: now(),
        actor,
        verdict: to,
        ...(note ? { note } : {}),
      },
    ],
  };
  writeFinding(paths, updated);
  publish(paths);
  return updated;
}

/**
 * Whether the code still has the problem.
 *
 * Free of the verdict on purpose: work happens for reasons that have nothing
 * to do with this review, and a finding that quietly stopped being true is
 * worth recording whether or not anyone ever ruled on it.
 *
 * An agent has to name the commit, because an agent claiming a fix with
 * nothing to point at is how a review directory fills up with lies. A human
 * saying they fixed it is taken at their word.
 */
export function setResolution(raw: unknown, repo: string): Finding {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  const finding = mustFind(paths, str(args, "id"));
  const to = oneOf(args, "to", RESOLUTION) as Resolution;
  const actor = oneOf(args, "actor", ACTOR) as Actor;

  checkResolution(finding.resolution, to, actor);

  const commit = optionalStr(args, "commit");
  if (to === "resolved" && actor === "agent" && !commit) {
    throw new InputError(
      'resolving a finding as an agent needs "commit", the SHA of the commit that fixes it.',
    );
  }

  const note = optionalStr(args, "note");
  const updated: Finding = {
    ...finding,
    resolution: to,
    history: [
      ...finding.history,
      {
        at: now(),
        actor,
        resolution: to,
        ...(note ? { note } : {}),
        ...(commit ? { commit } : {}),
      },
    ],
    links: { ...finding.links, ...(commit ? { fixCommit: commit } : {}) },
  };
  // A claim is only confirmed by a review run that cannot find it, so any
  // move on this axis takes the confirmation with it.
  delete updated.confirmedAt;
  writeFinding(paths, updated);
  publish(paths);
  return updated;
}

/** A note long enough to be a document is a finding of its own. */
const MAX_NOTE = 20_000;

/**
 * Writes the human's note on a finding.
 *
 * No transition, no history entry, no actor: a note is thinking out loud, and
 * it happens while reading rather than at the moment of a decision. The triage
 * UI calls this as the text is typed, so it has to be cheap and it has to
 * accept the empty string, which is the only way to take a note back.
 */
export function setNote(raw: unknown, repo: string): Finding {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  const finding = mustFind(paths, str(args, "id"));
  const note = text(args, "note").trim();
  if (note.length > MAX_NOTE) {
    throw new InputError(
      `that note is ${note.length} characters. Keep it under ${MAX_NOTE}; anything longer is an argument that belongs in a finding of its own.`,
    );
  }

  const updated: Finding = { ...finding };
  if (note === "") {
    delete updated.note;
    delete updated.noteAt;
  } else {
    updated.note = note;
    updated.noteAt = now();
  }
  writeFinding(paths, updated);
  publish(paths);
  return updated;
}

export function linkFixCommit(raw: unknown, repo: string): Finding {
  const args = requireObject(raw);
  return setResolution(
    { ...args, to: "resolved", actor: optionalStr(args, "actor") ?? "agent" },
    repo,
  );
}

export function linkPrComment(raw: unknown, repo: string): Finding {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  const finding = mustFind(paths, str(args, "id"));
  const updated: Finding = {
    ...finding,
    // Posting the comment is reporting it, so the rung is stamped here rather
    // than left for a second call nobody would remember to make. The existing
    // stamp wins: this may be a link added to something reported days ago.
    reportedAt: finding.reportedAt ?? now(),
    links: { ...finding.links, prComment: str(args, "url") },
  };
  writeFinding(paths, updated);
  publish(paths);
  return updated;
}

/**
 * The six places a finding can be, as one move.
 *
 * The page shows the two axes and the report stamp as a single track, because
 * that is how the work actually reads: failed as invalid or tolerated, or
 * open, then agreed, told, gone. Sliding to a stop has to mean the finding is
 * *at* that stop, which is more than one field's worth of change — moving
 * back from told to agreed un-tells it, and moving right out of a failed
 * verdict takes it back.
 *
 * Composed here rather than as three calls from the browser so it is one
 * write: three calls leave the file in states nobody chose if the second one
 * fails, and each would publish a report of a half-moved finding.
 */
const STAGES = [
  "invalid",
  "tolerated",
  "open",
  "accepted",
  "reported",
  "fixed",
] as const;

export function setStage(raw: unknown, repo: string): Finding {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  const finding = mustFind(paths, str(args, "id"));
  const to = oneOf(args, "to", STAGES);
  const actor = oneOf(args, "actor", ACTOR) as Actor;

  // Sliding right out of a failed verdict takes it back: every stop from
  // "open" on describes a finding somebody is still working on. The two
  // right-hand stops otherwise leave the verdict alone, because accepting is
  // optional and a fix does not need anyone's agreement to have happened.
  const failed =
    finding.verdict === "invalid" || finding.verdict === "tolerated";
  const back = failed ? "undecided" : null;
  const verdict: Verdict =
    to === "invalid"
      ? "invalid"
      : to === "tolerated"
        ? "tolerated"
        : to === "open"
          ? "undecided"
          : to === "accepted"
            ? "accepted"
            : (back ?? finding.verdict);
  const resolution: Resolution = to === "fixed" ? "resolved" : "unresolved";
  // A failed finding keeps the fact that it went out: it did, and the stamp
  // is history rather than a claim about where it stands now.
  const reported =
    to === "reported" ||
    to === "fixed" ||
    to === "invalid" ||
    to === "tolerated"
      ? (finding.reportedAt ?? (to === "reported" ? now() : undefined))
      : undefined;

  const at = now();
  const history = [...finding.history];
  if (verdict !== finding.verdict) {
    checkVerdict(finding.verdict, verdict, actor);
    history.push({ at, actor, verdict });
  }
  if (resolution !== finding.resolution) {
    checkResolution(finding.resolution, resolution, actor);
    history.push({ at, actor, resolution });
  }

  const updated: Finding = { ...finding, verdict, resolution, history };
  if (reported) updated.reportedAt = reported;
  else delete updated.reportedAt;
  writeFinding(paths, updated);
  publish(paths);
  return updated;
}

/**
 * Whether the author has been told, said plainly.
 *
 * Separate from the comment link because most of the ways a finding gets
 * reported leave no URL behind. Taking it back is allowed and leaves nothing:
 * the point of the rung is where the finding stands now, and a reader who
 * un-reports one is saying it never really went out.
 */
export function setReported(raw: unknown, repo: string): Finding {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  const finding = mustFind(paths, str(args, "id"));
  // Absent means reported, because that is what every caller of this means.
  const reported =
    args["reported"] === undefined ? true : flag(args, "reported");
  const updated: Finding = { ...finding };
  if (reported) updated.reportedAt = finding.reportedAt ?? now();
  else delete updated.reportedAt;
  writeFinding(paths, updated);
  publish(paths);
  return updated;
}

export function createObservation(raw: unknown, repo: string): Observation {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  ensureTarget(paths);
  const draft = (id: string): Observation => ({
    id,
    text: str(args, "text"),
    forLevel: str(args, "forLevel"),
    status: "pending",
    createdAt: now(),
  });
  // The same race as findings, in its own sequence. See claimFinding.
  let observation: Observation | null = null;
  for (
    let attempt = 0;
    attempt < CLAIM_ATTEMPTS && !observation;
    attempt += 1
  ) {
    const next = draft(allocateObservationId(paths));
    if (claimObservation(paths, next)) observation = next;
  }
  if (!observation) {
    throw new InputError(
      `could not take an id for a new observation after ${CLAIM_ATTEMPTS} tries. Something else is writing to this target as fast as this is.`,
    );
  }
  upsertRegistry(paths.repo, paths.target, observation.createdAt);
  return observation;
}

export function listObservations(raw: unknown, repo: string): Observation[] {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  const forLevel = optionalStr(args, "forLevel");
  const status = optionalOneOf(args, "status", OBSERVATION_STATUS);
  return readObservations(paths)
    .filter((each) => !forLevel || each.forLevel === forLevel)
    .filter((each) => !status || each.status === status);
}

export function dropObservation(raw: unknown, repo: string): Observation {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  const id = str(args, "id");
  const observation = readObservation(paths, id);
  if (!observation) {
    throw new InputError(`no observation "${id}" in target "${paths.target}".`);
  }
  if (observation.status !== "pending") {
    throw new InputError(
      `observation ${id} is already ${observation.status} and cannot be dropped.`,
    );
  }
  const dropped: Observation = {
    ...observation,
    status: "dropped",
    dropReason: str(args, "reason"),
  };
  writeObservation(paths, dropped);
  return dropped;
}

export interface BaselineResult {
  target: string;
  /** Resolutions the run moved. The verdict is never one of them. */
  transitions: { id: string; from: Resolution; to: Resolution }[];
  /** Resolved, and this run agrees it is gone. */
  confirmed: string[];
  /** Unresolved, and the run found the same code again. */
  seen: string[];
  /** Unresolved, and the code underneath moved. Worth a human glance. */
  stale: string[];
}

/**
 * What a review run reports at the end: everything it found this time.
 *
 * The caller can hand over fingerprints it already knows, or the anchors it
 * found and let the server fingerprint them. The second form is the one an
 * agent can actually produce, so it is the one the tool advertises.
 */
export function baselineCheck(raw: unknown, repo: string): BaselineResult {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  const current = new Set(
    optionalArray(args, "currentFingerprints").map(String),
  );
  const saved = readFindings(paths);
  for (const id of optionalArray(args, "currentFindingIds")) {
    const finding = saved.find(each => each.id === id);
    if (!finding) throw new InputError(`Unknown current finding ${id}`);
    current.add(finding.fingerprint);
  }
  for (const entry of optionalArray(args, "current")) {
    const anchor = requireObject(entry);
    const metadata = metadataAnchor(anchor);
    const file = metadata ? str(anchor, "file") : repoRelative(paths.repo, str(anchor, "file"));
    const line = positiveInt(anchor, "line");
    current.add(
      fingerprintOf(
        optionalStr(anchor, "rule"),
        file,
        metadata ? metadata.text.split("\n")[line - 1]! : snippetAt(paths.repo, file, line),
      ),
    );
  }

  const at = now();
  const result: BaselineResult = {
    target: paths.target,
    transitions: [],
    confirmed: [],
    seen: [],
    stale: [],
  };

  for (const finding of saved) {
    // Every finding, whatever the human decided about it. A run reports on
    // the code, and the code does not care whether anyone accepted the
    // finding: a dismissed problem can still be fixed by other work. What a
    // run never touches is the verdict itself.
    const present = current.has(finding.fingerprint);
    const from = finding.resolution;

    if (from === "resolved" && !present) {
      // Someone claimed this was fixed and the run agrees. That is as close
      // to proof as this server gets.
      if (finding.confirmedAt) continue;
      writeFinding(paths, { ...finding, confirmedAt: at, lastSeen: at });
      result.confirmed.push(finding.id);
      continue;
    }
    if (from === "resolved" && present) {
      writeFinding(paths, regress(finding, at));
      result.transitions.push({ id: finding.id, from, to: "regressed" });
      continue;
    }
    // Absent does not mean gone: this run may simply not have probed that
    // area. Flag the anchor, never resolve anything on the strength of a
    // silence.
    const updated: Finding = present
      ? { ...finding, lastSeen: at, staleAnchor: false }
      : { ...finding, staleAnchor: true };
    writeFinding(paths, updated);
    (present ? result.seen : result.stale).push(finding.id);
  }

  publish(paths);
  return result;
}

function regress(finding: Finding, at: string): Finding {
  const regressed: Finding = {
    ...finding,
    resolution: "regressed",
    lastSeen: at,
    history: [
      ...finding.history,
      { at, actor: "review", resolution: "regressed" },
    ],
  };
  delete regressed.confirmedAt;
  return regressed;
}

export interface DismissedExport {
  repo: string;
  target: string;
  id: string;
  title: string;
  rule?: string;
  priority: string;
  tags?: string[];
  evidence: string;
  /** "invalid" (the review was wrong) or "tolerated" (it stands, carried). */
  verdict: string;
  /** The handbook issue an invalid finding was filed as, once it was. */
  ruleIssue?: string;
  note?: string;
  at: string;
  anchor: string;
}

/**
 * The calibration data.
 *
 * A rule that keeps collecting "invalid" has a detector problem, and each of
 * those rows owes an issue — `ruleIssue` says which have been paid. A rule
 * that keeps collecting "tolerated" is one nobody acts on, and that is the
 * evidence for suggesting it be disabled: a suggestion for a human to weigh,
 * because tolerated also covers findings that were right and carried, and
 * only a person can tell the two apart. Neither pattern is visible from a
 * single review, which is why failed findings are never deleted and why this
 * is reachable from day one rather than after someone needs it.
 */
export function exportDismissals(
  raw: unknown,
  repo: string,
): DismissedExport[] {
  const args = requireObject(raw);
  const since = optionalStr(args, "since");
  // A tool call sends a boolean, a query string sends "true". Both mean yes.
  const allRepos = args["allRepos"] === true || args["allRepos"] === "true";
  const roots = allRepos
    ? readRegistry().repos.map((entry) => entry.path)
    : [repoOf(args, repo)];

  const rows: DismissedExport[] = [];
  for (const root of roots) {
    if (!existsSync(join(root, REVIEW_DIR))) continue;
    for (const name of listTargets(join(root, REVIEW_DIR))) {
      const paths = targetPaths(root, name);
      for (const finding of readFindings(paths)) {
        if (finding.verdict !== "invalid" && finding.verdict !== "tolerated")
          continue;
        // Old files say "dismissed" in their history; the verdict on the
        // finding has been normalised, so the last verdict entry is the one.
        const entry = finding.history.findLast((each) => each.verdict);
        if (!entry) continue;
        if (since && entry.at < since) continue;
        // The note on the finding stands in when the entry carries none:
        // what a human wrote while reading is still an account of why.
        const why = entry.note ?? finding.note;
        rows.push({
          repo: root,
          target: paths.target,
          id: finding.id,
          title: finding.title,
          ...(finding.rule ? { rule: finding.rule } : {}),
          priority: finding.priority,
          ...(finding.tags ? { tags: finding.tags } : {}),
          evidence: finding.evidence,
          verdict: finding.verdict,
          ...(finding.links.ruleIssue
            ? { ruleIssue: finding.links.ruleIssue }
            : {}),
          ...(why ? { note: why } : {}),
          at: entry.at,
          anchor: `${finding.anchor.file}:${finding.anchor.line}`,
        });
      }
    }
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

export function regenerateViews(
  raw: unknown,
  repo: string,
): { target: string; html: string; sarif: string } {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  publish(paths);
  return { target: paths.target, html: paths.html, sarif: paths.sarif };
}

/**
 * Which of Pascal's rules are on for a project.
 *
 * Here rather than in the rules module because the repository a caller means
 * is resolved the same way for every tool on this server: the one it was
 * started in, unless it says otherwise.
 */
export function enabledRules(raw: unknown, repo: string): ReviewRules {
  const args = requireObject(raw);
  return reviewRules(repoOf(args, repo));
}

/** Every repo and target the UI can offer, newest review first. */
export function listRepos(): {
  path: string;
  targets: string[];
  lastReview: string;
}[] {
  return readRegistry()
    .repos.filter((entry) => existsSync(join(entry.path, REVIEW_DIR)))
    .map((entry) => ({
      ...entry,
      targets: listTargets(join(entry.path, REVIEW_DIR)),
    }))
    .sort((a, b) => b.lastReview.localeCompare(a.lastReview));
}

/**
 * Says a review exists, before it has anything to show for itself.
 *
 * Until now a review announced itself by its first finding, which is the
 * wrong moment twice over. A link to the inbox is posted when a run starts,
 * so the review it names is not there when it is first opened; and a run that
 * finds nothing never appears at all, which is indistinguishable from a run
 * that never happened.
 *
 * It also carries what Level 0 already knows and nothing else could recover:
 * which pull request this is, who opened it and when. "pr-356" identifies a
 * review, it does not say what the change is or how long the author has been
 * waiting for an answer.
 *
 * Calling it twice is how a run updates the state of the pull request, and it
 * never moves `startedAt`: whichever call came first said when this started.
 */
export function startReview(raw: unknown, repo: string): ReviewSummary {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  // The global home holds the machine-wide registry the inbox lists reviews
  // from. Pointed inside the repository under review — which has happened,
  // by an agent reading `WELLACTUALLY_FINDINGS_HOME ?? homedir()` and guessing the
  // variable meant the repo's own review directory — every finding is
  // written and none of them ever appear anywhere. Refusing loudly here
  // turns a silently invisible review into an error with the fix in it.
  if (GLOBAL_ROOT === paths.repo || GLOBAL_ROOT.startsWith(paths.repo + sep)) {
    throw new InputError(
      `WELLACTUALLY_FINDINGS_HOME points inside the repository under review (${GLOBAL_ROOT}). ` +
        `It is the machine-wide home the Review Inbox lists every repository from, ` +
        `not this repository's review directory — findings registered there are ` +
        `invisible to the inbox. Unset it and let it default to ~/.well-actually.`,
    );
  }
  ensureTarget(paths);
  const meta = readMeta(paths);
  const base = optionalStr(args, "base") ?? meta.base;
  const pr = prFrom(args);
  const startedAt = meta.startedAt ?? now();
  writeMeta(paths, {
    ...meta,
    ...(base ? { base } : {}),
    startedAt,
    ...(pr || meta.pr ? { pr: { ...meta.pr, ...pr } } : {}),
  });
  // What actually puts it in the inbox: the UI reads the machine-wide
  // registry, because an MCP server only knows the repository it started in.
  upsertRegistry(paths.repo, paths.target, now());
  return summarise(paths, now());
}

/** A run that has written nothing for this long has stopped, not paused. */
const QUIET_AFTER_MS = 30 * 60 * 1000;

/** Longer than this from start to now is a second run, not a long first one. */
const ONE_RUN_MS = 12 * 60 * 60 * 1000;

/** The level documents a run has written, read off the target directory. */
function levelDocuments(paths: TargetPaths): LevelDocument[] {
  if (!existsSync(paths.dir)) return [];
  const found: LevelDocument[] = [];
  for (const entry of readdirSync(paths.dir, { withFileTypes: true })) {
    const level = /^Level-(\d+)\.md$/i.exec(entry.name)?.[1];
    if (!entry.isFile() || level === undefined) continue;
    const full = join(paths.dir, entry.name);
    const stats = statSync(full, { throwIfNoEntry: false });
    if (!stats) continue;
    found.push({
      n: Number(level),
      changed: stats.mtime.toISOString(),
      text: readFileSync(full, "utf8"),
    });
  }
  return found;
}

/** A review's name in a link: stable, and telling nothing about the path. */
function linkIdOf(repo: string, target: string): string {
  return createHash("sha256")
    .update(`${repo}\0${target}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Where /open/<id> leads: the inbox page of the review that id names, or
 * null for an id no registered review has.
 */
export function inboxUrlForLink(id: string, finding?: string): string | null {
  const review = listReviews().find(
    (each) => linkIdOf(each.repo, each.target) === id,
  );
  if (!review) return null;
  return inboxUrl(targetPaths(review.repo, review.target), finding);
}

/** Where the Review Inbox shows a review, or one finding of it. */
function inboxUrl(paths: TargetPaths, finding?: string): string {
  const url = `http://127.0.0.1:${String(UI_PORT)}/?repo=${encodeURIComponent(paths.repo)}&target=${encodeURIComponent(paths.target)}`;
  return finding ? `${url}&finding=${encodeURIComponent(finding)}` : url;
}

/**
 * Opens a review in the Review Inbox, in the browser of this machine.
 *
 * The card's Inbox button. A host opens only https links and the inbox is
 * http on loopback, so the server opens it. The URL is built here from the
 * review's names, never taken from the caller: a request that could name any
 * URL would let whoever sends it open anything on this machine.
 *
 * `rule` opens the rule's own page instead, which is the card's answer to the
 * one thing it could not do: a finding cites PW-G007 and nothing in the card
 * could say what PW-G007 is. The id is looked up before it is used, so what
 * is opened is a rule this server knows and not whatever the caller typed.
 */
export function openInbox(raw: unknown, repo: string): { opened: string } {
  const args = requireObject(raw);
  const rule = typeof args["rule"] === "string" ? args["rule"].trim() : "";
  if (rule !== "") {
    const known = readRule(rule.toUpperCase());
    if (!known) {
      throw new InputError(
        `no rule ${rule}. list_rules gives the ones this project checks.`,
      );
    }
    const url = `http://127.0.0.1:${String(UI_PORT)}/rule/${encodeURIComponent(known.id)}`;
    openInBrowser(url);
    return { opened: url };
  }
  const paths = pathsOf(args, repo);
  if (!existsSync(paths.dir)) {
    throw new InputError(
      `no review "${paths.target}" in ${paths.repo}. start_review creates one; list the ones that exist in the Review Inbox.`,
    );
  }
  const finding = typeof args["finding"] === "string" ? args["finding"] : "";
  if (finding !== "") mustFind(paths, finding);
  const url = inboxUrl(paths, finding || undefined);
  openInBrowser(url);
  return { opened: url };
}

/**
 * Where a review stands, for the card a host draws in the conversation.
 *
 * One answer rather than the inbox's three routes, because the card has one
 * tool call to ask with. Findings come without their history, their hunk and
 * their related places: the card shows a finding's own lines and its
 * argument, and the inbox is one press away for the rest.
 */
export function reviewStatus(raw: unknown, repo: string): ReviewStatus {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  if (!existsSync(paths.dir)) {
    throw new InputError(
      `no review "${paths.target}" in ${paths.repo}. start_review creates one; list the ones that exist in the Review Inbox.`,
    );
  }
  // Told when the review started rather than now: with no finding written
  // yet that is the last thing known to have happened, and "now" would make
  // an abandoned run look busy for ever.
  const summary = summarise(paths, readMeta(paths).startedAt ?? now());
  const documents = levelDocuments(paths);
  const readme = statSync(join(paths.dir, "README.md"), {
    throwIfNoEntry: false,
  });
  const activity = reviewActivity(paths);
  const candidates = readCandidates(paths).filter(candidate => candidate.status === "pending");
  const finished = readme !== undefined || Boolean(activity?.complete && candidates.length === 0);
  const at = now();

  // The findings' own writes are in the summary; a level document is a write
  // too, and for long stretches of a run it is the only one.
  const lastAt = [
    summary.lastAt,
    ...(activity ? [activity.updatedAt] : []),
    ...candidates.map(candidate => candidate.updatedAt),
    ...documents.map((doc) => doc.changed),
    ...(readme ? [readme.mtime.toISOString()] : []),
  ]
    .sort()
    .pop() as string;
  const state: ReviewState = finished
    ? "done"
    : Date.parse(at) - Date.parse(lastAt) > QUIET_AFTER_MS
      ? "quiet"
      : "running";

  const until = state === "running" ? at : lastAt;
  const elapsedMs = Date.parse(until) - Date.parse(summary.startedAt);

  const findings = readFindings(paths)
    .map((finding) => {
      const slim: Finding = { ...finding, history: [] };
      delete slim.diff;
      delete slim.related;
      return slim;
    })
    .sort(
      (a, b) =>
        a.priority.localeCompare(b.priority) ||
        a.createdAt.localeCompare(b.createdAt),
    );

  return {
    repo: summary.repo,
    repoName: summary.repoName,
    target: summary.target,
    ...(summary.title ? { title: summary.title } : {}),
    url: inboxUrl(paths),
    link: `http://127.0.0.1:${String(UI_PORT)}/open/${linkIdOf(paths.repo, paths.target)}`,
    state,
    ...(activity ? { phase: activity.phase } : {}),
    candidates,
    startedAt: summary.startedAt,
    lastAt,
    ...(elapsedMs >= 0 && elapsedMs <= ONE_RUN_MS ? { elapsedMs } : {}),
    ...(summary.pr ? { pr: summary.pr } : {}),
    ...(summary.verdict ? { verdict: summary.verdict } : {}),
    // A review that finished without one level document was never run level
    // by level, and six skipped levels would be six things that never were.
    levels:
      activity || (finished && documents.length === 0)
        ? []
        : levelsOf({
            startedAt: summary.startedAt,
            documents,
            finished,
            now: at,
          }),
    findings,
  };
}

/**
 * Sends a finding back to the rules it came from, as a report about the rule.
 *
 * Two calls on purpose. The first assembles the whole thing and hands it back
 * unsent; the second is given that same text and files it. The scrubber in
 * between is three heuristics, and a heuristic is not a confidentiality
 * policy — the policy is that a person reads what is about to be published,
 * and the shape of this tool is what makes that unavoidable rather than
 * advisable.
 */
export async function reportFinding(
  raw: unknown,
  repo: string,
): Promise<{
  filed: string | null;
  title: string;
  body: string;
  took: { masked: number; kinds: string[] };
  says: string;
}> {
  const args = requireObject(raw);
  const paths = pathsOf(args, repo);
  const id = str(args, "id");
  const complaint = oneOf(
    args,
    "complaint",
    Object.keys(COMPLAINTS) as Complaint[],
  );
  const why = text(args, "why");
  if (why.trim().length < 12) {
    throw new InputError(
      '"why" is the whole of what makes this worth filing: say what the rule got wrong about this code, in a sentence somebody who cannot see the code will understand.',
    );
  }

  const report = prepare(paths, id, complaint, why);
  // A boolean over MCP, a string over the query bridge. Both mean yes.
  const send = args["confirm"] === true || args["confirm"] === "true";
  if (!send) {
    return {
      filed: null,
      ...report,
      says: `Nothing has been sent. Read the body above — every word of it will be public on ${HOME} — and call this again with confirm: true to file it. The scrubber replaced ${String(report.took.masked)} name${report.took.masked === 1 ? "" : "s"}; it cannot know which of the rest are a client's.`,
    };
  }

  const url = await fileIssue(report.title, report.body);
  // The issue is what an invalid verdict owes, so the link lands on the
  // finding the way a fix commit does: it is the stamp the debt was paid,
  // and the reason the same misfire is never filed twice.
  const finding = mustFind(paths, id);
  writeFinding(paths, {
    ...finding,
    links: { ...finding.links, ruleIssue: url },
  });
  publish(paths);
  return { filed: url, ...report, says: `Filed at ${url}` };
}

/** The pull request fields of a `start_review` call, all of them optional. */
function prFrom(args: Record<string, unknown>): ReviewPr | null {
  if (args["pr"] === undefined) return null;
  const given = object(args, "pr");
  const pr: ReviewPr = {
    ...(given["number"] === undefined
      ? {}
      : { number: positiveInt(given, "number") }),
    ...pick(
      given,
      "url",
      "title",
      "author",
      "state",
      "headBranch",
      "baseBranch",
    ),
  };
  const openedAt = dateFrom(given, "openedAt");
  if (openedAt) pr.openedAt = openedAt;
  const mergedAt = dateFrom(given, "mergedAt");
  if (mergedAt) pr.mergedAt = mergedAt;
  return pr;
}

/** One of the pull request's timestamps, normalised, or nothing. */
function dateFrom(
  given: Record<string, unknown>,
  field: "openedAt" | "mergedAt",
): string | null {
  const raw = optionalStr(given, field);
  if (!raw) return null;
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) {
    throw new InputError(
      `"${field}" must be a date, got "${raw}". GitHub gives it as "2026-08-12T09:14:03Z".`,
    );
  }
  return when.toISOString();
}

function pick(
  given: Record<string, unknown>,
  ...fields: (keyof ReviewPr)[]
): ReviewPr {
  const taken: ReviewPr = {};
  for (const field of fields) {
    const value = optionalStr(given, field);
    if (value) Object.assign(taken, { [field]: value });
  }
  return taken;
}

/**
 * Every review on this machine, with enough of each to choose between them.
 *
 * Reads every finding of every target to count them, which is a few hundred
 * small files at the size this has ever been. Worth watching if a repository
 * ever accumulates hundreds of reviews; not worth a cache before then, since
 * a stale count in the inbox is exactly the failure this list exists to
 * prevent.
 */
export function listReviews(): ReviewSummary[] {
  const reviews: ReviewSummary[] = [];
  for (const entry of readRegistry().repos) {
    const reviewDir = join(entry.path, REVIEW_DIR);
    if (!existsSync(reviewDir)) continue;
    for (const target of listTargets(reviewDir)) {
      reviews.push(
        summarise(targetPaths(entry.path, target), entry.lastReview),
      );
    }
  }
  // Two reviews started in the same millisecond is a test writing them back
  // to back rather than anything real, but the list must not shuffle between
  // two loads either way, so the order is total.
  return reviews.sort(
    (a, b) =>
      b.startedAt.localeCompare(a.startedAt) ||
      b.lastAt.localeCompare(a.lastAt) ||
      a.repo.localeCompare(b.repo),
  );
}

function summarise(paths: TargetPaths, lastReview: string): ReviewSummary {
  const findings = readFindings(paths);
  const seen = readSeen(paths);
  const meta = readMeta(paths);
  const open = findings.filter((finding) => {
    const group = groupOf(finding);
    return group !== "resolved" && group !== "invalid" && group !== "tolerated";
  });
  const written = readmeFacts(paths);
  const pr = recordedPr(paths, meta);
  const title = pr.title ?? written.heading;
  const at = (finding: Finding): string =>
    finding.history[finding.history.length - 1]?.at ?? finding.createdAt;
  const top = PRIORITY.find((priority) =>
    open.some((finding) => finding.priority === priority),
  );
  const tags = [
    ...new Set(findings.flatMap((finding) => finding.tags ?? [])),
  ].sort();

  return {
    repo: paths.repo,
    repoName: paths.repo.split(sep).pop() ?? paths.repo,
    target: paths.target,
    ...(title ? { title } : {}),
    startedAt:
      meta.startedAt ??
      findings.map((finding) => finding.createdAt).sort()[0] ??
      lastReview,
    lastAt: findings.map(at).sort().pop() ?? lastReview,
    // Counted by the same function the page uses on the review it is holding,
    // so a row of the rail cannot say one thing while the review open beside
    // it says another.
    counts: countsOf(findings, seen, readFollow(paths)),
    ...(top ? { top } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(Object.keys(pr).length > 0 ? { pr } : {}),
    ...(meta.branch ? { branch: meta.branch } : {}),
    ...(written.verdict ? { verdict: written.verdict } : {}),
  };
}

/**
 * What can be read back out of the README the review wrote.
 *
 * The review skill writes that file for a person, not for this, so nothing
 * here is required and a README that says none of it costs a summary nothing.
 * It exists so the reviews already on disk — written before `start_review` —
 * still show what they are about, and because the verdict headline is the one
 * sentence about a review worth putting in a list and is not recorded anywhere
 * else.
 */
/**
 * Everything known about the pull request under a review, however it was
 * learned.
 *
 * Whatever Level 0 recorded wins over whatever the README says, because one
 * is a field and the other is a line of prose that happened to parse. The
 * README is what lights up the reviews that ran before there was a tool to
 * record any of this — and there are plenty of those, so anything that wants
 * to know which pull request a review is about has to ask here rather than
 * reading the meta and concluding there is none.
 */
export function recordedPr(paths: TargetPaths, meta?: TargetMeta): ReviewPr {
  return { ...readmeFacts(paths).pr, ...(meta ?? readMeta(paths)).pr };
}

function readmeFacts(paths: TargetPaths): {
  pr: ReviewPr;
  heading?: string;
  verdict?: string;
} {
  let text: string;
  try {
    text = readFileSync(join(paths.dir, "README.md"), "utf8");
  } catch {
    return { pr: {} };
  }
  const pr: ReviewPr = {};
  const url = /^-\s+Pull request:\s*<?(https?:\/\/\S+?)>?\s*$/m.exec(text)?.[1];
  if (url) {
    pr.url = url;
    const number = /\/pull\/(\d+)/.exec(url)?.[1];
    if (number) pr.number = Number(number);
  }
  const title = /^-\s+Title:\s*`?(.+?)`?\s*$/m.exec(text)?.[1];
  if (title) pr.title = title;
  const heading = readmeHeading(text);
  const verdict = readmeVerdict(text);
  return {
    pr,
    ...(heading ? { heading } : {}),
    ...(verdict ? { verdict } : {}),
  };
}

/**
 * What the README's own heading calls this review.
 *
 * The fallback for a review with no recorded pull request title, which is
 * every review written before there was a tool to record one, and every
 * review of a branch rather than a pull request. Real runs headed the file
 * "PR #356 — Clean up and split SyncManager", "PR 680 review — Add
 * construction acceptance part1" and "Upload and download flow review", so
 * the number and the word that says it is a review come off and what is left
 * is what the review is about. A heading that is only those carries no name.
 */
function readmeHeading(text: string): string | undefined {
  const heading = /^#\s+(.+?)\s*$/m.exec(text)?.[1];
  if (!heading) return undefined;
  const rest = heading
    .replace(/^PR\s*#?\d+\s*/i, "")
    .replace(/^[—–:-]\s*/, "")
    .replace(/^(multi-level\s+)?review\b\s*[—–:-]?\s*/i, "")
    .replace(/\s*[—–:-]?\s*(multi-level\s+)?review\s*$/i, "")
    .trim();
  return rest === "" ? undefined : rest;
}

/**
 * The review's own summary of itself: the one sentence worth putting in a
 * list, and the only thing in the README not recorded anywhere else.
 */
function readmeVerdict(text: string): string | undefined {
  const line =
    /^##\s+Verdict\s*$\n+\*{0,2}(.+?)\*{0,2}\s*$/m.exec(text)?.[1] ??
    /^-\s+Review verdict:\s*\*{0,2}(.+?)\*{0,2}\s*$/m.exec(text)?.[1];
  if (!line) return undefined;
  const trimmed = line.trim();
  return trimmed === "" ? undefined : trimmed;
}
