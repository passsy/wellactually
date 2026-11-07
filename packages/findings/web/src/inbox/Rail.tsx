/**
 * Where you are, what is left, and the way to both.
 *
 * A fixed column holding three things that were previously behind a keystroke
 * you had to already know about, behind a menu, or nowhere: every review on
 * the machine, every pile of this one with a live count, and every tag it
 * uses. None of them is new — what is new is that the page says them without
 * being asked.
 *
 * Two halves, each scrolling on its own. One scroller would put the piles
 * below however many reviews the machine happens to be holding, which moves
 * the control you use every minute every time a review starts.
 */

import { useState, type ReactNode, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Bell,
  BellOff,
  GitBranch,
  Flag,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Keyboard,
  MessageSquare,
  PanelLeftClose,
  RefreshCw,
  Search,
  type LucideIcon,
} from "lucide-react";
import { Tag } from "../shared/chips.tsx";
import { cn } from "../shared/cn.ts";
import type { ReviewSummary } from "../shared/domain.ts";
import { readHealth, refreshPrs } from "./api.ts";
import { countFor, FILTERS, type Tally } from "./filters.ts";
import { Meter } from "./Meter.tsx";
import { nameOf, standingOf, type Standing } from "./reviews.ts";
import { since, when } from "./when.ts";
import { useTheme } from "./hooks/useTheme.ts";
import { useNotify } from "./hooks/useNotify.ts";

/**
 * The product mark: the track, shrunk to nothing.
 *
 * A cut with a pin dropped in it. The one control this whole page is built
 * around, at the size of a favicon — which is the only kind of logo worth
 * drawing for a tool that has exactly one idea in it.
 */
function Mark() {
  return (
    <span className="relative size-[22px] flex-none rounded-md bg-fg/8">
      <span
        className="absolute top-1/2 right-1 left-1 h-[3px] -translate-y-1/2 rounded-full bg-[var(--cut)] shadow-[var(--sink)]"
        aria-hidden="true"
      />
      <span
        className="absolute top-1/2 right-[3px] size-[9px] -translate-y-1/2 rounded-full bg-todo"
        aria-hidden="true"
      />
    </span>
  );
}

/**
 * The rows whose mark is drawn instead of typed.
 *
 * The piles wear the track's own engravings, which are characters, because
 * they are the same marks the control carries. "Noted" is not a stop on any
 * track and has no character to borrow: everything that means "somebody wrote
 * this" — the pencil, the writing hand — is handed back by the platform as a
 * colour emoji, which puts the only yellow object on the page next to the
 * quietest row in the rail.
 */
const DRAWN: Record<string, LucideIcon> = {
  noted: MessageSquare,
  flagged: Flag,
};

function Heading({ children }: { children: ReactNode }) {
  return (
    <h3 className="mx-3 mt-3 mb-[3px] text-[0.63rem] font-semibold tracking-[0.09em] text-muted uppercase">
      {children}
    </h3>
  );
}

/**
 * One of the reviews on this machine, as a row of the rail.
 *
 * Four facts in two lines, and the two that decide whether to open it are on
 * the same side of the same line: how much of it nobody has read, and whether
 * the pull request it is about has already landed. The line under them is
 * which change it is and how long ago the run happened — which is also the
 * order the list is in, said on every row rather than in a heading, because
 * a date per row is what makes an order visible at all.
 */
/**
 * What each standing is drawn as, and what it is worth noticing.
 *
 * Colour is spent on the two that change what a reader does. Merged is the
 * one that can waste a whole review, and it keeps the purple it wears
 * everywhere else on this page. Landed is the same fact about a branch that
 * no pull request is carrying, so it is the same colour: the shape says which
 * kind of thing it was, the colour says it is over.
 *
 * The rest are quiet on purpose. An open pull request is what most rows are,
 * and a column of coloured marks that are all the same mark is a column with
 * nothing standing out of it. They are here to be told apart from each other,
 * not to be noticed.
 */
const STANDS: Record<
  Standing,
  { icon: LucideIcon; tone: string; says: string }
