/**
 * What is open, and how much of it is left.
 *
 * Everything about getting *somewhere else* moved to the rail: the list of
 * reviews, the piles, the tags, the settings. What is left here is about the
 * one review under it, which is why the bar is one line and stays one line.
 */

import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  GitCommitHorizontal,
  GitMerge,
  PanelLeftOpen,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ReviewSummary } from "../shared/domain.ts";
import { Meter } from "./Meter.tsx";
import type { Live } from "./hooks/useLive.ts";
import type { Tally } from "./filters.ts";
import { checkoutName, isMerged } from "./reviews.ts";
import { day } from "./when.ts";

/**
 * Puts text on the clipboard, from wherever this page happens to be served.
 *
 * The modern call needs a secure context, which loopback is and a machine
 * name on the network is not — and this server is reachable both ways. The
 * old call is deprecated and works in exactly the case the new one refuses,
 * so it is the fallback rather than a relic.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No clipboard object at all, or permission refused.
  }
  try {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    // Off the page but still selectable, which is what the old call needs.
    field.style.position = "fixed";
    field.style.top = "-100vh";
    document.body.append(field);
    field.select();
    const done = document.execCommand("copy");
    field.remove();
    return done;
  } catch {
    return false;
  }
}

/** How long the tick stays up: long enough to see, short enough to forget. */
const COPIED_FOR = 1400;

/**
 * Which checkout this review is of, and one click to have its path.
 *
 * The next thing anybody does with a review is go and look at the code in it,
 * and the path to it is thirty characters of hex-suffixed directory nobody is
 * going to retype. It was on the page as text you could select, which on a
 * one-line bar means selecting it without catching the title next to it.
 *
 * The icon is what says the name is a control at all — a bare monospace
 * fragment says nothing — and it is also where the confirmation goes, so
 * saying "copied" costs no width and the bar does not move under the cursor.
 */
function Checkout({ review }: { review: ReviewSummary }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, COPIED_FOR);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => {
            void copyText(review.repo).then(setCopied);
          }}
          // Shrinks, and shrinks ahead of the title beside it. A branch name
          // is the longest thing on this bar and the least of what it says;
          // held rigid it was what pushed the whole page wider than the
          // window and set the floor the layout could not go below. The
          // tooltip already carries the path in full, so an ellipsis here
          // costs nothing that a hover does not give back.
          className="flex min-w-0 shrink-[3] cursor-pointer items-center gap-1.5 font-mono text-xs text-muted transition-colors hover:text-fg"
        >
          {copied ? (
            <Check className="size-3 flex-none text-done" />
          ) : (
            <Copy className="size-3 flex-none opacity-50" />
          )}
          <span className="truncate">
            {review.pr?.headBranch ?? checkoutName(review.repo)}
          </span>
        </button>
      </TooltipTrigger>
      {/*
        The path itself, because what a copy button puts on the clipboard is
        the one thing a copy button ought to say before it is pressed.
      */}
      <TooltipContent className="font-mono text-[11px]">
        {copied ? "Copied" : review.repo}
      </TooltipContent>
    </Tooltip>
  );
}

const SAYS: Record<Live, string> = {
  connecting: "connecting",
  live: "live",
  gone: "the server this page came from has ended",
};

/** Straight to the pull request, when the review knows one. */
function PrLink({ review }: { review: ReviewSummary }) {
  const pr = review.pr;
  if (!pr?.url) return null;
  const merged = isMerged(review);
  const name = pr.number !== undefined ? `PR #${String(pr.number)}` : "PR";
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noopener"
      // The same box as the controls beside it: a chip-height link in a row of
      // h-8 buttons read as a different kind of thing.
      className={
        merged
          ? "inline-flex h-8 flex-none items-center gap-1.5 rounded-md border border-merged/65 bg-merged/12 px-2 font-mono text-xs text-merged"
          : "inline-flex h-8 flex-none items-center gap-1 rounded-md border border-line px-2 font-mono text-xs text-muted transition-colors hover:border-hitline hover:text-hitline"
      }
      title={
        pr.title
          ? `${pr.title} — open the pull request`
          : "Open the pull request"
      }
    >
      {merged && <GitMerge className="size-3.5" aria-hidden="true" />}
      {name}
      {merged ? <b className="font-semibold">merged</b> : " ↗"}
    </a>
  );
}

/**
 * How far the branch has run on since the review looked at it.
 *
 * A review is of one state of a branch, and three commits later it is still
 * worth reading and is no longer the whole story — but nothing on the page
 * said which of the two you were looking at. Beside the pull request because
 * that is the thing it is about, and quiet unless there is something to say:
 * a review that is current shows nothing at all rather than a green tick
 * nobody needs to read.
 *
 * Amber rather than red. Being behind is not a fault in the review — it is
 * the normal fate of every review of a branch somebody is still pushing to.
 */
