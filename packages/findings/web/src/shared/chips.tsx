/**
 * The small labels a finding wears.
 *
 * A translucent fill of the text colour, and nothing else. What this replaced
 * was five outlined pills of micro-caps in a row, and at a glance they were
 * five identical rings: the ring was the loudest thing on each chip, every
 * chip had the same one, so nothing in the row ranked against anything else.
 * The caps and the tracking cost legibility at 11px to buy the look of a
 * label.
 *
 * The fill survives the page, a card and the blue of a selected row for
 * exactly the reason the outline did — it is a proportion of a colour rather
 * than a fixed hairline — and it is quieter, because there is no edge to read.
 * Filled and unbordered, nothing here reads as a button either, which was the
 * original argument for the pill.
 *
 * One cva table carries every way a chip can vary — what face it is set in,
 * how large, and what tone it wears — so a new kind of chip is a row in the
 * table rather than another string of utilities to keep in step with five
 * existing ones. Every tone states its own fill and its own ink: two `bg-*`
 * utilities on one element are resolved by the order the stylesheet happens
 * to be in, which is not an order this file controls.
 */

import type { MouseEvent, ReactNode } from "react";
import { Flag, MessageSquare } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn.ts";
import { groupOf, type Finding, type Priority as Level } from "./domain.ts";
import { STAGE_FILL, STAGE_MARK, STAGE_SAYS } from "./stage.tsx";

/**
 * The line box is given a height outright, so a row of chips is a row of one
 * height whatever type is set in it: the rule id and the small evidence chip
 * are not 11.5px, and without it they sat half a pixel proud of the rest.
 */
const chip = cva(
  "inline-block shrink-0 rounded-[5px] px-[0.375rem] py-px font-medium whitespace-nowrap transition-colors [line-height:1.1rem]",
  {
    variants: {
      /**
       * One face for everything a person wrote or a review chose, and the
       * mono one for the rule id — which is a symbol rather than a word, and
       * is the one chip that has to survive being read character by character.
       */
      face: { plain: "", mono: "font-mono" },
      size: {
        chip: "text-[11.5px]",
        small: "text-[11px]",
        rule: "text-[11px]",
      },
      tone: {
        quiet: "bg-fg/8 text-muted",
        p0: "bg-p0/17 text-p0",
        p1: "bg-p1/17 text-p1",
        accent: "bg-hitline/17 text-hitline",
        proven: "bg-done/16 text-done",
        /**
         * A tag the queue is currently held to. Blue is this page's colour
         * for "you did this" everywhere else, and holding the queue to a tag
         * is the reader's own doing; gold already means priority and
         * reference, so a held tag in gold read as a p2.
         */
        held: "bg-todo/20 text-todo",
      },
    },
    defaultVariants: { face: "plain", size: "chip", tone: "quiet" },
  },
);

type ChipStyle = VariantProps<typeof chip>;

/** Only the three rungs read at a glance down a column carry a colour. */
const TONE: Partial<Record<Level, ChipStyle["tone"]>> = {
  p0: "p0",
  p1: "p1",
  p2: "accent",
};

export function Priority({ of }: { of: Level }) {
  return (
    <span
      // Sized for the two characters it has, not the three it was given: "p1"
      // is a hair narrower than "p0" in a proportional font, and without a
      // width the pill changes shape from row to row.
      className={cn(
        chip({ tone: TONE[of] ?? "quiet" }),
        "min-w-[22px] text-center font-semibold",
      )}
      title={`Priority ${of}`}
    >
      {of}
    </span>
  );
}