> = {
  merged: { icon: GitMerge, tone: "text-merged", says: "merged" },
  closed: {
    icon: GitPullRequestClosed,
    tone: "text-drop",
    says: "closed without merging",
  },
  open: { icon: GitPullRequest, tone: "text-muted", says: "open" },
  asking: {
    icon: GitPullRequest,
    tone: "text-muted opacity-40",
    says: "a pull request nothing has been able to ask about",
  },
  landed: {
    icon: GitMerge,
    tone: "text-merged",
    says: "a branch that has reached the trunk",
  },
  branch: {
    icon: GitBranch,
    tone: "text-muted",
    says: "a branch, with no pull request",
  },
  unknown: { icon: GitBranch, tone: "text-muted opacity-40", says: "" },
};

function Standing({ review }: { review: ReviewSummary }) {
  const standing = standingOf(review);
  const { icon: Icon, tone } = STANDS[standing];
  const base = review.branch?.base;
  const says =
    standing === "landed" && base
      ? `This branch has reached ${base} — what it changed is in the trunk`
      : standing === "branch" && base
        ? `A branch with no pull request, and not in ${base} yet`
        : STANDS[standing].says;
  if (standing === "unknown") return null;
  return <Icon className={cn("size-3 flex-none", tone)} aria-label={says} />;
}

function ReviewRow({
  review,
  on,
  onOpen,
}: {
  review: ReviewSummary;
  on: boolean;
  onOpen: () => void;
}) {
  const count = review.counts.unread;
  const behind = review.pr?.behind ?? 0;
  const name = nameOf(review);
  return (
    <button
      type="button"
      data-review
      aria-current={on}
      onClick={onOpen}
      className={cn(
        "grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2 px-3 py-[5px] text-left transition-colors",
        on ? "bg-at shadow-[inset_2px_0_0_0_var(--todo)]" : "hover:bg-at/50",
      )}
    >
      <span className="col-start-1 row-start-1 truncate text-[13px] font-semibold">
        {review.title ?? review.target}
      </span>
      <span className="col-start-2 row-start-1 flex flex-none items-center gap-1">
        {/*
          A pull request that landed while nobody was looking is the case that
          wastes a whole review, so it is said here rather than only after the
          review has been opened and a finding read — and the rest are here so
          that one reads as a state rather than as the only row with a mark.
        */}
        <Standing review={review} />
        {/*
          The one number on the row worth full contrast: the rest is context
          for choosing and this is the reason to choose. Lettered in the
          page's own background, the one colour guaranteed to read on the fill
          in either theme.
        */}
        {count > 0 && (
          <span
            className="min-w-5 rounded-full bg-todo px-1.5 text-center text-[0.7rem] font-bold text-bg"
            title={`${String(count)} finding${count === 1 ? "" : "s"} you have not read`}
          >
            {count}
          </span>
        )}
      </span>
      {/*
        A branch name can outrun the column even after the repeated half is
        gone, and this is the line that says which review this is, so what
        does not fit is on the hover rather than lost.
      */}
      <span
        className="col-start-1 row-start-2 truncate font-mono text-[11px] text-muted"
        title={`${name.says}${name.apart ? " · " : " "}${name.where}`}
      >
        <span className="text-fg/70">{name.says}</span>
        {name.apart ? " · " : " "}
        {name.where}
      </span>
      {/*
        How current this review is, as two facts side by side: how far its
        branch has run on since, and how long ago it ran. They answer the same
        question from two directions, so they sit together rather than one of
        them joining the counts up on the title line.
      */}
      <span className="col-start-2 row-start-2 flex flex-none items-center gap-1.5 font-mono text-[11px] whitespace-nowrap text-muted">
        {behind > 0 && (
          <span
            className="flex items-center gap-0.5 text-p1"
            title={
              review.pr?.rewritten
                ? `This branch was rewritten since the review ran, and has ${String(behind)} commit${behind === 1 ? "" : "s"} the review never saw`
                : `${String(behind)} commit${behind === 1 ? "" : "s"} landed on this branch after the review ran`
            }
          >
            <GitCommitHorizontal className="size-3" aria-hidden="true" />
            {behind}
          </span>
        )}
        <span title={`This review ran ${when(review.startedAt)}`}>
          {since(review.startedAt)}
        </span>
      </span>
      {/*
        How far through it is, without a word spent on it. Three pixels under
        the row, the same six colours in the same order as the bar in the
        header — so a list of reviews reads as a column of how-far-along, and
        picking the one with grey left in it needs no counting. The words are
        on the tooltip for whoever wants the number.
      */}
      <span className="col-span-2 row-start-3 mt-1">
        {review.error ? <span className="text-xs text-p1" title={review.error}>Review needs attention</span> : <Meter piles={review.counts.piles} bare />}
      </span>
    </button>
  );
}

