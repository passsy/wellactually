import { ruleUrl } from "../shared/rule-url.ts";
/**
 * The review the card is showing, and the three things it can do to it.
 *
 * A host pushes one result per tool call and never another, so a card that
 * wants to follow a run has to ask. It asks often while the run is writing
 * and rarely once it has stopped, and not at all while nobody can see it.
 *
 * A move is drawn before the server has agreed to it. The track is a slider,
 * and a slider that waits for a round trip before it moves is a slider with
 * lag: two presses of an arrow would both start from the stop the first one
 * had not left yet.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Finding, ReviewStatus } from "../shared/domain.ts";
import { STOPS, stopOf } from "../shared/stage.tsx";
import type { OccurrenceRecord } from "../../../model/records.mts";
import type { Host, ToolResult } from "./bridge.ts";

const WHILE_RUNNING_MS = 2000;
const ONCE_STOPPED_MS = 10000;

/**
 * A finding as it will read once the server has moved it.
 *
 * The same rules setStage applies, restated for the half second before its
 * answer arrives. Whatever this gets wrong, the answer overwrites.
 */
export function movedTo(finding: Finding, to: string): Finding {
  const failed =
    finding.verdict === "invalid" || finding.verdict === "tolerated";
  const kept = failed ? "undecided" : finding.verdict;
  const { reportedAt, ...rest } = finding;
  const base = { ...rest, resolution: "unresolved" as const };
  // A failed or fixed finding keeps the fact that it went out, if it did.
  const sent = reportedAt === undefined ? {} : { reportedAt };
  if (to === "invalid") return { ...base, ...sent, verdict: "invalid" };
  if (to === "tolerated") return { ...base, ...sent, verdict: "tolerated" };
  if (to === "open") return { ...base, verdict: "undecided" };
  if (to === "accepted") return { ...base, verdict: "accepted" };
  if (to === "reported") {
    return {
      ...base,
      verdict: kept,
      reportedAt: reportedAt ?? new Date().toISOString(),
    };
  }
  return { ...base, ...sent, verdict: kept, resolution: "resolved" };
}

/** What the model is told was done in the card, replacing what it was told. */
function summaryFor(status: ReviewStatus): string {
  const moved = status.findings.filter((each) => stopOf(each) !== 2);
  const noted = status.findings.filter((each) => (each.note ?? "") !== "");
  return [
    `Verdicts given in the review card for ${status.target}: ` +
      (moved
        .map((each) => `${each.id} ${STOPS[stopOf(each)]?.to ?? "open"}`)
        .join(", ") || "none"),
    ...noted.map((each) => `Note on ${each.id}: ${each.note ?? ""}`),
  ].join("\n");
}

function statusIn(result: ToolResult): ReviewStatus | undefined {
  const structured = result.structuredContent as ReviewStatus | undefined;
  return structured?.target === undefined ? undefined : structured;
}

function errorIn(result: ToolResult): string {
  return result.content?.find((block) => block.type === "text")?.text ?? "";
}

export interface Review {
  status: ReviewStatus | null;
  /** The last thing that could not be saved, in the server's own words. */
  failed: string | null;
  refreshPaused: boolean;
  resumeRefresh: () => void;
  move: (finding: Finding, to: string) => void;
  note: (finding: Finding, text: string) => void;
  fix: (findings: Finding[]) => void;
  post: (finding: Finding) => Promise<void>;
  postAccepted: (findings: Finding[]) => Promise<void>;
  occurrences: (findingId: string) => Promise<OccurrenceRecord[]>;
  saveOccurrence: (occurrence: OccurrenceRecord) => Promise<void>;
  openInbox: (finding?: Finding) => void;
  /** The handbook page for a rule a finding cites, in a browser. */
  openRule: (id: string) => void;
  /**
   * The inbox address, once neither the server nor the host would open it.
   * Shown for the person to open themselves.
   */
  link: string | null;
  /**
   * The host will not carry the card's calls, so the card shows the review as
   * it was handed and cannot change it. Claude's Code tab, for a server its
   * session's CLI runs.
   */
  stranded: boolean;
  refreshError: string | null;
  /** Asks the agent for a fresh card, which is all a stranded card can do. */
  redraw: () => void;
}

