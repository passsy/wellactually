/**
 * Everything this page can reach, as one list.
 *
 * The reason the rest of the redesign was worth doing: once every view has a
 * name — a review, a pile, a tag, a finding, a file, a document, a rule — one
 * box can reach all of them, and none of them has to be somewhere you already
 * know about.
 *
 * Pure, and separate from the dialog that draws it, the way `keep` is
 * separate from the queue. Matching and ranking are the part that can be
 * wrong in a way nobody notices, so they are the part with tests.
 *
 * Nothing here fetches. Everything it searches is already in the query cache
 * for its own reasons: the reviews because the rail lists them, the findings
 * because the queue is built from them, the documents because the panel under
 * the queue asked. The rules are the one catalogue fetched for this, once per
 * page, on the first open.
 */

import type { Finding, ReviewSummary } from "../shared/domain.ts";
import { countFor, FILTERS, type Tally } from "./filters.ts";

export type Kind =
  "finding" | "review" | "pile" | "tag" | "doc" | "file" | "rule";

/**
 * Ties break by kind, and the groups are drawn in this order.
 *
 * Findings first because a query is usually about one; rules last because
 * they are the only entries that are not about the review in front of you.
 */
export const KIND_ORDER: Kind[] = [
  "finding",
  "review",
  "pile",
  "tag",
  "doc",
  "file",
  "rule",
];

const KIND_SAYS: Record<Kind, string> = {
  finding: "Findings",
  review: "Reviews",
  pile: "Show",
  tag: "Tags",
  doc: "Documents",
  file: "Files",
  rule: "Rules",
};

export interface Hit {
  kind: Kind;
  /** Unique across a whole result set, and the row's id for the keyboard. */
  key: string;
  says: string;
  /** The quieter half of the row: where it is, or how many are in it. */
  sub?: string;
  count?: number;
  /** What choosing it hands back: a filter value, a tag, a path, an id. */
  value: string;
  review?: ReviewSummary;
  finding?: Finding;
}

export interface Group {
  kind: Kind;
  says: string;
  hits: Hit[];
  /** How many more of this kind matched than are shown. */
  more: number;
}

export interface Catalogue {
  reviews: ReviewSummary[];
  open: { repo: string; target: string } | null;
  /** Every finding of the open review, filtered or not. */
  findings: Finding[];
  counts: Tally;
  tags: string[];
  docs: string[];
  rules: { id: string; title?: string; doc: string }[];
}

/**
 * Without a cap one kind fills the list and the palette stops being a way to
 * reach the others — which is the only thing it is for.
 */
const CAP = 6;

