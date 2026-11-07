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
  baselineCheck,
  enabledRules,
  listReviews,
  reviewStatus,
  openInbox,
  setNote,
  setReported,
  setResolution,
  setStage,
  setVerdict,
  startReview,
} from "./api.mts";
import {
  ACTOR,
  type ReviewStatus,
  PRIORITY,
  RESOLUTION,
  VERDICT,
} from "./model/types.mts";
import { CRUD_TOOLS } from "./crud-tools.mts";
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
  annotations?: {
    idempotentHint?: boolean;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
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
  const where =
    status.state === "done"
      ? "finished"
      : status.state === "quiet"
        ? "not finished, and nothing written for a while"
        : status.phase
          ? `running ${status.phase}`
          : "running";
  return [
    `${status.target}: ${where}. ${String(status.findings.length)} findings, ${String(open)} still need a verdict.`,
    ...(status.verdict ? [status.verdict] : []),
    `Review Inbox: ${status.url}`,
  ].join("\n");
}

const REVIEW_TOOLS: Tool[] = [
  ...QUEUE_TOOLS,
  {
    name: "start_review",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Local filesystem operation only: saves review metadata and registers the loopback inbox; does not upload repository or PR data, post to GitHub, or call an external service. Announce a review, before any finding exists, and record what the pull request is. Call it once as soon as the target is known: it puts the review in the Review Inbox, so a link posted at the start of a run opens something rather than nothing, and a run that finds no problem still shows that it happened. Pass the known pull request facts — number, title, author, when it was opened — because nothing later can recover them and "pr-356" on its own says nothing about what is being reviewed. This tool advertises a review-card resource, but only the host can confirm that it rendered. Do not claim it is open from tool success alone. Do not immediately call review_status to check rendering: a supporting host creates a second widget. A text result or Inbox link does not prove rendering success or failure. Safe to call again to update the state of the pull request; it never changes when the review started.',
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
    says: (result) => {
      const summary = result as { repo: string; target: string };
      const status = reviewStatus({repo:summary.repo,target:summary.target},summary.repo);
      return JSON.stringify({
        ...(result as object),
        url: status.url,
        link: status.link,
        reviewCard: {
          resourceUri: REVIEW_CARD,
          delivery: "unconfirmed",
          instructions: "This tool advertises the review-card resource; rendering is controlled by the host and is not confirmed by this response. Do not say the card is open without host attachment or visual confirmation. Do not immediately call review_status to check rendering: supporting hosts create a second widget. Always include the inbox link; use get_review_session for progress checks.",
        },
      }, null, 2);
    },
    card: REVIEW_CARD,
    forCard: reviewStatus,
  },
  {
    name: "review_status",
    annotations: { readOnlyHint: true },
    description:
      "Where a review stands: the active queue phase, how many findings there are and how many still need a decision. In a host that draws cards this shows the live review card, with the findings and the track to rule on them, so call it when the user asks to see a review or how one is going. Do not call it to read findings: list_findings and get_finding are for that, and this answers with a summary.",
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
    name: "set_verdict",
    description:
      'Record what the user decided about a finding: "accepted" (real, to be reported or fixed), "invalid" (the review got it wrong — the finding then owes a report_finding issue, and links.ruleIssue is the stamp it was filed), "tolerated" (it stands and is carried on purpose: taste, out of scope, or outranked — nothing further happens to it), or back to "undecided". This decision belongs to the user, so it always needs actor "human" and you may only call it when the user explicitly asked. It says nothing about whether the code was fixed; that is set_resolution.',
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
            'Always "human". Anything else is refused, because nobody but the user decides whether a finding is a problem.',
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
          description:
            "Preferred for saved findings: every current finding ID from this run, including metadata findings. Uses their authoritative fingerprints without reconstructing anchors.",
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
              subject: {
                type: "string",
                enum: ["pr-title", "pr-body", "commit-message"],
              },
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
];

// Existing inbox controls and saved sessions use these adapters. Models receive CRUD.
const uiControls = new Set([
  "set_verdict",
  "set_stage",
  "set_resolution",
  "set_note",
  "set_reported",
]);
export const TOOLS: Tool[] = [
  ...CRUD_TOOLS,
  ...REVIEW_TOOLS.map((t) =>
    uiControls.has(t.name) ? { ...t, cardOnly: true } : t,
  ),
];

export function toolNamed(name: string): Tool | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

export const TOOL_NAMES = TOOLS.map((tool) => tool.name);
