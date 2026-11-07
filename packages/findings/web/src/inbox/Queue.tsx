/**
 * The queue.
 *
 * Two lines per row, because a row answers two questions and they are not the
 * same shape: what is this, and what sort of thing is it. The labels were
 * taking the end of every title to answer the second one.
 *
 * The mark and the id columns are given widths rather than sized to what is
 * in them. Every row is its own grid, so "G4" and "G12" started their titles
 * in different places and the column of titles developed a kink halfway down.
 */

import { useEffect, useRef } from "react";
import type { Finding, SeenMap } from "../shared/domain.ts";
import { isUnseen } from "../shared/domain.ts";
import { cn } from "../shared/cn.ts";
import {
  Evidence,
  Flagged,
  Noted,
  Priority,
  Stage,
  Tag,
} from "../shared/chips.tsx";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SORTS } from "./filters.ts";

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * What an invalid finding still owes: the issue against the rule.
 *
 * Only the debt is a badge. Marking a finding invalid is a claim the review
 * got it wrong, and the claim becomes calibration only once report_finding
 * files it — until then the row says so, and once the link exists the row
 * has nothing to nag about.
 */
function OwesIssue({ finding }: { finding: Finding }) {
  if (finding.verdict !== "invalid" || finding.links.ruleIssue) return null;
  return (
    <span
      className="inline-block shrink-0 rounded-[5px] bg-drop/17 px-[0.375rem] py-px text-[11px] font-semibold whitespace-nowrap text-drop [line-height:1.1rem]"
      title="Invalid, and the rule issue is not filed yet — report_finding pays that debt"
    >
      issue?
    </span>
  );
}

/**
 * What is shown, and what order it is in.
 *
 * An order nobody states gets read as no order at all — a queue sorted worst
 * first and a queue in the order the findings happened to be written look the
 * same until you already know. So it is said, and saying it is also the
 * control: the two orders anyone asks for are one press apart.
 */
function Line({
  says,
  count,
  sort,
  onSort,
}: {
  says: string;
  count: number;
  sort: string;
  onSort: (sort: string) => void;
}) {
  const now = SORTS.find((one) => one.value === sort) ?? SORTS[0];
  const next =
    SORTS[
      (SORTS.findIndex((one) => one.value === now?.value) + 1) % SORTS.length
    ];
  return (
    <div className="flex flex-none items-center gap-2 border-b border-line px-[0.8rem] py-1 text-[0.68rem] font-semibold tracking-[0.08em] text-muted uppercase">
      <span>
        {says} {count}
      </span>
      <button
        type="button"
        onClick={() => {
          if (next) onSort(next.value);
        }}
        title={`Ordered ${now?.says ?? ""} — press for ${next?.says ?? ""}`}
        className="ml-auto cursor-pointer tracking-[0.08em] transition-colors hover:text-hitline"
      >
        {now?.says} ⇅
      </button>
    </div>
  );
}

