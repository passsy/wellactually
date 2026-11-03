/**
 * The shapes the findings server stores.
 *
 * One finding is one file on disk. The type is the file format, so anything
 * added here has to survive a round trip through JSON without a migration
 * step, and anything removed has to keep reading old files.
 */

import type { GroupKey } from "./groups.mts";
import type { LevelStatus } from "./levels.mts";

/** How well a finding is backed. Mirrors the review skill's taxonomy. */
export const EVIDENCE = ["Proven", "Reasoned", "Speculative"] as const;
export type Evidence = (typeof EVIDENCE)[number];

/**
 * Whose work the anchored lines are, measured against the review's base.
 *
 * A diff answers "does this line differ from the base", and two ordinary
 * changes make that the wrong question: a file that was moved, and a block
 * that was wrapped in a new parent and re-indented. Every line of both
 * differs from the base while the author wrote almost none of them, and a
 * finding anchored there reads as a comment on code the author never touched
 * — the complaint that created this axis.
 *
 * "changed" is code the author wrote. "whitespace-only" differs from the base
 * only in indentation. "moved" exists on the base side and was carried here.
 * "untouched" is identical to the base. Absent means the review had no base,
 * or git could not answer.
 */
export const AUTHORSHIP = [
  "changed",
  "whitespace-only",
  "moved",
  "untouched",
] as const;
export type Authorship = (typeof AUTHORSHIP)[number];

/**
 * The sentence a reader is owed for the two deceptive answers.
 *
 * Only those two: "changed" is the normal case, and a finding on "untouched"
 * code already shows itself by carrying no hunk. The deceptive ones look
 * changed in every diff view, which is exactly why they need the words.
 */
export const AUTHORSHIP_SAYS: Partial<Record<Authorship, string>> = {
  "whitespace-only":
    "The author only re-indented this code — it predates the change.",
  moved: "The author moved this code here — it predates the change.",
};

/**
 * How urgent a finding is. Ordered worst first, which is the order every list
 * of findings is in unless something else was asked for.
 *
 * Numbers rather than names. The five names this used to have were five
 * judgements a reader had to learn before the ordering meant anything, and two
 * of them ("Degraded", "Tripwire") were jargon invented here. A number says
 * only what this axis is for — where in the queue it goes — and leaves saying
 * what kind of problem it is to the finding's own tags, which are the review's
 * words and not a taxonomy anyone has to agree on first.
 *
 * Five rungs, not an open scale. The point of the axis is that two findings
 * can be compared, and an unbounded p7 is a rung whose meaning nobody shares.
 */
export const PRIORITY = ["p0", "p1", "p2", "p3", "p4"] as const;
export type Priority = (typeof PRIORITY)[number];

/**
 * How a finding is clustered, in the review's own words.
 *
 * Free text on purpose: "race", "data loss", "leaked subscription", "missing
 * test" — and for the absolutely non-critical, "vibe" (a preference, not a
 * defect) and "harmless" (true, and hurts nothing). Nothing sorts by them, so
 * any string is safe, and the twenty-odd names a real review needs turn up on
 * their own instead of being guessed at in advance. Usually one per finding.
 */
export const MAX_TAGS = 4;
export const MAX_TAG_LENGTH = 24;

/**
 * What the human decided. Only a human ever sets this.
 *
 * Deliberately not the same axis as whether the code still has the problem.
 * A finding can be fixed by someone who never read it, and a finding can be
 * invalid and then disappear anyway when the surrounding code is rewritten.
 * One axis forced those two into an order that the work does not follow.
 *
 * Every verdict names what happens from now, and the two failed ones name a
 * judgement on the finding rather than a gesture at it. "invalid" means the
 * review got it wrong, and owes the rule's author an issue — links.ruleIssue
 * is the stamp that debt was paid. "tolerated" means the finding stands and
 * is carried on purpose: taste not worth fighting about, out of scope for
 * the change, or outranked by bigger problems. Nothing further happens to a
 * tolerated finding — except that a rule which keeps collecting them earns a
 * suggestion to be disabled, which is a human's call on the evidence, never
 * a consequence of one finding.
 *
 * There used to be one "dismissed" for both, which made the same keystroke
 * mean "this is garbage" and "this is right, and no" — the reason it was
 * hard to press. Old files still say "dismissed" (briefly also "parked");
 * the store normalises them on read and nothing else ever sees the words.
 */
