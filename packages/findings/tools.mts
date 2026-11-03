/**
 * The tool surface, described once.
 *
 * Both doors onto the core need the same list: MCP wraps it in a protocol,
 * the HTTP bridge exposes it as POST endpoints. Keeping the descriptions here
 * rather than in either door is what stops the two from disagreeing about
 * what a tool does.
 *
 * Every description is read by a model, not a person, so it says what the
 * tool is for and when not to reach for it.
 */

import {
  addLocation,
  baselineCheck,
  createCandidates,
  createFinding,
  createObservation,
  dropObservation,
  enabledRules,
  exportDismissals,
  getFinding,
  linkFixCommit,
  linkPrComment,
  listFindings,
  listCandidates,
  listReviews,
  listObservations,
  regenerateViews,
  reportFinding,
  resolveCandidates,
  reviewStatus,
  openInbox,
  setNote,
  setReported,
  setResolution,
  setStage,
  setVerdict,
  startReview,
  updateFinding,
} from "./api.mts";
import {
  ACTOR,
  CANDIDATE_STATUS,
  type ReviewStatus,
  EVIDENCE,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  OBSERVATION_STATUS,
  PRIORITY,
  REPORTER,
  RESOLUTION,
  VERDICT,
} from "./model/types.mts";
import { COMPLAINTS } from "./report/issue.mts";
import { QUEUE_TOOLS } from "./queue-tools.mts";

type Schema = Record<string, unknown>;

const target: Schema = {
  type: "string",
  description:
    'The review target directory, e.g. "pr-123" or a branch name. One per review.',
};
const repo: Schema = {
  type: "string",
  description:
    "Absolute path of the repository. Defaults to the one this server was started in; only pass it to reach another checkout.",
};

const anchor: Schema = {
  type: "object",
  description: "Source location, or metadata location with kind=metadata, subject, authoritative URL in file, and full original text. Line numbers refer to that text.",
  properties: {
    kind: { type: "string", enum: ["metadata"] },
    subject: { type: "string", enum: ["pr-title", "pr-body", "commit-message"] },
    text: { type: "string", description: "Original metadata text, retained verbatim." },
    file: {
      type: "string",
      description:
        "Repo-relative path. An absolute path inside the repo also works.",
    },
    line: {
      type: "integer",
      minimum: 1,
      description:
        "1-based line number. With endLine it is the first marked line, and it stays the one the finding is identified and commented on.",
    },
    endLine: {
      type: "integer",
      minimum: 1,
      description:
        "Last marked line, when the finding is about a block rather than a line: a whole method, a branch, the body of a loop. Omit for a single line.",
    },
    commit: {
      type: "string",
      description: "SHA the line number refers to. Defaults to HEAD.",
    },
  },
  required: ["file", "line"],
};

const candidateFields: Schema = {
  source: {
    type: "string",
    description:
      "Stable worker reference for probes and handoff, unique within this review.",
  },
  unit: {
    type: "string",
    description: 'Verification partition, e.g. "all", "set-01" or "crossing".',
  },
  title: { type: "string" },
  body: {
    type: "string",
    description:
      "Author-facing problem and remedy as separate paragraphs. Verification narration stays outside this field.",
  },
  evidence: { type: "string", enum: [...EVIDENCE] },
  priority: { type: "string", enum: [...PRIORITY] },
  tags: {
    type: "array",
    items: { type: "string" },
    maxItems: MAX_TAGS,
  },
  level: { type: "string" },
  rule: { type: "string" },
  provenTest: { type: "string" },
  anchor,
  related: {
    type: "array",
    items: {
      type: "object",
      properties: {
        file: { type: "string" },
        line: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
        note: { type: "string" },
      },
      required: ["file", "line"],
    },
  },
  scope: {
    type: "string",
    enum: [
      "introduced",
      "newly_exposed",
      "incomplete_fix",
      "pre_existing",
      "current",
    ],
  },
  quote: { type: "string" },
};