function Behind({ review }: { review: ReviewSummary }) {
  const pr = review.pr;
  const behind = pr?.behind ?? 0;
  if (!pr || behind <= 0) return null;
  const at = pr.headSha ? ` The branch is at ${pr.headSha.slice(0, 8)}.` : "";
  return (
    <span
      className="inline-flex h-8 flex-none items-center gap-1.5 rounded-md border border-p1/50 bg-p1/12 px-2 font-mono text-xs text-p1"
      title={
        pr.rewritten
          ? `This branch was rewritten since the review ran, and has ${String(behind)} commit${behind === 1 ? "" : "s"} the review never saw. The findings were written against commits that are no longer in its history, so their line numbers may point nowhere.${at}`
          : `${String(behind)} commit${behind === 1 ? "" : "s"} landed on this branch after the review ran, and nothing here has read them.${at}`
      }
    >
      <GitCommitHorizontal className="size-3.5" aria-hidden="true" />
      {behind} behind
      {pr.rewritten && " ·  rewritten"}
    </span>
  );
}

/**
 * A pull request that landed while somebody was reading the review.
 *
 * The case that wastes a whole review, said once and never in the way.
 * Nothing is disabled: accepting a finding on a merged pull request is the
 * normal case and it goes to a follow-up. What this stops is the other thing
 * — spending a deep review on a branch that is already in.
 */
export function MergedBanner({
  review,
  onDismiss,
}: {
  review: ReviewSummary;
  onDismiss: () => void;
}) {
  // Whoever merged it, which is often not whoever opened it — and saying the
  // author here would put a name against something they may not have done.
  const who = review.pr?.mergedBy;
  const when = review.pr?.mergedAt;
  return (
    <div className="animate-in fade-in slide-in-from-top-1 flex flex-none items-center gap-2 border-b border-merged/35 bg-merged/10 px-4 py-1.5 text-[12.5px] duration-200">
      <GitMerge className="size-3.5 flex-none text-merged" aria-hidden="true" />
      <span>
        Merged{when ? ` ${day(when)}` : ""}
        {who ? ` by @${who}` : ""}.{" "}
        <span className="text-muted">
          Findings stay open — what you accept here goes to a follow-up — but a
          fresh review of this branch has nothing left to read.
        </span>
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="ml-auto flex-none cursor-pointer rounded border border-merged/45 px-2 text-xs text-merged transition-colors hover:bg-merged/10"
      >
        Got it
      </button>
    </div>
  );
}

export function Header({
  live,
  open,
  counts,
  onShowRail,
}: {
  live: Live;
  open: ReviewSummary | null;
  counts: Tally;
  /** The way back to the rail, and absent while the rail is out. */
  onShowRail?: (() => void) | undefined;
}) {
  return (
    <header className="flex h-12 flex-none items-center gap-3 border-b border-line px-4">
      {/*
        Where the rail was, so the way back is where it went. The product
        mark goes with it, which is the other thing a page loses when its
        first column is put away.
      */}
      {onShowRail && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onShowRail}
              className="-ml-1 flex-none cursor-pointer rounded p-1 text-muted transition-colors hover:text-fg"
            >
              <PanelLeftOpen className="size-4" />
              <span className="sr-only">Bring the rail back</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>Bring the rail back — b</TooltipContent>
        </Tooltip>
      )}
      {/*
        Ahead of the title, because it is the one thing here that leaves the
        page. Everything to the right of the title describes what is being
        read; this is the way out to the thing being reviewed, and a door is
        easier to find at the edge than in the middle of a sentence.
      */}
      {open && <PrLink review={open} />}
      <span className="truncate font-semibold">
        {open?.title ?? open?.target ?? "No reviews yet"}
      </span>
      {open && <Checkout review={open} />}
      {open && <Behind review={open} />}

      {/* Off the live tally rather than the review summary: this is the
          review being worked, and a verdict has to move the bar as the key is
          pressed rather than when the list is next fetched. Same numbers,
          same component, sooner. */}
      <Meter piles={counts.piles} />

      {/*
        Green while the page is being fed, because the page looks identical
        when it is not: a queue that has stopped moving and a queue with
        nothing to say are the same picture.
      */}
      <span
        className={`flex flex-none items-center gap-1.5 text-xs transition-colors ${
          live === "gone"
            ? "text-drop"
            : live === "live"
              ? "text-done"
              : "text-muted"
        }`}
      >
        {/*
          The dot is what a glance reads; the word is what the dot means.
          Connecting is the only state that is in motion, so it is the only
          dot that moves.
        */}
        <span
          className={`size-1.5 rounded-full ${
            live === "gone"
              ? "bg-drop"
              : live === "live"
                ? "bg-done"
                : "animate-pulse bg-muted"
          }`}
        />
        {SAYS[live]}
      </span>
    </header>
  );
}