export const VERDICT = [
  "undecided",
  "accepted",
  "invalid",
  "tolerated",
] as const;
export type Verdict = (typeof VERDICT)[number];

/**
 * The verdict an old file's word means now.
 *
 * "dismissed" carried both failed states, so the entry's reason is the only
 * witness: "false-positive" was a claim the review got it wrong, which is
 * exactly "invalid". Every other reason — taste, not-now, disagree-with-rule,
 * the hardcoded "other", none at all — was some way of letting the finding
 * stand, which is "tolerated". "parked" existed for a day and was tolerated
 * by definition.
 */
export function modernVerdict(verdict: string, reason?: string): Verdict {
  if (verdict === "dismissed") {
    return reason === "false-positive" ? "invalid" : "tolerated";
  }
  if (verdict === "parked") return "tolerated";
  return verdict as Verdict;
}

/**
 * Whether the code still has the problem. Independent of the verdict.
 *
 * "resolved" is a claim, made by whoever wrote the fix. A review run that
 * later cannot find the finding stamps `confirmedAt` on it, which is the
 * difference between someone saying it is done and the review agreeing.
 */
export const RESOLUTION = ["unresolved", "resolved", "regressed"] as const;
export type Resolution = (typeof RESOLUTION)[number];

/** Who is asking for a transition. The lifecycle checks this. */
export const ACTOR = ["review", "human", "agent"] as const;
export type Actor = (typeof ACTOR)[number];

/**
 * Who found it. Not the same question as who is moving it now.
 *
 * A queue that mixes the review's own findings with what a person said on the
 * pull request owes the reader the difference: they carry different weight,
 * they are argued differently, and a comment from a colleague is not something
 * to dismiss with the same shrug as a rule hit. Absent on findings written
 * before this field existed, which are all the review's own — that is what the
 * server could write at the time.
 */
export const REPORTER = ["review", "human", "pr-comment"] as const;
export type Reporter = (typeof REPORTER)[number];

export interface Anchor {
  /** Metadata uses an authoritative URL in file, and line numbers in text. */
  kind?: "metadata";
  subject?: "pr-title" | "pr-body" | "commit-message";
  text?: string;
  /** Repo-relative path. */
  file: string;
  /** 1-based, at the time the finding was created. */
  line: number;
  /**
   * The last line of the marked range, when the finding is about a block
   * rather than a line. `line` stays the one the finding is anchored to: it
   * fingerprints the finding and it is where a comment can land.
   */
  endLine?: number;
  /** The SHA the line number refers to. */
  commit: string;
}

/**
 * One move on one axis, or one rewrite of the finding itself.
 *
 * An entry names the axis it moved, so a history reads as two independent
 * threads rather than one confused line. Nothing is ever rewritten here.
 */
export interface TransitionEntry {
  /** ISO 8601 with timezone. */
  at: string;
  actor: Actor;
  /** Set when this entry moved the verdict. */
  verdict?: Verdict;
  /** Set when this entry moved the resolution. */
  resolution?: Resolution;
  /**
   * The fields this entry rewrote, when it was a correction rather than a
   * move. A finding whose text changed after a human ruled on it is a verdict
   * given to something else, and the only way to see that is to record it.
   */
  edited?: string[];
  /**
   * A retired field old files still carry: the reason enum that used to ride
   * on a dismissal ("false-positive", "taste", "not-now", …). The verdict
   * says everything now; this is kept readable because history is never
   * rewritten, and it is what modernVerdict reads to sort an old dismissal.
   */
  reason?: string;
  /** Free text, e.g. why not now. */
  note?: string;
  /** The commit that claims the fix, when one resolved it. */
  commit?: string;
}