/**
 * The card a host can draw for a tool, where the host draws such things.
 *
 * MCP Apps: a tool names a `ui://` resource, a host that supports the
 * extension renders it in the conversation and hands it the tool's result.
 * A host that does not support it sees an ordinary tool with a text answer,
 * so nothing here changes what the tool is for.
 */
export const REVIEW_CARD = "ui://wellactually/review-card.html";

export interface Tool {
  name: string;
  description: string;
  inputSchema: Schema;
  /** Safety metadata forwarded to MCP hosts, including embedded app calls. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
  run: (args: unknown, repoRoot: string) => unknown;
  /** The `ui://` resource that draws this tool's result. */
  card?: string;
  /**
   * What the card is handed, when it is not what `run` returned. The answer
   * a model reads and the state a card draws are different sizes.
   */
  forCard?: (args: unknown, repoRoot: string) => unknown;
  /**
   * What a model reads, when the whole result is more than it needs.
   * Without this the result goes out as JSON, as it always has.
   */
  says?: (result: unknown) => string;
  /**
   * Offered to a card and never to a model. Left out of the tool list for a
   * host that draws no cards, because such a host would hand it to the model.
   */
  cardOnly?: boolean;
  /**
   * Who is offered this tool by a server started with `--card`, which is the
   * server a chat is given: it shows reviews and runs none, so it offers the
   * four tools the card needs and none of the twenty that write a review.
   * Absent means that server does not offer it at all.
   */
  inCardServer?: "model" | "card";
}

/** The reviews on this machine, newest first, as little as names them. */
function reviewsSay(): unknown {
  return listReviews()
    .slice(0, 30)
    .map((review) => ({
      repo: review.repo,
      target: review.target,
      ...(review.title ? { title: review.title } : {}),
      startedAt: review.startedAt,
      findings: review.counts.total,
      needVerdict: review.counts.piles.verdict,
      ...(review.top ? { worstOpen: review.top } : {}),
    }));
}

/** A review's status in the two lines a model needs. */
function statusSays(result: unknown): string {
  const status = result as ReviewStatus;
  const open = status.findings.filter(
    (finding) =>
      finding.verdict === "undecided" && finding.resolution !== "resolved",
  ).length;
  const level = status.levels.find((each) => each.state === "running");
  const where =
    status.state === "done"
      ? "finished"
      : status.state === "quiet"
        ? "not finished, and nothing written for a while"
        : level
          ? `running Level ${String(level.n)} (${level.name})`
          : "running";
  return [
    `${status.target}: ${where}. ${String(status.findings.length)} findings, ${String(open)} still need a verdict.`,
    ...(status.verdict ? [status.verdict] : []),
    `Review Inbox: ${status.url}`,
  ].join("\n");
}