export function Rail({
  reviews,
  open,
  onOpen,
  reviewsRef,
  counts,
  filter,
  onFilter,
  tags,
  tagCounts,
  tag,
  onTag,
  onCommand,
  keysOpen,
  onKeys,
  showing = true,
  onShowing,
  width = 291,
  onGrip,
  onGripReset,
}: {
  reviews: ReviewSummary[];
  open: ReviewSummary | null;
  onOpen: (review: ReviewSummary) => void;
  /** Where the key that means "somewhere else" puts the focus. */
  reviewsRef: RefObject<HTMLDivElement | null>;
  counts: Tally;
  filter: string;
  onFilter: (filter: string) => void;
  tags: string[];
  tagCounts: Record<string, number>;
  tag: string | null;
  onTag: (tag: string) => void;
  onCommand: () => void;
  keysOpen: boolean;
  onKeys: () => void;
  /** Whether the rail is out. Put away it costs no width at all. */
  showing?: boolean;
  onShowing: (showing: boolean) => void;
  /** How wide it is when it is out, in pixels. */
  width?: number;
  onGrip?: ((event: React.PointerEvent<HTMLDivElement>) => void) | undefined;
  onGripReset?: (() => void) | undefined;
}) {
  const [theme, cycle] = useTheme();
  const notify = useNotify(reviews);
  /** The last hand-driven check, and what every review had to say for itself. */
  const [checking, setChecking] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  // Asked once. The process on the other end cannot change version without
  // this page being served again by a different one.
  const health = useQuery({
    queryKey: ["health"],
    queryFn: readHealth,
    staleTime: Infinity,
  });

  return (
    /*
      Put away to nothing rather than to a strip of icons. A column of pile
      glyphs with counts and no words is a legend to learn, and the reviews —
      which are titles — cannot be icons at all. What is left when this is
      away is ⌘K, which reaches everything in here by name and is the reason
      the rail can afford to go.

      The width animates and the contents do not: the inner column keeps its
      own 224px, so nothing inside reflows on the way out. Reduced motion
      takes the transition away with everything else on the page.
    */
    <nav
      aria-label="Reviews and filters"
      // Not aria-hidden: a hidden container full of tabbable buttons is worse
      // than none, because the keyboard still walks into a column nobody can
      // see. `inert` takes it out of the tab order and the tree together.
      inert={!showing}
      className={cn(
        // min-w-0 is what makes the width mean anything: a flex item's
        // min-width is auto, so the column inside would hold this open at its
        // own size however narrow the width says to be.
        // The width eases so that folding away is a movement rather than a
        // jump. While a grip is held it must not: inbox.css switches every
        // transition off under `body.dragging`, because a column that arrives
        // where the cursor *was* reads as being towed on a string.
        "relative flex min-w-0 flex-none flex-col overflow-hidden bg-rail transition-[width] duration-200",
        showing && "border-r border-line",
      )}
      style={{ width: showing ? width : 0 }}
    >
      {/*
        The grip is on the rail's own edge rather than between two columns,
        the same way the file panel's is: what is on the other side of it is
        a resizable group that would fight over the pixels.
      */}
      {onGrip && showing && (
        <div
          // Wide enough to catch a pointer, and invisible: what lights up is
          // the hairline inside it, so a grip looks like the separators
          // between the panes — which are also 1px and also go blue — rather
          // than like a band of colour laid over the edge.
          className="group absolute top-0 right-0 bottom-0 z-10 w-[7px] cursor-col-resize"
          onPointerDown={onGrip}
          onDoubleClick={onGripReset}
        >
          <span className="absolute inset-y-0 right-0 w-px transition-colors group-hover:bg-todo group-active:bg-todo" />
        </div>
      )}
      <div className="flex h-full flex-none flex-col" style={{ width }}>
        <div className="flex flex-none items-center gap-2 px-3 pt-[11px] pb-2">
          <Mark />
          <span className="text-[13px] font-semibold">Review Inbox</span>
          {/*
            Ask the forges now.

            Beside the reviews it acts on, rather than down in the settings
            at the foot: this is not a preference, it is the one control on
            the page that goes and finds something out. The check it runs by
            hand is the same one that runs every ten minutes on its own — and
            that one writes only when something changed, which is right and is
            also invisible. Press nothing, see nothing, and a check that has
            been quietly answering "no" since it was installed looks exactly
            like one that works. This says what it found, per review,
            including the reviews where nothing could be asked at all.
          */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={checking}
                className="ml-auto cursor-pointer rounded p-1 text-muted transition-colors hover:text-fg disabled:cursor-default"
                onClick={() => {
                  setChecking(true);
                  refreshPrs()
                    .then((answer) => {
                      const moved = answer.checked.filter(
                        (one) => one.why === "changed",
                      ).length;
                      setSaid(
                        [
                          `${String(answer.checked.length)} asked · ${String(moved)} changed`,
                          ...answer.checked.map(
                            (one) =>
                              `${one.target} — ${one.why}${one.state ? ` (${one.state})` : ""}`,
                          ),
                        ].join("\n"),
                      );
                    })
                    .catch((error: unknown) => {
                      setSaid(
                        error instanceof Error ? error.message : "no answer",
                      );
                    })
                    .finally(() => {
                      setChecking(false);
                    });
                }}
              >
                <RefreshCw
                  className={cn("size-4", checking && "animate-spin")}
                />
                <span className="sr-only">
                  Ask every pull request whether it has landed
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-80 whitespace-pre-line">
              {said ??
                "Ask every pull request whether it has landed. Checked on its own every ten minutes."}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  onShowing(false);
                }}
                className="-mr-1 cursor-pointer rounded p-1 text-muted transition-colors hover:text-fg"
              >
                <PanelLeftClose className="size-4" />
                <span className="sr-only">Put the rail away</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>Put the rail away — b</TooltipContent>
          </Tooltip>
        </div>

        {/*
        Every view on this page has a name, so one box can reach all of them.
        Drawn as what it is — a search field with its key on it — rather than
        as a button, because the thing it opens is a place to type.
      */}
        <button
          type="button"
          onClick={onCommand}
          className="mx-2.5 mt-0.5 mb-1.5 flex h-[30px] cursor-pointer items-center gap-1.5 rounded-md border border-line bg-bg px-2 text-[12.5px] text-muted transition-colors hover:border-hitline hover:text-hitline"
        >
          <Search className="size-3.5 flex-none" aria-hidden="true" />
          Jump to anything
          <span className="ml-auto flex gap-[3px]">
            <kbd className="rounded border border-chip px-1 py-px font-mono text-[0.7rem]">
              ⌘
            </kbd>
            <kbd className="rounded border border-chip px-1 py-px font-mono text-[0.7rem]">
              K
            </kbd>
          </span>
        </button>

        <div className="flex min-h-0 flex-1 flex-col">
          <Heading>Reviews</Heading>
          <ScrollArea className="min-h-0 flex-1">
            <div ref={reviewsRef}>
              {reviews.length === 0 && (
                <p className="px-3 py-1 text-[13px] text-muted">
                  No reviews yet.
                </p>
              )}
              {reviews.map((review) => (
                <ReviewRow
                  key={`${review.repo} ${review.target}`}
                  review={review}
                  on={
                    review.repo === open?.repo && review.target === open.target
                  }
                  onOpen={() => {
                    onOpen(review);
                  }}
                />
              ))}
            </div>
          </ScrollArea>
        </div>

        <div className="flex min-h-0 flex-1 flex-col border-t border-line">
          <Heading>This review</Heading>
          <ScrollArea className="min-h-0 flex-1">
            {FILTERS.map((one) => {
              const count = countFor(counts, one.value);
              const on = one.value === filter;
              const Drawn = DRAWN[one.value];
              return (
                <button
                  key={one.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    onFilter(one.value);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-[3px] text-left text-[13px] transition-colors",
                    on
                      ? "bg-at font-semibold shadow-[inset_2px_0_0_0_var(--todo)]"
                      : "hover:bg-at/50",
                    // An empty pile is still worth showing — it is where a
                    // finding will land — but it is not worth reading.
                    count === 0 && !on && "text-muted",
                  )}
                >
                  <span
                    className={cn(
                      "inline-flex w-[13px] flex-none justify-center text-xs",
                      one.tone,
                    )}
                    aria-hidden="true"
                  >
                    {Drawn ? <Drawn className="size-3" /> : one.mark}
                  </span>
                  {one.says}
                  <span className="ml-auto font-mono text-[11.5px] text-muted">
                    {count}
                  </span>
                </button>
              );
            })}

            {tags.length > 0 && (
              <>
                <Heading>Tags</Heading>
                <div className="flex flex-wrap gap-1 px-3 pt-0.5 pb-2">
                  {tags.map((one) => (
                    <Tag
                      key={one}
                      on={one === tag}
                      title={
                        one === tag
                          ? "Show every finding again"
                          : `Hold the queue to everything tagged "${one}"`
                      }
                      onPick={() => {
                        onTag(one);
                      }}
                    >
                      {one}{" "}
                      <span className="opacity-60">{tagCounts[one] ?? 0}</span>
                    </Tag>
                  ))}
                </div>
              </>
            )}
          </ScrollArea>
        </div>

        {/*
        Settings-shaped, all three of them, which is why they are down here
        rather than in the header: the header is about the review under it.
      */}
        <div className="flex flex-none items-center gap-1 border-t border-line px-2 py-1.5">
          {notify.state !== "unavailable" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  id="notify"
                  className="size-8 p-0"
                  onClick={notify.ask}
                  disabled={
                    notify.state === "refused" || notify.state === "asking"
                  }
                >
                  {notify.state === "on" ? (
                    <Bell className="size-4" />
                  ) : (
                    <BellOff className="size-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {notify.state === "on"
                  ? "Telling you when a review starts — press to stop"
                  : notify.state === "refused"
                    ? "This browser is set to refuse notifications from this page"
                    : "Tell me when a review starts"}
              </TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="size-8 p-0"
                onClick={cycle}
              >
                {theme.mark}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Theme: {theme.says} — press for {theme.next}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-pressed={keysOpen}
                className={cn("size-8 p-0", keysOpen && "bg-at text-todo")}
                onClick={onKeys}
              >
                <Keyboard className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Every key this page answers to — ?</TooltipContent>
          </Tooltip>
          {/*
            Which build you are looking at.

            A session outlives a plugin update, so the server on the port is
            not necessarily the one just installed and a page can be last
            week's build with nothing on it saying so. That turned "did my
            change land, or am I looking at the old one?" into a question
            answered by chasing pids. Quiet, in the corner, and never wrong.
          */}
          {health.data?.version && (
            <span
              className="ml-auto pr-1 font-mono text-[10.5px] text-muted/70"
              title={`This page is served by the ${health.data.platform ?? "findings"} server from install ${health.data.version}`}
            >
              {health.data.version}
            </span>
          )}
        </div>
      </div>
    </nav>
  );
}