export interface FindingLinks {
  /** SHA of the commit that claims to fix it. */
  fixCommit?: string;
  /** URL, once posted to a pull request. */
  prComment?: string;
  /**
   * The handbook issue an invalid finding was reported as, once report_finding
   * filed it. An invalid verdict owes the rule's author this issue the way an
   * accepted finding owes the code a fix, and the link is what says the debt
   * was paid.
   */
  ruleIssue?: string;
}

/**
 * The code around the anchor, as it read when the finding was written.
 *
 * Captured rather than looked up later. A report is read days after the run,
 * from a checkout that has moved on, and re-reading the file then would show
 * code the reviewer never saw.
 */
export interface SourceContext {
  /** 1-based line number of `lines[0]`. */
  start: number;
  lines: string[];
}

/**
 * A second, third, fourth place the finding is about.
 *
 * Plenty of findings are not about a line, they are about a relationship
 * between lines: two writers to one field, a check here and the use of its
 * result there, an invariant spread over five call sites. Showing one end of
 * that and describing the other in prose makes the reader do the lookup that
 * the reviewer already did.
 *
 * The anchor stays the one location: it fingerprints the finding and it is
 * where a pull request comment can land. These are the rest of the argument.
 */
export interface RelatedLocation {
  file: string;
  line: number;
  /** The last line of the marked range. See Anchor.endLine. */
  endLine?: number;
  /** Why this place is part of the finding, e.g. "the other writer". */
  note?: string;
  context?: SourceContext;
  diff?: string;
  /** Whose work these lines are. See AUTHORSHIP. */
  authorship?: Authorship;
}

export interface Finding {
  /** Server-allocated, unique per target, e.g. "T4". */
  id: string;
  title: string;
  /** Markdown: the full argument, evidence, repro. */
  body: string;
  evidence: Evidence;
  priority: Priority;
  /** What kind of problem it is, in the review's words. Usually one. */
  tags?: string[];
  /** Handbook rule id, e.g. "PW-D001". */
  rule?: string;
  /** For Proven findings: "file:line" of the failing test. */
  provenTest?: string;
  anchor: Anchor;
  /**
   * The anchor line as it read when the finding was created. Kept because the
   * fingerprint is derived from it and a later run has to be able to recompute
   * the same value without guessing which line moved where.
   */
  snippet: string;
  /** The lines around the anchor. Absent when the file could not be read. */
  context?: SourceContext;
  /** The other places this finding is about, in the order they were given. */
  related?: RelatedLocation[];
  /**
   * The unified hunk that changed the anchor line, when the review has a base
   * and the line is part of the diff. Findings on unchanged lines have none,
   * which is normal: the line that best shows a defect often did not change.
   */
  diff?: string;
  /**
   * Whose work the anchored lines are. See AUTHORSHIP. Worked out when the
   * finding is written, because it is a claim about the base the review ran
   * against, and a later checkout cannot recompute it.
   */
  authorship?: Authorship;
  /** Server-computed. See fingerprint.mts. */
  fingerprint: string;
  /** What the human decided. See VERDICT. */
  verdict: Verdict;
  /** Whether the code still has it. See RESOLUTION. */
  resolution: Resolution;
  /** When a review run stopped finding a resolved finding. */
  confirmedAt?: string;
  history: TransitionEntry[];
  links: FindingLinks;
  /** ISO timestamp of the last review run that found this fingerprint again. */
  lastSeen?: string;
  /**
   * The last review run did not find this fingerprint. The code under the
   * finding changed, so a human should glance at whether it still applies.
   */
  staleAnchor?: boolean;
  /**
   * The human's own note on this finding.
   *
   * Kept apart from the history because it is not a decision: it is what the
   * reader thought while looking, written before they know whether they will
   * accept or dismiss. Whoever fixes the finding reads it, human or agent, so
   * it is the one field on a finding that a human writes and everyone else
   * obeys. Rewritten in place rather than appended, because a reader wants the
   * current note, not eleven revisions of it.
   */
  note?: string;
  /** When the note was last written. */
  noteAt?: string;
  /** The observation this was promoted from, when a level handed it over. */
  fromObservation?: string;
  /** The review candidate this finding was verified from. */
  fromCandidate?: string;
  /** Technical review confidence, separate from the human verdict. */
  verification?: { status: "confirmed" | "plausible" | "refuted"; reason?: string; method?: "source" | "executable" | "unverified"; proof?: string; proofs?: string[]; limits?: string[] };
  /** A stopped verification attempt, visible independently of human triage. */
  verificationBlock?: { reason: string; at: string; candidates: string[] };
  /**
   * When it was told to the author, if it has been.
   *
   * Its own field rather than something read off the comment link, because
   * plenty of findings are reported without a URL to show for it: said in a
   * review call, raised in chat, posted by hand. Making the address the proof
   * left those unable to say the true thing about themselves, and the page
   * unable to offer the rung at all.
   */
  reportedAt?: string;
  /** Where it came from. See REPORTER. Absent means the review found it. */
  reporter?: Reporter;
  /**
   * The person behind it, when there is one: a GitHub login for a pull request
   * comment, a name for anyone else. Kept apart from `reporter` so the kind
   * stays something the page can filter and colour on, and the name stays free
   * text nobody has to enumerate.
   */
  reporterName?: string;
  createdAt: string;
}