export const TOOLS: Tool[] = [
  ...QUEUE_TOOLS,
  {
    name: "start_review",
    description:
      'Announce a review at Level 0, before any finding exists, and record what the pull request is. Call it once as soon as the target is known: it puts the review in the Review Inbox, so a link posted at the start of a run opens something rather than nothing, and a run that finds no problem still shows that it happened. Pass the pull request facts Level 0 collects anyway — number, title, author, when it was opened — because nothing later can recover them and "pr-356" on its own says nothing about what is being reviewed. Safe to call again to update the state of the pull request; it never changes when the review started.',
    inputSchema: {
      type: "object",
      properties: {
        target,
        repo,
        base: {
          type: "string",
          description:
            'What the change is measured against, e.g. "origin/main" or the exact base SHA. Setting it here means no finding has to repeat it.',
        },
        pr: {
          type: "object",
          description:
            "The pull request under review. Omit entirely when reviewing local changes rather than a pull request.",
          properties: {
            number: { type: "integer", minimum: 1 },
            url: { type: "string", description: "The pull request's URL." },
            title: {
              type: "string",
              description: "The author's title, verbatim.",
            },
            author: {
              type: "string",
              description:
                "GitHub login, or the name if that is what you have.",
            },
            openedAt: {
              type: "string",
              description:
                'When the pull request was opened, as GitHub gives it: "2026-08-12T09:14:03Z". Not when the review ran — how long the author has been waiting is the point.',
            },
            state: {
              type: "string",
              description: '"open", "draft", "closed" or "merged".',
            },
            mergedAt: {
              type: "string",
              description:
                "When it was merged, in the same form, when it has been. A pull request that landed while somebody was reading the review is what wastes a whole review, and the inbox says so — but only if it knows when.",
            },
            headBranch: { type: "string" },
            baseBranch: { type: "string" },
          },
        },
      },
      required: ["target"],
    },
    run: startReview,
    card: REVIEW_CARD,
    forCard: reviewStatus,
  },
  {
    name: "review_status",
    annotations: { readOnlyHint: true },
    description:
      "Where a review stands: which levels are finished, which is running, how many findings there are and how many still need a verdict. In a host that draws cards this shows the live review card, with the findings and the track to rule on them, so call it when the user asks to see a review or how one is going. Do not call it to read findings: list_findings and get_finding are for that, and this answers with a summary.",
    inputSchema: {
      type: "object",
      properties: { target, repo },
      required: ["target"],
    },
    run: reviewStatus,
    card: REVIEW_CARD,
    says: statusSays,
    inCardServer: "model",
  },
  {
    name: "list_reviews",
    description:
      "The reviews on this machine, newest first: the repository and target that name each one, what it is about, and how many findings still need a verdict. Call it to find the review the user means before review_status, which needs both names.",
    inputSchema: { type: "object", properties: {} },
    run: reviewsSay,
    inCardServer: "model",
  },
  {
    name: "set_stage",
    description:
      "Move a finding to a stop of the track: invalid, tolerated, open, accepted, reported or fixed. The review card's own control, for the human looking at it.",
    inputSchema: {
      type: "object",
      properties: {
        target,
        repo,
        id: { type: "string" },
        to: {
          type: "string",
          enum: [
            "invalid",
            "tolerated",
            "open",
            "accepted",
            "reported",
            "fixed",
          ],
        },
        actor: { type: "string", enum: [...ACTOR] },
      },
      required: ["target", "id", "to", "actor"],
    },
    run: setStage,
    cardOnly: true,
    inCardServer: "card",
  },
  {
    name: "open_inbox",
    description:
      "Open a review, or one finding of it, in the Review Inbox in this machine's browser. The review card's Inbox button: a host opens only https links, and the inbox is served over http on loopback. With `rule`, opens that rule's page instead of the review.",
    inputSchema: {
      type: "object",
      properties: {
        target,
        repo,
        finding: {
          type: "string",
          description: "A finding id to open the inbox at, such as T1.",
        },
        rule: {
          type: "string",
          description:
            "A rule id, such as PW-G007. Opens the rule's own page rather than the review, and the rest of the arguments are not read.",
        },
      },
      required: ["target"],
    },
    run: openInbox,
    cardOnly: true,
    inCardServer: "card",
  },
  {
    name: "create_candidates",
    description:
      "Store possible findings as soon as a reviewer or tester finishes checking the relevant code. This is the review-process handoff: candidates live in Findings MCP, never in verified/*.json or findings.json. Use one batch per worker. The result maps each stable source to a server candidate id; put only those ids in any coverage artifact. Correct every indexed error immediately.",
    inputSchema: {
      type: "object",
      properties: {
        target,
        repo,
        run: {
          type: "string",
          description:
            "Stable id for this invocation, shared by all workers; use the review artifact directory name.",
        },
        candidates: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            properties: candidateFields,
            required: [
              "source",
              "unit",
              "title",
              "body",
              "evidence",
              "priority",
              "anchor",
            ],
          },
        },
      },
      required: ["target", "run", "candidates"],
    },
    run: createCandidates,
  },
  {
    name: "list_candidates",
    annotations: { readOnlyHint: true },
    description:
      "Read the review-process queue from Findings MCP. Verifiers use unit plus status pending to claim their work. Coordinators use pending candidates to decide whether verification is complete; no local verification ledger is needed.",
    inputSchema: {
      type: "object",
      properties: {
        target,
        repo,
        run: {
          type: "string",
          description: "Only candidates from this review invocation.",
        },
        unit: { type: "string" },
        status: { type: "string", enum: [...CANDIDATE_STATUS] },
      },
      required: ["target"],
    },
    run: listCandidates,
  },
  {
    name: "resolve_candidates",
    description:
      "Record independent verification directly in Findings MCP. Confirmed and plausible candidates become ordinary undecided findings for human triage in the same operation; refuted candidates remain as calibration evidence and never become findings. A plausible decision needs a reason; a refuted decision needs proof or a reason. Use finding only for evidence-driven corrections to the candidate. Correct every indexed error before declaring the unit complete.",
    inputSchema: {
      type: "object",
      properties: {
        target,
        repo,
        base: {
          type: "string",
          description:
            "Exact reviewed base SHA or ref, applied when promoted findings capture diff context.",
        },
        decisions: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              status: {
                type: "string",
                enum: ["confirmed", "plausible", "refuted"],
              },
              reason: { type: "string" },
              proof: { type: "string" },
              finding: {
                type: "object",
                description:
                  "Only fields corrected by verification; omitted fields remain as submitted.",
                properties: candidateFields,
              },
            },
            required: ["id", "status"],
          },
        },
      },
      required: ["target", "decisions"],
    },
    run: resolveCandidates,
  },
  {
    name: "create_finding",
    description:
      "Record one review finding. This is the only way findings are written: never hand-write them into markdown. The server allocates the id, fingerprints the anchor line, captures the surrounding source and the diff hunk, and rebuilds review.html and findings.sarif. It also checks whose work every marked line is against the base: when none of them is the author's own edit — the code is unchanged, only re-indented, or moved — the finding is tagged \"pre-existing\" and the result says so in a notice. Act on the notice rather than filing the finding as a comment on the author's work: add the causing edit with add_location, re-anchor with update_finding, or keep the tag and say in the body that the problem predates the change. A finding starts undecided and unresolved: only a human accepts or dismisses it, and only a fix resolves it.",
    inputSchema: {
      type: "object",
      properties: {
        target,
        repo,
        title: {
          type: "string",
          description: "One line. What is wrong, not what to do about it.",
        },
        body: {
          type: "string",
          // Said here as well as in the skill, because this is where it is
          // read. By the time a review is writing findings it is hours and
          // five levels past the part of the skill that explains how one
          // should read, and a measured run bore that out: the same model
          // given the same guidance close at hand wrote in paragraphs, and
          // deep inside a real review wrote six of seven findings as one
          // unbroken block.
          description:
            "Markdown. The full argument: what breaks, how it was established, how to reproduce. Write it as a news story, not as a lab notebook: the first sentence is the whole finding for someone who stops there, detail descends from it, and a list of three or more things is a list rather than a sentence. A lab notebook retells the investigation in the order you did it, which is the order this comes out in by default and the wrong way round for the person reading.",
        },
        evidence: {
          type: "string",
          enum: [...EVIDENCE],
          description:
            'How well it is backed. "Proven" means a test fails and requires provenTest. Never label a traced-through-the-code finding Proven.',
        },
        priority: {
          type: "string",
          enum: [...PRIORITY],
          description:
            "How urgently it should be dealt with, independent of evidence. p0 merging like this hurts: data lost or corrupted, a crash, a security hole, or the bug the PR claims to fix surviving on some path. p1 users hit it and recover: a slow reconnect that heals, a stale list until the next refresh, a double network call. p2 fine today, the next change sets it off: an invariant spread over seven call sites, a race current timing happens to win, a method that lies about what it does. p3 it works and reads worse than it should: naming, duplication, dead code, a comment that no longer matches the body. p4 take it or leave it, and the author owes no answer.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: `What kind of problem it is, in your own words, so findings like it can be found together: "race", "data loss", "leaked subscription", "missing test", "breaking api". For findings that are absolutely non-critical, "vibe" (a preference, not a defect) and "harmless" (true, and hurts nothing) say so up front. Usually one, at most ${MAX_TAGS}, each up to ${MAX_TAG_LENGTH} characters, lowercased on the way in. There is no fixed vocabulary, so reuse a tag already on another finding in this review — list_findings shows them — rather than coining a synonym for it.`,
        },
        level: {
          type: "string",
          description:
            'The review level that found it, "1" to "5". It picks the id letter (1=A, 2=H, 3=T, 4=L, 5=R). Omit for general findings, which sign with G.',
        },
        rule: {
          type: "string",
          description: 'Handbook rule id when one applies, e.g. "PW-D001".',
        },
        provenTest: {
          type: "string",
          description:
            '"file:line" of the failing test. Required when evidence is Proven.',
        },
        anchor,
        related: {
          type: "array",
          description:
            "The other places this finding is about, when it is about a relationship rather than a line: the second writer, the reader of the stale value, the other call site that has to hold the same invariant. Each gets its own source and diff in the report. The anchor stays the one location a pull request comment can land on.",
          items: {
            type: "object",
            properties: {
              file: { type: "string" },
              line: { type: "integer", minimum: 1 },
              endLine: {
                type: "integer",
                minimum: 1,
                description:
                  "Last marked line, for a block rather than a line.",
              },
              note: {
                type: "string",
                description:
                  'One line on why this place belongs to the finding, e.g. "the other writer". Without it the reader sees code and has to guess.',
              },
            },
            required: ["file", "line"],
          },
        },
        base: {
          type: "string",
          description:
            'What the change is measured against, e.g. "origin/main" or "main...HEAD". Pass it on the first finding of a run: the target remembers it, and every finding then carries the diff hunk that changed its anchor line. Without it a finding shows source only.',
        },
        fromObservation: {
          type: "string",
          description:
            'Observation id this was promoted from, e.g. "O3". Marks that observation promoted.',
        },
        reporter: {
          type: "string",
          enum: [...REPORTER],
          description:
            'Who found it. Omit when the review found it itself, which is the default. "human" is one Pascal raised in conversation and asked you to file. "pr-comment" is one a person left on the pull request and requires reporterName.',
        },
        reporterName: {
          type: "string",
          description:
            'The person behind it: a GitHub login for a pull request comment, a name otherwise. Required with reporter "pr-comment", because a comment nobody is named for cannot be answered.',
        },
      },
      required: ["target", "title", "body", "evidence", "priority", "anchor"],
    },
    run: createFinding,
  },
  {
    name: "add_location",
    description:
      'Point an existing finding at another place in the code. Use it when a later level finds the second half of the same problem, instead of writing a second finding that repeats the first. Adding a line the author actually edited also takes a server-added "pre-existing" tag off the finding, which is the way to answer a create_finding notice when the change is what causes an old line\'s problem.',
    inputSchema: {
      type: "object",
      properties: {
        target,
        repo,
        id: { type: "string" },
        file: { type: "string" },
        line: { type: "integer", minimum: 1 },
        endLine: {
          type: "integer",
          minimum: 1,
          description: "Last marked line, for a block rather than a line.",
        },
        note: {
          type: "string",
          description: "One line on why this place belongs to the finding.",
        },
      },
      required: ["target", "id", "file", "line"],
    },
    run: addLocation,
  },
  {
    name: "list_rules",
    description:
      "The rules a review checks for a project, as two lists. `enabled` is every rule that applies here, each with its file to read; check those. `disabled` holds the rules a settings file switched off, with the file that did it; skip those. Resolved the same way the hook resolves them: on unless a file turns them off, machine-wide settings first, the project's own winning. An enabled rule without an id has no detector, so it cannot be turned off; cite it by title.",
    inputSchema: {
      type: "object",
      properties: {
        repo,
      },
    },
    run: enabledRules,
  },
  {
    name: "update_finding",
    description:
      'Correct a finding you already wrote: a wrong title, an argument that turned out not to hold, an anchor on the wrong line. Only the fields given are changed, and the edit is recorded in the history. Moving the anchor re-runs the whose-work check: landing on an edit the author actually made takes a "pre-existing" tag off, and landing where no marked line is theirs puts it on, either way said in a notice. Use this rather than creating a second finding, which is refused as a duplicate anyway. Not for the verdict, the resolution or the note: those are decisions, and they have their own tools.',
    inputSchema: {
      type: "object",
      properties: {
        target,
        repo,
        id: { type: "string" },
        title: { type: "string" },
        body: {
          type: "string",
          description: "Markdown, replacing the old one.",
        },
        evidence: { type: "string", enum: [...EVIDENCE] },
        priority: { type: "string", enum: [...PRIORITY] },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Replaces the tags entirely rather than adding to them, so pass the ones being kept as well.",
        },
        rule: { type: "string" },
        provenTest: { type: "string" },
        anchor: {
          type: "object",
          description:
            "Where the finding really is. Moving it recaptures the code and the fingerprint, so pass the whole anchor, not just the line.",
          properties: {
            file: { type: "string" },
            line: { type: "number" },
            endLine: { type: "number" },
          },
          required: ["file", "line"],
        },
        actor: { type: "string", enum: [...ACTOR] },
      },
      required: ["target", "id"],
    },
    run: updateFinding,
  },
  {
    name: "list_findings",
    description:
      'Read findings. Without a target it returns every target of the repository. The fix queue is verdict:"accepted" with resolution:"unresolved"; what still needs a decision from Pascal is verdict:"undecided". Each finding may carry a "note", written by Pascal while triaging it: it is the most recent word on the finding and it outranks the body, so read it before acting on anything. The captured source and diff are left out; filter down to the findings you are about to work on and pass code:true for those, or call get_finding.',
    inputSchema: {
      type: "object",
      properties: {
        target,
        repo,
        verdict: {
          type: "string",
          enum: [...VERDICT],
          description: "What Pascal decided about it.",
        },
        resolution: {
          type: "string",
          enum: [...RESOLUTION],
          description: "Whether the code still has it.",
        },
        priority: { type: "string", enum: [...PRIORITY] },
        tag: {
          type: "string",
          description:
            "Only findings carrying this tag. Matched exactly, after lowercasing.",
        },
        code: {
          type: "boolean",
          description:
            "Include the captured source and diff of every finding returned. Two thirds of a finding's weight, so filter first: a whole target with code is large enough to be truncated on the way back.",
        },
      },
    },
    run: listFindings,
  },
  {
    name: "get_finding",
    description:
      'Read one finding in full: its body, its history, and the "note" Pascal wrote on it while triaging. The note is the newer of the two and it outranks the body, so read it before acting on the finding.',
    inputSchema: {
      type: "object",
      properties: { target, repo, id: { type: "string" } },
      required: ["target", "id"],
    },
    run: getFinding,
  },
  {
    name: "set_verdict",
    description:
      'Record what Pascal decided about a finding: "accepted" (real, to be reported or fixed), "invalid" (the review got it wrong — the finding then owes a report_finding issue, and links.ruleIssue is the stamp it was filed), "tolerated" (it stands and is carried on purpose: taste, out of scope, or outranked — nothing further happens to it), or back to "undecided". This axis is his alone, so it always needs actor "human" and you may only call it when he actually said so. It says nothing about whether the code was fixed; that is set_resolution.',
    inputSchema: {
      type: "object",
      properties: {
        target,
        repo,
        id: { type: "string" },
        to: { type: "string", enum: [...VERDICT] },
        actor: {
          type: "string",
          enum: [...ACTOR],
          description:
            'Always "human". Anything else is refused, because nobody but Pascal decides whether a finding is a problem.',
        },
        note: {
          type: "string",
          description: "Free text, e.g. why it is tolerated.",
        },
      },
      required: ["target", "id", "to", "actor"],
    },
    run: setVerdict,
  },
  {
    name: "set_resolution",
    description:
      'Record whether the code still has the problem: "resolved" once it is gone, "unresolved" to put it back on the pile. Independent of the verdict, so a finding nobody accepted can still be resolved when other work removes it. As an agent you must name the commit. Moving to "regressed" belongs to baseline_check, not to you.',
    inputSchema: {
      type: "object",
      properties: {
        target,
        repo,
        id: { type: "string" },
        to: { type: "string", enum: [...RESOLUTION] },
        actor: {
          type: "string",
          enum: [...ACTOR],
          description: 'Who is claiming it. Use "agent" for your own fixes.',
        },
        note: {
          type: "string",
          description: "Free text, e.g. what the fix did.",
        },
        commit: {
          type: "string",
          description:
            "SHA of the commit that fixes it. Required when an agent resolves, because a claim with nothing to point at is worth nothing.",
        },
      },
      required: ["target", "id", "to", "actor"],
    },
    run: setResolution,
  },
  {
    name: "set_note",
    description:
      "Write the human's note on a finding: the context, the caveat, the way they want it fixed. Read it before fixing anything — it is written by the human and it outranks your own reading of the finding. Passing an empty string clears it. Only write one when the human asked for it; this field is theirs, not a scratchpad for your own analysis.",
    inputSchema: {
      type: "object",
      properties: {
        target,
        repo,
        id: { type: "string" },
        note: {
          type: "string",
          description: "The note, replacing whatever was there. Empty clears.",
        },
      },
      required: ["target", "id", "note"],
    },
    run: setNote,
    inCardServer: "card",
  },
  {
    name: "link_fix_commit",
    description:
      "Shortcut for resolving a finding with the commit that fixes it. One finding per commit.",
    inputSchema: {
      type: "object",
      properties: {
        target,
        repo,
        id: { type: "string" },
        commit: { type: "string", description: "SHA of the fixing commit." },
        note: { type: "string" },
      },
      required: ["target", "id", "commit"],
    },
    run: linkFixCommit,
  },
  {
    name: "link_pr_comment",
    description:
      "Record the URL of the pull request comment a finding was posted as, so the same finding is never posted twice.",
    inputSchema: {
      type: "object",
      properties: {
        target,
        repo,
        id: { type: "string" },
        url: { type: "string" },
      },
      required: ["target", "id", "url"],
    },
    run: linkPrComment,
  },
  {
    name: "set_reported",
    description:
      "Say whether the author has been told about a finding. Use it when there is no URL to record: raised in a call, said in chat, posted by hand. When there is one, use link_pr_comment instead, which records the address and marks it reported in the same call.",
    inputSchema: {
      type: "object",
      properties: {
        target,
        repo,
        id: { type: "string" },
        reported: {
          type: "boolean",
          description: "Defaults to true. Pass false to take it back.",
        },
      },
      required: ["target", "id"],
    },
    run: setReported,
  },
  {
    name: "create_observation",
    description:
      "Park a one-line observation for another level to triage. One line, no analysis, no verdict, no finding id: if you can already argue it, it belongs to your own level as a finding instead.",
    inputSchema: {
      type: "object",
      properties: {
        target,
        repo,
        text: {
          type: "string",
          description: "One line, with the file:line that triggered it.",
        },
        forLevel: {
          type: "string",
          description: 'The level that owns triaging it, e.g. "2".',
        },
      },
      required: ["target", "text", "forLevel"],
    },
    run: createObservation,
  },
  {
    name: "list_observations",
    description:
      "Read the handoff queue. A level empties its pending queue through this when it starts, then promotes each line to a finding or drops it.",
    inputSchema: {
      type: "object",
      properties: {
        target,
        repo,
        forLevel: { type: "string" },
        status: { type: "string", enum: [...OBSERVATION_STATUS] },
      },
      required: ["target"],
    },
    run: listObservations,
  },
  {
    name: "drop_observation",
    description:
      "Drop an observation that did not survive a second look. The record stays: which level generates noise for which other level is calibration data.",
    inputSchema: {
      type: "object",
      properties: {
        target,
        repo,
        id: { type: "string" },
        reason: {
          type: "string",
          description: "One line on why it did not hold up.",
        },
      },
      required: ["target", "id", "reason"],
    },
    run: dropObservation,
  },
  {
    name: "baseline_check",
    description:
      "Close the loop at the end of a review run. Hand over every anchor this run found; the server confirms resolved findings that no longer show up, marks the ones that came back as regressed, and flags findings whose code moved underneath them. It never touches a verdict. Run it once, last.",
    inputSchema: {
      type: "object",
      properties: {
        target,
        repo,
        currentFindingIds: {
          type: "array",
          items: { type: "string" },
          description: "Preferred for saved findings: every current finding ID from this run, including metadata findings. Uses their authoritative fingerprints without reconstructing anchors.",
        },
        current: {
          type: "array",
          description:
            "Everything this run found, as anchors. The server fingerprints them.",
          items: {
            type: "object",
            properties: {
              file: { type: "string" },
              line: { type: "integer", minimum: 1 },
              rule: { type: "string" },
              kind: { type: "string", enum: ["metadata"] },
              subject: { type: "string", enum: ["pr-title", "pr-body", "commit-message"] },
              text: { type: "string" },
            },
            required: ["file", "line"],
          },
        },
        currentFingerprints: {
          type: "array",
          items: { type: "string" },
          description:
            "Fingerprints you already hold, if any. Usually leave this out.",
        },
      },
      required: ["target"],
    },
    run: baselineCheck,
  },
  {
    name: "export_dismissals",
    description:
      "Every failed finding, for detector calibration and rule evolution. A rule collecting invalid verdicts has a detector problem, and each invalid row without a ruleIssue still owes its report_finding issue. A rule collecting tolerated verdicts is one nobody acts on — evidence for suggesting Pascal disable it, which is his call: tolerated also covers findings that were right and carried, and only he can tell the two apart.",
    inputSchema: {
      type: "object",
      properties: {
        repo,
        since: {
          type: "string",
          description: "ISO timestamp. Only dismissals after it.",
        },
        allRepos: {
          type: "boolean",
          description: "Walk every repository in the machine-wide registry.",
        },
      },
    },
    run: exportDismissals,
  },
  {
    name: "report_finding",
    description:
      "Send a finding back to the handbook as a report about the rule that produced it: a false positive, reasoning that is wrong, or advice that could not be acted on. This is the issue an invalid verdict owes — filing it stamps links.ruleIssue on the finding, which is what says the debt was paid. A finding without a rule id reports against the review skill in general. Two calls: the first returns the exact issue text and files nothing, and the second files that text after a person has read it. Everything is scrubbed of what would name the client — the repository, the branch, the pull request and the file path are never carried, and identifiers built from them are masked — but the scrubber is a heuristic and the reading is not, so never pass confirm without showing the body to the human first.",
    inputSchema: {
      type: "object",
      properties: {
        repo,
        target,
        id: { type: "string", description: 'The finding, e.g. "T4".' },
        complaint: {
          type: "string",
          enum: Object.keys(COMPLAINTS),
          description:
            "What is wrong with it: false-positive when the rule does not apply to this code at all, wrong-reasoning when it applies and the finding argues it badly, unclear when it may be right and could not be acted on, feedback for anything else.",
        },
        why: {
          type: "string",
          description:
            "What the rule got wrong about this code, in a sentence somebody who cannot see the code will understand. This is the whole of what makes the report worth filing.",
        },
        confirm: {
          type: "boolean",
          description:
            "File it. Only ever true on a second call, after a human has read the body the first call returned.",
        },
      },
      required: ["target", "id", "complaint", "why"],
    },
    run: reportFinding,
  },
  {
    name: "regenerate_views",
    description:
      "Force-rebuild review.html and findings.sarif. Only needed after the files were edited by hand; every mutation already rebuilds them.",
    inputSchema: {
      type: "object",
      properties: { target, repo },
      required: ["target"],
    },
    run: regenerateViews,
  },
];

export function toolNamed(name: string): Tool | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

export const TOOL_NAMES = TOOLS.map((tool) => tool.name);