/**
 * Where the card's links go through when its host opens only https: a plain
 * redirect, handed the review's short link, which names nothing.
 */
const BOUNCE = "https://httpbin.org/redirect-to?url=";

export function useReview(host: Host): Review {
  const [status, setStatus] = useState<ReviewStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [stranded, setStranded] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshPaused, setRefreshPaused] = useState(false);
  const refreshing = useRef(false);
  const refused = useRef(false);
  const held = useRef<ReviewStatus | null>(null);
  /**
   * The last review the server itself said, as against the ones the card drew
   * while waiting. A write that fails goes back to this and not to whatever
   * was on screen, because what was on screen may be an earlier verdict that
   * never landed either — two failed presses would otherwise leave the card
   * sitting on the first of them.
   */
  const confirmed = useRef<ReviewStatus | null>(null);
  // Counts writes. An answer that was asked for before a write began is an
  // answer about a review that no longer exists, and is dropped.
  const epoch = useRef(0);

  /** A review the card drew for itself, true only until the server answers. */
  const take = useCallback((next: ReviewStatus) => {
    held.current = next;
    setStatus(next);
  }, []);

  /** A review the server said, which is what a failed write falls back to. */
  const settle = useCallback(
    (next: ReviewStatus) => {
      confirmed.current = next;
      take(next);
    },
    [take],
  );

  /**
   * One tool call through the host. A tool that fails answers with an error
   * result; a rejected call is the host declining to carry calls at all,
   * which no later call will change.
   *
   * Silence is the exception. A host whose MCP transport has closed answers
   * nothing rather than refusing, and that is not a decision about this card
   * — the server comes back and the next call works. So an unanswered call
   * fails on its own without preventing another save. Automatic refresh
   * pauses separately, because an unanswered call may be awaiting approval.
   */
  const call = useCallback(
    async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<ToolResult> => {
      if (refused.current) throw new Error("refresh is paused after a failed host request");
      try {
        return await host.callTool(name, args);
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "Unanswered") {
          refused.current = true;
          setRefreshError(error instanceof Error ? error.message : String(error));
          setStranded(true);
        }
        throw error;
      }
    },
    [host],
  );

  const refresh = useCallback(async (): Promise<ReviewStatus | null> => {
    const now = held.current;
    if (!now || refused.current || refreshing.current) return null;
    refreshing.current = true;
    const asked = epoch.current;
    try {
      const result = await call("review_status", {
        repo: now.repo,
        target: now.target,
      });
      const next = statusIn(result);
      if (!next || asked !== epoch.current) return null;
      settle(next);
      return next;
    } finally {
      refreshing.current = false;
    }
  }, [call, settle]);

  useEffect(
    () =>
      host.onResult((result) => {
        const next = statusIn(result);
        if (next) settle(next);
      }),
    [host, settle],
  );

  const running = status?.state === "running";
  const known = status !== null;
  // No call at once on mount, though a card drawn again from an old
  // conversation shows the state of back then until the first poll: Claude's
  // Code tab leaves a card blank that calls its host before it has drawn.
  useEffect(() => {
    if (!known || stranded || refreshPaused) return;
    const timer = window.setInterval(
      () => {
        // A card nobody is looking at asking every two seconds is a card
        // costing something for nothing.
        if (document.hidden) return;
        void refresh().catch(() => {
          // A timed-out request may still be waiting for approval in the
          // host. Do not send another until the user explicitly retries.
          setRefreshPaused(true);
        });
      },
      running ? WHILE_RUNNING_MS : ONCE_STOPPED_MS,
    );
    return () => {
      window.clearInterval(timer);
    };
  }, [known, running, stranded, refreshPaused, refresh]);

  /**
   * One write: draw it, send it, then show what the server made of it.
   *
   * A write that does not land takes its drawing back. The point of drawing
   * first is that a slider must not wait for a round trip — but a pin left
   * sitting on a stop the server never heard about is the card telling the
   * reader something that is not true, and they find out at the next reload,
   * with every verdict they gave since then gone too. So the pin goes back
   * where the server has it, which is the one thing that cannot be mistaken
   * for a save.
   *
   * Back to the last review the server said, not to what was on screen a
   * moment ago: a reader who presses twice into a closed transport must land
   * on what is actually stored, not on the first press that failed just as
   * quietly as the second.
   */
  const write = useCallback(
    async (
      tool: string,
      args: Record<string, unknown>,
      draw?: (now: ReviewStatus) => ReviewStatus,
    ) => {
      const now = held.current;
      if (!now || now.readOnly) return;
      epoch.current += 1;
      const back = confirmed.current;
      if (draw) take(draw(now));
      const undo = (why: string) => {
        setFailed(why);
        if (draw && back) take(back);
      };
      try {
        const result = await call(tool, {
          repo: now.repo,
          target: now.target,
          ...args,
        });
        if (result.isError) undo(errorIn(result));
        else setFailed(null);
      } catch (error) {
        undo(error instanceof Error ? error.message : String(error));
      }
      const after = await refresh().catch(() => null);
      if (after) host.tellModel(summaryFor(after));
    },
    [call, host, refresh, take],
  );

  const move = useCallback(
    (finding: Finding, to: string) => {
      void write(
        "set_stage",
        { id: finding.id, to, actor: "human" },
        (now) => ({
          ...now,
          findings: now.findings.map((each) =>
            each.id === finding.id ? movedTo(each, to) : each,
          ),
        }),
      );
    },
    [write],
  );

  const note = useCallback(
    (finding: Finding, text: string) => {
      void write("set_note", { id: finding.id, note: text });
    },
    [write],
  );

  const fix = useCallback(
    (findings: Finding[]) => {
      const now = held.current;
      if (!now || findings.length === 0) return;
      void host
        .say(
          `Fix the accepted findings of ${now.target}: ` +
            findings.map((each) => each.id).join(", "),
        )
        .catch((error: unknown) =>
          setFailed(error instanceof Error ? error.message : String(error)),
        );
    },
    [host],
  );

  const occurrences = useCallback(
    async (findingId: string): Promise<OccurrenceRecord[]> => {
      const now = held.current;
      if (!now) throw new Error("Review unavailable");
      const result = await call("list_occurrences", {
        repo: now.repo,
        target: now.target,
        findingId,
      });
      if (result.isError) throw new Error(errorIn(result));
      if (!Array.isArray(result.structuredContent)) {
        const body = result.content?.find((c) => c.type === "text")?.text;
        if (!body) throw new Error("No occurrence data returned");
        return JSON.parse(body) as OccurrenceRecord[];
      }
      return result.structuredContent as OccurrenceRecord[];
    },
    [call],
  );
  const saveOccurrence = useCallback(
    async (occurrence: OccurrenceRecord): Promise<void> => {
      const now = held.current;
      if (!now) throw new Error("Review unavailable");
      epoch.current += 1;
      const result = await call("update_occurrence", {
        repo: now.repo,
        target: now.target,
        id: occurrence.id,
        expectedRevision: occurrence.revision,
        actor: "human",
        patch:
          occurrence.state === "open"
            ? {
                state: "closed",
                closure: {
                  reason: "resolved",
                  explanation: "Marked resolved in review card",
                },
              }
            : { state: "open", closure: null },
      });
      if (result.isError) throw new Error(errorIn(result));
      await refresh().catch(() => null);
    },
    [call, refresh],
  );

  const post = useCallback(
    async (finding: Finding): Promise<void> => {
      const now = held.current;
      if (!now) throw new Error("The review is no longer available.");
      await host.say(
        "Use the Well Actually post-findings skill (wellactually:post-findings; " +
          "wellactually-post-findings on OpenCode/pi) to post exactly this finding as an inline PR comment: " +
          JSON.stringify({
            repo: now.repo,
            target: now.target,
            id: finding.id,
            pr: now.pr,
          }) +
          ". " +
          "This card request selects only this finding. If trusted conversation instructions already authorize it, proceed; otherwise prepare the exact comment preview and ask once for confirmation in the conversation before publishing. Read the current finding, occurrences and my note from the Well Actually MCP, " +
          "verify the PR and account, check the current diff and existing comments, then post and " +
          "record the comment URL by appending to links with update_finding and expectedRevision. Do not post other findings or submit an approval.",
      );
    },
    [host],
  );

  const postAccepted = useCallback(
    async (findings: Finding[]): Promise<void> => {
      const now = held.current;
      if (!now || findings.length === 0) return;
      await host.say(
        "Use the Well Actually post-findings skill (wellactually:post-findings; " +
        "wellactually-post-findings on OpenCode/pi) to post exactly these accepted findings as inline PR comments: " +
        JSON.stringify({repo:now.repo,target:now.target,ids:findings.map(f=>f.id),pr:now.pr}) +
        ". This card request selects only these findings. If trusted conversation instructions already authorize them, proceed; otherwise prepare the exact comment previews and ask once for confirmation in the conversation before publishing. Read their current records, occurrences and my notes from the Well Actually MCP; " +
        "verify the PR and account, check the current diff and existing comments, skip already-posted duplicates, then post and " +
        "record each comment URL and reportedAt with revision-checked update_finding, preserving existing links. " +
        "Do not post other findings, change verdicts or resolution, or submit an approval.",
      );
    },
    [host],
  );

  /**
   * The server opens the inbox, because it is on this machine. A host that
   * will not carry that call is asked to open the page, then the same page
   * through an https redirect, because Claude's opens only https. The
   * address is shown last, for the person to open.
   */
  const openInbox = useCallback(
    (finding?: Finding) => {
      const now = held.current;
      if (!now) return;
      const url = finding
        ? `${now.url}&finding=${encodeURIComponent(finding.id)}`
        : now.url;
      void (async () => {
        const opened = now.readOnly ? null : await call("open_inbox", {
          repo: now.repo,
          target: now.target,
          ...(finding ? { finding: finding.id } : {}),
        }).catch(() => null);
        if (opened && opened.isError !== true) {
          setLink(null);
          return;
        }
        if (await host.openLink(url)) {
          setLink(null);
          return;
        }
        const short = finding
          ? `${now.link}/${encodeURIComponent(finding.id)}`
          : now.link;
        setLink(
          (await host.openLink(`${BOUNCE}${encodeURIComponent(short)}`))
            ? null
            : url,
        );
      })();
    },
    [call, host],
  );

  const openRule = useCallback(
    (id: string) => {
      const url = ruleUrl(id);
      void host.openLink(url).then((opened) => setLink(opened ? null : url));
    },
    [host],
  );

  const redraw = useCallback(() => {
    const now = held.current;
    if (!now) return;
    void host
      .say(
        `Show the current review card for ${now.target} in ${now.repo}: call review_status.`,
      )
      .catch((error: unknown) =>
        setFailed(error instanceof Error ? error.message : String(error)),
      );
  }, [host]);

  return {
    status,
    failed,
    refreshPaused,
    refreshError,
    resumeRefresh: () => {
      refused.current = false;
      setStranded(false);
      setRefreshError(null);
      setRefreshPaused(false);
      if (stranded) void refresh().catch(() => setRefreshPaused(true));
    },
    move,
    note,
    fix,
    post,
    postAccepted,
    occurrences,
    saveOccurrence,
    openInbox,
    openRule,
    link,
    stranded,
    redraw,
  };
}