/**
 * What a target remembers about the review itself.
 *
 * The base belongs to the run, not to each finding, so the first tool call
 * that carries one sets it and every later finding is diffed against it
 * without repeating it.
 */
export interface TargetMeta {
  /** A ref or SHA the change is measured against, e.g. "origin/main". */
  base?: string;
  /**
   * When this review first wrote anything.
   *
   * The inbox orders reviews by it. The alternative is the last write, which
   * reorders the list under someone working it: triaging the oldest review on
   * the list moves it to the top, and the next thing they look for has moved.
   */
  startedAt?: string;
  /** What is under review, when a pull request is what is under review. */
  pr?: ReviewPr;
  /** Where the branch stands, when no pull request is carrying it. */
  branch?: ReviewBranch;
}

/**
 * A review of a branch that no pull request is carrying.
 *
 * Plenty of work is reviewed before it becomes a pull request, or instead of
 * becoming one. Those reviews had nothing on them saying where the branch had
 * got to — the same question a merged pull request answers, and the same
 * reason for asking it: a review of something that has already landed is a
 * review that reads differently, or not at all.
 *
 * Git answers it without a network. Nothing here is fetched: the default
 * branch is however up to date the reader's own checkout is, which is the
 * honest answer to "as far as this machine knows".
 */
export interface ReviewBranch {
  /** The branch this is measured against, e.g. "main". */
  base: string;
  /** Whether the commit the review was written against is in that branch. */
  landed: boolean;
  /** When this was last worked out. */
  at: string;
}

/**
 * The pull request a review is of.
 *
 * Everything here is written by Level 0, which collects it from GitHub before
 * any finding exists, and is kept so the inbox can say what a review is about
 * without opening it. "pr-356" identifies a review; it does not say what the
 * change is or how long it has been waiting.
 */
