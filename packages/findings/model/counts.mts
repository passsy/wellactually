/**
 * How much of a review is in each pile, counted from the findings themselves.
 *
 * Pure, and its own module, because two sides count the same review and they
 * must not be able to disagree. The server counts every review on the machine
 * so a list of them can say how far each has got; the page counts the one
 * review it is holding, because it already has every finding and every read
 * receipt in memory and asking the server what it just did itself is a
 * question with a network in the middle of it.
 *
 * That is the whole point of the split. A count the page can work out is a
 * count the page should work out: `unread` moves the instant a row is marked,
 * not one round trip and one file-watcher event later, and the rail's row and
 * the header's bar cannot show two different numbers for the same review
 * because they are reading one.
 *
 * Nothing here reads a file, so the browser can have it as it is.
 */

import { groupOf, type GroupKey } from "./groups.mts";
import { isUnseen } from "./unread.mts";
import type { Finding, ReviewCounts, SeenMap } from "./types.mts";

/**
 * Whether somebody has written anything on this finding.
 *
 * A blank note and no note are the same thing: clearing the box is how a note
 * is taken back, and a row that still says it carries one is a row that lies.
 */
export function hasNote(finding: { note?: string }): boolean {
  return (finding.note ?? "").trim() !== "";
}

/** No findings, which is not the same shape as no counts. */
function empty(): Record<GroupKey, number> {
  return {
    back: 0,
    verdict: 0,
    fix: 0,
    posted: 0,
    invalid: 0,
    tolerated: 0,
    resolved: 0,
  };
}

/**
 * Every count a review is worth, from one pass over its findings.
 *
 * `open` and `back` are read back out of the piles rather than counted
 * separately: they are the same fact stated two ways, and stating it twice is
 * how a total ends up disagreeing with the bar drawn underneath it.
 */
export function countsOf(
  findings: readonly Finding[],
  seen: SeenMap,
  follow: SeenMap = {},
): ReviewCounts {
  const piles = empty();
  let unread = 0;
  let noted = 0;
  let marked = 0;
  for (const finding of findings) {
    piles[groupOf(finding)] += 1;
    if (isUnseen(finding, seen[finding.id])) unread += 1;
    if (hasNote(finding)) noted += 1;
    if (follow[finding.id]) marked += 1;
  }
  return {
    total: findings.length,
    unread,
    noted,
    marked,
    open: findings.length - piles.resolved - piles.invalid - piles.tolerated,
    back: piles.back,
    piles,
  };
}