function quoted(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The fingerprint a query is asking about, if it is asking about one.
 *
 * A finding posted to GitHub carries its fingerprint in a hidden
 * `<!-- pascal-review:<hash> -->` marker, and that hash is what somebody
 * copies back out of the comment source to find the finding again. Accept
 * the bare hex, the `pascal-review:` prefix, or the whole marker — pasting
 * more than the hash should not be a reason to find nothing. Eight hex
 * characters is the floor: below that, ordinary words ("decade", "cafe")
 * read as hex and every query would rank fingerprints it never meant.
 */
function fingerprintIn(q: string): string | null {
  const match =
    /^(?:<!--\s*)?(?:pascal-review:)?([0-9a-f]{8,64})(?:\s*-->)?$/.exec(q);
  return match?.[1] ?? null;
}

/**
 * How well one entry answers a query, highest first.
 *
 * A word boundary outranks a bare substring because "note" meaning the word
 * is a different match from "note" inside "NoteFooter", and the body is worth
 * least and only from three characters: at two, a body search matches most of
 * the review.
 */
function scoreOf(q: string, says: string, sub = "", body = ""): number {
  const text = says.toLowerCase();
  if (text === q) return 90;
  if (text.startsWith(q)) return 80;
  if (new RegExp(`\\b${quoted(q)}`).test(text)) return 60;
  if (text.includes(q)) return 40;
  if (sub.toLowerCase().includes(q)) return 35;
  if (q.length >= 3 && body.toLowerCase().includes(q)) return 20;
  return 0;
}

function pileHits(cat: Catalogue): Hit[] {
  return FILTERS.map((one) => ({
    kind: "pile" as const,
    key: `pile ${one.value}`,
    says: one.says,
    value: one.value,
    count: countFor(cat.counts, one.value),
  }));
}

function reviewHits(cat: Catalogue): Hit[] {
  return cat.reviews.map((review) => ({
    kind: "review" as const,
    key: `review ${review.repo} ${review.target}`,
    says: review.title ?? review.target,
    sub: `${review.target} · ${review.repo.split("/").pop() ?? review.repo}`,
    ...(review.counts.unread > 0 ? { count: review.counts.unread } : {}),
    value: review.target,
    review,
  }));
}

/**
 * What the palette shows before anything is typed.
 *
 * An empty query is not an empty palette: the piles of the open review, then
 * the other reviews with what is unread in each. That is what makes it useful
 * before you type, and it doubles as the discoverability of the piles — which
 * is the same job the rail does, said again where somebody is already
 * looking.
 */
function resting(cat: Catalogue): Group[] {
  const groups: Group[] = [
    { kind: "pile", says: KIND_SAYS.pile, hits: pileHits(cat), more: 0 },
  ];
  // Not the one already open: it is what the reader is looking at.
  const reviews = reviewHits(cat).filter((hit) => {
    const review = hit.review;
    if (!review || !cat.open) return true;
    return review.repo !== cat.open.repo || review.target !== cat.open.target;
  });
  if (reviews.length > 0) {
    groups.push({
      kind: "review",
      says: KIND_SAYS.review,
      hits: reviews.slice(0, CAP),
      more: Math.max(0, reviews.length - CAP),
    });
  }
  return groups;
}

/** Everything that matches, grouped by kind and capped within each group. */
export function search(query: string, cat: Catalogue): Group[] {
  const q = query.trim().toLowerCase();
  if (q === "") return resting(cat);

  const scored: { hit: Hit; score: number }[] = [];
  const add = (hit: Hit, score: number) => {
    if (score > 0) scored.push({ hit, score });
  };

  const hash = fingerprintIn(q);
  for (const finding of cat.findings) {
    const hit: Hit = {
      kind: "finding",
      key: `finding ${finding.id}`,
      says: finding.title,
      sub: `${finding.id} · ${finding.anchor.file}:${String(finding.anchor.line)}`,
      value: finding.id,
      finding,
    };
    // An id or a fingerprint is the one thing on this page that identifies
    // exactly one row, so typing one is never a search: it is a destination.
    // The fingerprint matches on its prefix the way a git hash does, because
    // nobody types 64 characters and a truncated paste still means that row.
    if (finding.id.toLowerCase() === q) add(hit, 100);
    else if (hash && finding.fingerprint.startsWith(hash)) add(hit, 100);
    else
      add(
        hit,
        scoreOf(q, finding.title, finding.anchor.file, finding.body) ||
          scoreOf(q, finding.id),
      );
  }
  for (const hit of reviewHits(cat)) add(hit, scoreOf(q, hit.says, hit.sub));
  for (const hit of pileHits(cat)) add(hit, scoreOf(q, hit.says));
  for (const tag of cat.tags) {
    add(
      {
        kind: "tag",
        key: `tag ${tag}`,
        says: tag,
        value: tag,
        count: cat.findings.filter((one) => (one.tags ?? []).includes(tag))
          .length,
      },
      scoreOf(q, tag),
    );
  }
  for (const path of cat.docs) {
    add(
      { kind: "doc", key: `doc ${path}`, says: path, value: path },
      scoreOf(q, path),
    );
  }
  for (const path of new Set(cat.findings.map((one) => one.anchor.file))) {
    add(
      { kind: "file", key: `file ${path}`, says: path, value: path },
      scoreOf(q, path),
    );
  }
  for (const rule of cat.rules) {
    // Named by its title and identified by its id: nobody remembers that
    // PW-D001 is the one about stack traces, and both are worth matching.
    add(
      {
        kind: "rule",
        key: `rule ${rule.id}`,
        says: rule.title ?? rule.id,
        sub: rule.id,
        value: rule.id,
      },
      scoreOf(q, rule.title ?? rule.id, `${rule.id} ${rule.doc}`),
    );
  }

  const groups: Group[] = [];
  for (const kind of KIND_ORDER) {
    // Stable, so two equal matches come back in the order the reader already
    // sees them in.
    const hits = scored
      .filter((one) => one.hit.kind === kind)
      .sort((a, b) => b.score - a.score)
      .map((one) => one.hit);
    if (hits.length === 0) continue;
    groups.push({
      kind,
      says: KIND_SAYS[kind],
      hits: hits.slice(0, CAP),
      more: Math.max(0, hits.length - CAP),
    });
  }
  return groups;
}

/** Every hit in a result set, in the order they are drawn. */
export function flatten(groups: Group[]): Hit[] {
  return groups.flatMap((group) => group.hits);
}

/**
 * What has to happen for a chosen finding to be reachable.
 *
 * The palette searches every finding of the review and the queue is showing
 * one pile of them, so it can offer rows the queue is not currently drawing.
 * Jumping to one of those has to clear the filter and then select it, rather
 * than silently doing nothing — which is what a jump into a hidden row looked
 * like: a palette that closed and left the reader exactly where they were.
 */
export function jumpTo(
  id: string,
  queue: Finding[],
): { at: number } | { clear: true } {
  const at = queue.findIndex((finding) => finding.id === id);
  return at >= 0 ? { at } : { clear: true };
}