export interface ReviewPr {
  number?: number;
  url?: string;
  title?: string;
  /** The login, or the name, of whoever opened it. */
  author?: string;
  /** ISO timestamp the pull request was opened, not when the review ran. */
  openedAt?: string;
  /** As GitHub reports it: "open", "closed", "merged", "draft". */
  state?: string;
  /**
   * When it landed, for the state that changes what a review is worth.
   *
   * A pull request merged while somebody was reading it is the case that
   * wastes a whole review, and "merged" on its own does not say whether that
   * happened before the run or during it.
   */
  mergedAt?: string;
  /** Who merged it, which is not always who opened it. */
  mergedBy?: string;
  /** The commit at the head of the pull request when it was last looked at. */
  headSha?: string;
  /**
   * How many commits the pull request has gained since the review ran.
   *
   * A review is of one state of a branch. What it says about a branch three
   * commits further on is still worth reading and is no longer the whole
   * story, and nothing else on the page can say which of the two you are
   * looking at.
   */
  behind?: number;
  /**
   * Whether the branch was rebased or force-pushed since the review ran.
   *
   * Worse than being behind: the commits the findings were written against
   * are not in the branch's history any more, so their line numbers point
   * into a version of the file nobody will see again.
   */
  rewritten?: boolean;
  headBranch?: string;
  baseBranch?: string;
}

export const OBSERVATION_STATUS = ["pending", "promoted", "dropped"] as const;
export type ObservationStatus = (typeof OBSERVATION_STATUS)[number];

/**
 * A handoff: something one level noticed that belongs to another level.
 *
 * Not to be confused with the Review Inbox, which is the triage page and is
 * Pascal's. This queue is between levels and he never sees it.
 *
 * Deliberately lighter than a finding. One line, no analysis, no verdict. The
 * owning level decides later whether it becomes a finding, and dropping one is
 * recorded rather than forgotten because which level generates noise for which
 * other level is calibration data for the skill.
 */
export interface Observation {
  /** Server-allocated, e.g. "O1". A separate sequence from findings. */
  id: string;
  text: string;
  /** Which level owns triaging it, e.g. "2". */
  forLevel: string;
  status: ObservationStatus;
  /** The finding id, once promoted. */
  promotedTo?: string;
  dropReason?: string;
  createdAt: string;
}

/** Technical review state, before a finding reaches human triage. */
export const CANDIDATE_STATUS = [
  "pending",
  "confirmed",
  "plausible",
  "refuted",
] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUS)[number];

/**
 * A possible finding owned by the review process.
 *
 * Candidates live in the same service as findings so reviewers can hand work
 * to verifiers without serialising finding prose through local JSON files.
 * Only confirmed or plausible candidates become human-triage findings.
 */
