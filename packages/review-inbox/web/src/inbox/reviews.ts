/**
 * What every surface wants to know about a review, and what the page knows
 * about the one it is holding that the server has not been told yet.
 *
 * Its own module because several components ask — the rail's rows, the
 * header's title, the header's pull request link — and a function exported
 * from a file that also exports components is a file that cannot be hot
 * reloaded. The two below are here for a second reason: they are the whole of
 * "the open review is counted on this side", and a rule that lives in a
 * function can be tested, where the same rule spelled out inside a component
 * can only be looked at.
 */

import type {
  FindingList,
  ReviewCounts,
  ReviewSummary,
} from "../shared/domain.ts";
import type { Where } from "./api.ts";

/**
 * The checkout, without the part of its name that is a hash.
 *
 * A review worktree is named "<repo>-pr356-3d10d616", and the eight hex
 * characters on the end are there so two reviews of the same pull request can
 * coexist on disk. They identify nothing a reader is looking for.
 */
export function checkoutName(path: string): string {
  return (path.split("/").pop() ?? "").replace(/-[0-9a-f]{8}$/, "");
}

/**
 * What a review is, in the fewest words that still identify it.
 *
 * A review worktree is named after the repository *and* the target — the two
 * things this line says — so writing both out spelled the target twice:
 * "pr-679 · vf-noa-scan-pr679". The number is the identifying half and it was
 * the half buried in the middle of a path fragment.
 *
 * So the checkout name gives up the part of itself that is the target, and
 * what is left is the repository. A pull request is then its number and where
 * it is, "#679 vf-noa-scan", with the hash carrying what kind of thing the
 * number is. A review of something that is not a pull request has no number
 * to lead with, so it keeps its own name and the separator that holds the two
 * apart — "upload-and-download-flow · NOA-File-Service".
 */
export interface ReviewName {
  /** The pull request, as "#679", or the target's own name. */
  says: string;
  /** The repository the review ran in. */
  where: string;
  /** Whether the two need something between them to read as two things. */
  apart: boolean;
}

export function nameOf(review: ReviewSummary): ReviewName {
  const checkout = checkoutName(review.repo);
  // Both spellings the worktree uses: "…-pr679" for a target of "pr-679", and
  // the target verbatim for one that is already a branch name. Only this
  // review's own target is taken off, so a repository that happens to end in
  // something similar keeps its name.
  const where =
    [review.target, review.target.replace(/-/g, "")]
      .map((tail) => `-${tail}`)
      .filter(
        (tail) => checkout.endsWith(tail) && checkout.length > tail.length,
      )
      .map((tail) => checkout.slice(0, -tail.length))[0] ?? checkout;
  const number = review.pr?.number ?? numberIn(review.target);
  return number === null
    ? { says: review.target, where, apart: true }
    : { says: `#${String(number)}`, where, apart: false };
}

/**
 * The pull request a target names, for the reviews that have no recorded one.
 *
 * Plenty of reviews predate anything writing the number down, and their
 * target is where it has always been readable.
 */
function numberIn(target: string): number | null {
  const found = /^pr-(\d+)$/.exec(target);
  return found?.[1] === undefined ? null : Number(found[1]);
}

/** Whether the pull request under a review has already landed. */
export function isMerged(review: ReviewSummary | null | undefined): boolean {
  return review?.pr?.state === "merged";
}

/**
 * What kind of thing a review is of, and where that thing has got to.
 *
 * The rail used to mark only the pull requests that had landed, which left
 * every other row saying nothing — and "nothing" covered a pull request still
 * open, one closed unmerged, one nobody has managed to ask about, and a plain
 * branch with no pull request at all. Those are four different reasons to
 * open a review or leave it, drawn identically.
 */
export type Standing =
  "merged" | "closed" | "open" | "asking" | "landed" | "branch" | "unknown";

export function standingOf(review: ReviewSummary): Standing {
  const state = review.pr?.state;
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
  if (state === "open") return "open";
  // A number and no state is a pull request nobody has got an answer about
  // yet — no gh on this machine, a private repository, or simply not asked.
  // Saying "open" there would be inventing the answer.
  if (review.pr?.number) return "asking";
  if (review.branch) return review.branch.landed ? "landed" : "branch";
  return "unknown";
}

/**
 * The list of reviews, with the open one counted here rather than there.
 *
 * The server's list is a snapshot of what was on disk when it was asked. For
 * every review but one that is the best answer available. For the one being
 * read it is the worst: the page holds all of that review's findings and all
 * of its read receipts, so it already knows the answer to a question it was
 * sending over a network — and the reply took a round trip, a file written, a
 * watcher firing and a second round trip to come back. Marking a row unread
 * moved the queue immediately and the rail three hops later, which is what a
 * count with two owners looks like from the outside.
 *
 * So the row of the open review is drawn from the page's own count. Nothing
 * here is optimistic: it is not a guess at what the server will say, it is
 * the same function over the same findings, and the refetch that eventually
 * arrives agrees with what is already on the screen.
 */
export function counted(
  reviews: ReviewSummary[],
  where: Where | null,
  counts: ReviewCounts | null,
): ReviewSummary[] {
  if (!where || !counts) return reviews;
  return reviews.map((review) =>
    review.repo === where.repo && review.target === where.target
      ? { ...review, counts }
      : review,
  );
}

/**
 * The same findings, with the reader's flag put on one or taken off.
 *
 * The same shape as a read receipt, and for the same reason: absent is the
 * whole of what "not flagged" means, so taking the flag off is a delete
 * rather than a value.
 */
export function flagged(
  list: FindingList,
  id: string,
  on: boolean,
  at: string,
): FindingList {
  const follow = { ...list.follow };
  if (on) follow[id] = at;
  else delete follow[id];
  return { ...list, follow };
}

/**
 * The same findings, with one of them read or put back.
 *
 * Written into the page's own copy the moment the key is pressed, because the
 * page is where reading happens: the server is being told, not asked. Taking
 * the mark off is a delete rather than a timestamp, which is what the store
 * on the other end does — an unread finding is exactly one that is absent
 * from the map, however it got that way.
 */
export function marked(
  list: FindingList,
  id: string,
  read: boolean,
  at: string,
): FindingList {
  const seen = { ...list.seen };
  if (read) seen[id] = at;
  else delete seen[id];
  return { ...list, seen };
}