export function Queue({
  findings,
  at,
  seen,
  follow,
  onPick,
  onTag,
  tag,
  waiting,
  total,
  onShowAll,
  says,
  sort,
  onSort,
}: {
  findings: Finding[];
  at: number;
  seen: SeenMap;
  /** Which rows the reader has marked to come back to. */
  follow?: SeenMap;
  onPick: (index: number) => void;
  onTag: (tag: string) => void;
  /** The tag the queue is held to, so that chip can wear its on state. */
  tag: string | null;
  waiting: boolean;
  /** How many findings the review has before any filter is applied. */
  total: number;
  /** The way out of a filter that has hidden everything. */
  onShowAll: () => void;
  /** What the filter above this queue is called. */
  says: string;
  sort: string;
  onSort: (sort: string) => void;
}) {
  const list = useRef<HTMLUListElement>(null);

  // The selection moves with the keyboard as often as with the mouse, and a
  // row chosen off-screen is a row nobody can see they chose.
  useEffect(() => {
    list.current
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [at]);

  if (waiting) {
    return (
      <p className="animate-in fade-in p-4 text-sm text-muted duration-300">
        Waiting for this review to announce itself.
      </p>
    );
  }

  /*
   * An empty queue says why it is empty. A filter that hides every finding
   * left a blank column with no explanation and no way back, which reads as
   * lost data rather than as a filter doing its job.
   */
  if (findings.length === 0) {
    return (
      <section className="flex h-full min-h-0 flex-col">
        <Line says={says} count={0} sort={sort} onSort={onSort} />
        <div className="animate-in fade-in p-4 text-sm text-muted duration-300">
          {total > 0 ? (
            <>
              <p>Every finding is hidden by the current filter.</p>
              <button
                type="button"
                onClick={onShowAll}
                className="mt-2 cursor-pointer rounded border border-line px-2 py-0.5 text-xs transition-colors hover:border-hitline hover:text-hitline"
              >
                Show everything
              </button>
            </>
          ) : (
            <p>No findings yet.</p>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <Line says={says} count={findings.length} sort={sort} onSort={onSort} />
      <ScrollArea className="min-h-0 flex-1">
        <ul ref={list} tabIndex={0}>
          {findings.map((finding, index) => {
            const unread = isUnseen(finding, seen[finding.id]);
            return (
              <li key={finding.id}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-current={index === at}
                  onClick={() => {
                    onPick(index);
                  }}
                  className={cn(
                    // Two lines, full width each. The title shares its line
                    // only with the id — a fixed-width whisper, not a label —
                    // and the label line runs from the row's left edge, so the
                    // track starts a column of its own down the queue.
                    "flex w-full cursor-pointer flex-col gap-y-[0.1rem] border-b border-line px-[0.8rem] py-[0.45rem] text-left transition-[background-color,box-shadow] duration-150",
                    // The focus ring is drawn inward: an outline outside the
                    // row is clipped by the scroller on the first and last row,
                    // which are exactly the rows keyboard focus starts on.
                    "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-todo",
                    index === at ? "bg-at" : "hover:bg-at/40",
                  )}
                  // Hard against the edge of the row rather than against the first
                  // thing in it. A margin down one side of a list is read as an
                  // edge, and an edge that starts a padding-width in is read as a
                  // stripe on the row instead — which is a different mark saying a
                  // different thing.
                  style={
                    unread
                      ? { boxShadow: "inset 2px 0 0 0 var(--todo)" }
                      : undefined
                  }
                >
                  {/*
                Unread, the way every inbox has said it for thirty years. The
                bar on the edge does the work at a glance down the column; the
                weight does it while reading one row. Neither is a control:
                the only way to clear it is to read the finding, which is the
                point.
              */}
                  <span className="flex min-w-0 items-baseline gap-[0.3rem]">
                    {/*
                    The same width as the stage disc's slot below, and centred
                    in it the way the disc is, so the two lines open with one
                    aligned column: id over mark, title over chips. A floor
                    rather than a hard width, because ids in one run are the
                    same width anyway and a four-character one may stretch.
                  */}
                    <span
                      className={cn(
                        "min-w-[1.4rem] flex-none text-center font-mono text-xs transition-colors",
                        unread ? "text-fg" : "text-muted",
                      )}
                    >
                      {finding.id}
                    </span>
                    <span
                      className={cn(
                        "truncate text-[0.94rem]",
                        unread && "font-semibold",
                      )}
                    >
                      {finding.title}
                    </span>
                  </span>
                  {/*
                What sort of finding it is, and where. The file is pushed to
                the far end rather than following the tags, so it makes a
                column of its own down the queue instead of starting wherever
                the last tag happened to finish.
              */}
                  {/*
                    Clipped at the row's edge. Every mark on this line refuses
                    to shrink — a half-word tag is not a tag — so a finding
                    with enough of them is wider than the column whatever the
                    column's width. Left to hang out it made the whole queue
                    scroll sideways by however much the busiest row overran,
                    which is a scrollbar the queue does not otherwise need and
                    a row of titles moving under the cursor to reach a tag the
                    finding beside it already lists.
                  */}
                  <span className="flex min-w-0 items-center gap-[0.3rem] overflow-hidden">
                    {/*
                  Where this finding stands, as one coloured mark. What was
                  here was the detail pane's whole control shrunk to a row's
                  height — five holes, a slit and the head — and at that size
                  only the head was ever read: the other five glyphs were a
                  column of ink and a set of targets nobody could hit. This is
                  the head, on its own.
                */}
                    <Stage finding={finding} />
                    <OwesIssue finding={finding} />
                    <Priority of={finding.priority} />
                    {finding.evidence !== "Reasoned" && (
                      <Evidence of={finding.evidence} small />
                    )}
                    {(finding.tags ?? []).map((one) => (
                      <Tag
                        key={one}
                        on={one === tag}
                        onPick={() => {
                          onTag(one);
                        }}
                      >
                        {one}
                      </Tag>
                    ))}
                    {/*
                    The one mark on a row that nothing generated: somebody
                    read this and left something behind, and until now the
                    only way to find out was to open it.
                  */}
                    {/*
                    Before the note, because a flag is why the row is being
                    looked at again and the note is what was found when it
                    was looked at the first time.
                  */}
                    {follow?.[finding.id] && <Flagged />}
                    {finding.note && <Noted note={finding.note} />}
                    {/*
                    After the tags rather than flushed right: everything on
                    this line reads left to right in one run, and a value
                    pushed to the far edge reads as a different column.
                  */}
                    <span
                      className="truncate font-mono text-[0.72rem] text-muted"
                      title={finding.anchor.file}
                    >
                      {basename(finding.anchor.file)}:{finding.anchor.line}
                    </span>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </section>
  );
}
