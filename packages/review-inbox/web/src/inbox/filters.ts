/**
 * Which findings the queue is showing, and how many are in each answer.
 *
 * The names are the piles a finding falls into, plus the questions that are
 * not piles: what is new, and what somebody has written on. A reader works
 * the queue by one of these at a time, so the filter is a list of answers
 * rather than a set of checkboxes: two of them at once is a question nobody
 * asks.
 *
 * The piles are built from the server's own list rather than restated here,
 * so a pile added over there appears in the rail without being told about.
 */

import {
  GROUP_ORDER,
  GROUP_TITLES,
  groupOf,
  hasNote,
  isUnseen,
  PRIORITY,
  type Finding,
  type GroupKey,
  type ReviewCounts,
  type SeenMap,
} from "../shared/domain.ts";
import type { ReactNode } from "react";
import { STAGE_MARK, STAGE_TONE } from "../shared/stage.tsx";

export interface Filter {
  value: string;
  says: string;
  /** One mark, for the rail's row. Typed where a character will do, drawn
   * where none of them will. */
  mark: ReactNode;
  /** What that glyph is worth at a glance, as a utility class. */
  tone: string;
}

export const FILTERS: Filter[] = [
  { value: "", says: "All", mark: "≡", tone: "opacity-45" },
  // Blue, because unread is blue everywhere else on this page: the bar on a
  // row, the count on a review.
  { value: "new", says: "New", mark: "●", tone: "text-todo" },
  // Drawn rather than typed: every character that means "a written note" is
  // one the platform hands back as a colour emoji. The rail supplies it.
  { value: "noted", says: "Noted", mark: "", tone: "opacity-60" },
  // The reader's own marker, and the reason the track gave up its flag.
  { value: "flagged", says: "Flagged", mark: "", tone: "text-p1" },
  ...GROUP_ORDER.map((key) => ({
    value: key,
    says: GROUP_TITLES[key],
    mark: STAGE_MARK[key],
    tone: STAGE_TONE[key],
  })),
];

export { hasNote };

/**
 * The two that are not piles.
 *
 * A finding is new, or noted, because of what the reader has done rather than
 * what the finding is, so both cut across every other answer here: something
 * accepted and rewritten since is both "to fix" and unread.
 */
export function keep(
  findings: Finding[],
  filter: string,
  seen: SeenMap,
  tag?: string | null,
  held?: ReadonlySet<string>,
  follow?: SeenMap,
): Finding[] {
  // A tag cuts across the piles rather than being one, so it is applied on
  // top of whatever answer is showing: a reader clustering by "race" still
  // wants the filter they had set.
  if (tag) {
    findings = findings.filter((finding) => (finding.tags ?? []).includes(tag));
  }
  if (filter === "") return findings;
  if (filter === "noted") return findings.filter(hasNote);
  // Not a pile either: a finding is flagged because of what the reader means
  // to do about it, so it crosses every verdict there is.
  if (filter === "flagged")
    return findings.filter((finding) => Boolean(follow?.[finding.id]));
  if (filter === "new") {
    // Held rows are the ones read while this filter was showing. Dropping a
    // row the moment it is read would pull the queue out from under the
    // cursor, so each stays until the filter is asked again.
    return findings.filter(
      (finding) => isUnseen(finding, seen[finding.id]) || held?.has(finding.id),
    );
  }
  return findings.filter((finding) => groupOf(finding) === filter);
}

export interface Sort {
  value: string;
  says: string;
}

/**
 * The two orders anyone asks for.
 *
 * State is not one of them: which pile a finding is in is how the queue is
 * narrowed — that is the rail's job — and ordering by it as well would sort
 * the list by the thing the reader has already chosen.
 */
export const SORTS: Sort[] = [
  { value: "worst", says: "worst first" },
  { value: "newest", says: "newest first" },
];

/** The number in an id, so G9 comes before G12 rather than after it. */
function idNumber(id: string): number {
  const digits = /(\d+)/.exec(id);
  return digits?.[1] === undefined ? 0 : Number(digits[1]);
}

/**
 * What order the queue is in, applied after `keep` rather than inside it.
 *
 * Both keys are stable, so giving a verdict does not reshuffle the list under
 * the cursor: the row stays where it is and only its own track moves.
 */
export function order(findings: Finding[], sort: string): Finding[] {
  const sorted = [...findings];
  if (sort === "newest") {
    sorted.sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) ||
        idNumber(b.id) - idNumber(a.id),
    );
    return sorted;
  }
  sorted.sort(
    (a, b) =>
      PRIORITY.indexOf(a.priority) - PRIORITY.indexOf(b.priority) ||
      idNumber(a.id) - idNumber(b.id),
  );
  return sorted;
}

/**
 * How much of a review is in each answer.
 *
 * The same shape the server sends for every other review, because it is the
 * same question — and because the row for the open review in the rail is
 * drawn from this rather than from what the server last said about it.
 */
export type Tally = ReviewCounts;

/** What one entry of the filter list is worth, against a tally. */
export function countFor(counts: Tally, filter: string): number {
  if (filter === "") return counts.total;
  if (filter === "new") return counts.unread;
  if (filter === "noted") return counts.noted;
  if (filter === "flagged") return counts.marked;
  return counts.piles[filter as GroupKey] ?? 0;
}