export interface ReviewCandidate {
  /** Server-allocated, unique per target, e.g. "C3". */
  id: string;
  /** Stable worker-side reference, useful in probe output. */
  source: string;
  /** One invocation of a review against a durable target. */
  run: string;
  /** Verification partition, e.g. "all", "set-01" or "crossing". */
  unit: string;
  title: string;
  body: string;
  evidence: Evidence;
  priority: Priority;
  tags?: string[];
  level?: string;
  rule?: string;
  provenTest?: string;
  anchor: Omit<Anchor, "commit"> & { commit?: string };
  related?: Omit<RelatedLocation, "context" | "diff" | "authorship">[];
  /** Review-specific scope retained for verification and reporting. */
  scope?: string;
  /** Exact principle advice when the candidate came from a rule. */
  quote?: string;
  status: CandidateStatus;
  verificationReason?: string;
  proof?: string;
  /** Human-triage finding created by confirmation/plausibility. */
  findingId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * What the triage page and the report are handed over HTTP.
 *
 * Here rather than beside the code that builds them, because this module is
 * the one both runtimes can have: the browser imports these as they are, so
 * a field the server stops sending stops compiling rather than rendering an
 * empty span.
 */
export type SeenMap = Record<string, string>;
/** How much of a review is left to do, for the inbox's list. */
export interface ReviewCounts {
  total: number;
  /** Findings Pascal has not read, which is what the inbox badges. */
  unread: number;
  /** Findings somebody has written a note on. */
  noted: number;
  /** Findings the reader has marked to come back to. */
  marked: number;
  /** Neither resolved nor dismissed: still someone's problem. */
  open: number;
  /** Resolved once and back again. */
  back: number;
  /**
   * How many findings are in each pile.
   *
   * So that a list of reviews can say how far through each one is without
   * reading every finding of every review a second time — and, more to the
   * point, without inventing its own idea of "done". The page draws this and
   * the open review's own bar from the same six numbers, so the two cannot
   * come to different answers about the same review.
   *
   * Every field here is worked out by `countsOf`, on both sides: the server
   * counts every review, and the page recounts the one it is holding rather
   * than waiting to be told what it just did.
   */
  piles: Record<GroupKey, number>;
}

export interface ReviewSummary {
  repo: string;
  /** The checkout's directory name, which is what a review runs in. */
  repoName: string;
  target: string;
  /**
   * What this review is about, in the author's words. The pull request title
   * where there is one, the README's heading otherwise, and absent for a
   * review that has written neither: "pr-356" names a review, it does not say
   * what the change is.
   */
  title?: string;
  startedAt: string;
  /** The last write to any of its findings. */
  lastAt: string;
  counts: ReviewCounts;
  /** The highest priority still open, absent when nothing is. */
  top?: string;
  /** Every tag used in this review, so the inbox can cluster by one. */
  tags?: string[];
  pr?: ReviewPr;
  /** Where the branch stands, for a review no pull request is carrying. */
  branch?: ReviewBranch;
  /** The one-line verdict the review wrote into its README. */
  verdict?: string;
}

export interface FindingList {
  target: string;
  findings: Finding[];
  /**
   * Which of them have been read, and when. Beside the findings rather than on
   * them: reading is not part of what a finding is, and only the triage page
   * has any use for it.
   */
  seen: SeenMap;
  /**
   * Which of them the reader means to come back to.
   *
   * Its own axis because it crosses every other one: a finding can be
   * undecided and marked, or reported and marked, and the mark says nothing
   * about the finding — only that whoever is reading it is not finished.
   */
  follow: SeenMap;
}

/**
 * Whether a review is still being written.
 *
 * "quiet" is the honest third answer. A run that died, or was stopped, never
 * writes its README, and without this it would read as running for ever: a
 * card pulsing over a review nobody is doing.
 */
export const REVIEW_STATE = ["running", "quiet", "done"] as const;
export type ReviewState = (typeof REVIEW_STATE)[number];

/**
 * One review, as the card in the conversation needs it.
 *
 * The inbox asks three routes for this and holds a stream open for changes.
 * A card has one tool call and a host between it and the server, so it gets
 * the whole answer at once and asks again.
 */
export interface ReviewStatus {
  repo: string;
  repoName: string;
  target: string;
  title?: string;
  /** Where the Review Inbox shows this review. */
  url: string;
  /**
   * The same page by a name that says nothing: /open/<id> on the inbox's
   * server. For a link that has to pass through somebody else's redirect,
   * which should not learn the repository's path on its way.
   */
  link: string;
  state: ReviewState;
  phase?: "review" | "verification";
  /** Incoming candidates remain read-only until verification creates a finding. */
  candidates?: ReviewCandidate[];
  startedAt: string;
  /** The last write of any kind: a finding, a verdict, a level document. */
  lastAt: string;
  /**
   * How long the run has taken. Absent when it cannot be one sitting, which
   * is every review that has been run a second time.
   */
  elapsedMs?: number;
  pr?: ReviewPr;
  /** The one-line verdict the review wrote into its README. */
  verdict?: string;
  /** Empty for a review that was never run level by level. */
  levels: LevelStatus[];
  /**
   * Every finding, worst first, without the parts only the inbox shows: the
   * history, the hunk, and the other places a finding is about.
   */
  findings: Finding[];
}