/** A word the review chose for what kind of problem this is. */
export function Tag({
  children,
  title,
  onPick,
  on,
}: {
  children: ReactNode;
  title?: string | undefined;
  /** Given a way to cluster by this tag, the chip becomes the way. */
  onPick?: (() => void) | undefined;
  /** Whether the queue is currently held to this tag. */
  on?: boolean;
}) {
  const look = chip({ tone: on ? "held" : "quiet" });
  if (!onPick) {
    return (
      <span className={look} title={title}>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      // Hovering wears what pressing would do, at half strength: the tone a
      // held tag has, before it is held.
      className={cn(look, "cursor-pointer hover:bg-todo/12 hover:text-todo")}
      title={
        title ??
        (on
          ? "Show every finding again"
          : typeof children === "string"
            ? `Hold the queue to everything tagged "${children}"`
            : "Hold the queue to everything with this tag")
      }
      onClick={(event) => {
        // The row underneath is a control too, and pressing a tag is not
        // choosing the finding it happens to sit on.
        event.stopPropagation();
        onPick();
      }}
    >
      {children}
    </button>
  );
}

/** A label from a fixed set: a verdict, a resolution, a state. */
export function State({
  children,
  title,
}: {
  children: ReactNode;
  title?: string | undefined;
}) {
  return (
    <span className={chip()} title={title}>
      {children}
    </span>
  );
}

/**
 * Where a finding stands, as one mark.
 *
 * Read off `groupOf`, which is what the filter, the rail's counts and the
 * report's headings are built from, so the mark on a row cannot come to a
 * different answer about a finding than the pile it is filed under. It is the
 * same glyph the track's head carries, with one addition the track cannot
 * make: a finding that was fixed and came back wears its own mark here rather
 * than sitting silently back down the board.
 *
 * Not a control. The track in the detail pane is the control, and so are the
 * keys; a 15px disc is a target nobody hits on purpose.
 */
export function Stage({ finding }: { finding: Finding }) {
  const group = groupOf(finding);
  return (
    /*
      A fixed slot around the disc, sized to the halo's outer edge. The halo
      is an outline and outlines take no layout space, so without the slot a
      haloed disc and a hollow one claimed different visual widths from the
      same box — the column of marks wobbled, and the halo crowded whatever
      sat beside it. Every disc now centres in the same 1.4rem, so the
      column is straight whichever mix of states it holds.
    */
    <span
      className="inline-grid size-[1.4rem] flex-none place-items-center"
      title={STAGE_SAYS[group]}
      aria-label={STAGE_SAYS[group]}
    >
      <span
        className={cn(
          "inline-grid size-[0.95rem] place-items-center rounded-full text-[0.55rem] leading-none",
          STAGE_FILL[group],
        )}
      >
        {STAGE_MARK[group]}
      </span>
    </span>
  );
}

/**
 * That somebody wrote something on this finding.
 *
 * A note is the one thing on a finding that no review run put there, and
 * until it is opened there was nothing on the row saying it existed — so the
 * queue looked identical whether or not the last person through it had left
 * anything behind. One mark, and the note itself on the tooltip, because what
 * a reader wants first is whether to bother opening it.
 *
 * A mark rather than a word: it sits in a row of chips that are all words,
 * which is what makes it findable down a column without being loud.
 *
 * Drawn rather than typed. The pencil this started as is one of the
 * characters the platform hands back as a colour emoji, so a mark meant to be
 * the quietest thing on the row arrived as the only yellow object on the
 * page — and no font stack fixes that reliably. A stroked bubble is the same
 * size, takes the row's own colour, and is the mark every tool that has ever
 * held somebody's remark about something uses.
 */
/**
 * That the reader means to come back to this one.
 *
 * Amber, and the only mark on a row that says something about the reader
 * rather than about the finding — which is why it is a flag and not a rung of
 * the track. A finding can be flagged at any stop, and taking the flag off
 * decides nothing.
 */
export function Flagged() {
  return (
    <span
      className={cn(chip(), "inline-flex items-center text-p1")}
      title="Flagged to come back to"
      aria-label="Flagged to come back to"
    >
      <Flag className="size-3" aria-hidden="true" />
    </span>
  );
}

export function Noted({ note }: { note: string }) {
  const first = note.trim().split("\n")[0] ?? "";
  return (
    <span
      className={cn(chip(), "inline-flex items-center")}
      title={`Note: ${first.length > 120 ? `${first.slice(0, 120)}…` : first}`}
      aria-label="This finding has a note"
    >
      <MessageSquare className="size-3" aria-hidden="true" />
    </span>
  );
}

/**
 * How the review knows, when it is not the usual "Reasoned".
 *
 * Proven is the one worth a colour: it means a test was run and failed, which
 * is a different kind of claim from the rest and the only one a reader can
 * check without reading the argument.
 *
 * Smaller in the queue than in the detail pane, because down there it is
 * competing with the priority for the same glance and it is the less
 * important of the two.
 */
export function Evidence({ of, small }: { of: string; small?: boolean }) {
  return (
    <span
      className={chip({
        size: small ? "small" : "chip",
        tone: of === "Proven" ? "proven" : "quiet",
      })}
      title={`Evidence: ${of}`}
    >
      {of}
    </span>
  );
}

/** The handbook rule a finding cites, and the way to read it. */
export function Rule({
  id,
  report,
  onPick,
  href,
}: {
  id: string;
  report?: boolean;
  onPick?: () => void;
  /**
   * Where the rule lives, for a page that is not served beside it. The card
   * is drawn by a host on its own origin, so the relative address below
   * points at that host rather than at the findings server.
   */
  href?: string;
}) {
  const look = chip({ face: "mono", size: "rule", tone: "accent" });
  // In a report the id is written as a reference with no destination: the
  // file is opened from a downloads folder as often as from the server, and a
  // link to a host that is not running is worse than plain text. The
  // enhancement gives it an href once it has found a server.
  if (report) {
    return (
      <a className={look} data-rule={id}>
        {id}
      </a>
    );
  }
  return (
    <a
      href={href ?? `/rule/${id}`}
      {...(onPick
        ? {
            onClick: (event: MouseEvent<HTMLAnchorElement>) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              onPick();
            },
          }
        : { target: "_blank", rel: "noopener" })}
      className={look}
      title={`Read ${id}`}
    >
      {id}
    </a>
  );
}
