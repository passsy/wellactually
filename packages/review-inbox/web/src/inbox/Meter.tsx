/**
 * How far through a review anybody is, as one bar.
 *
 * Drawn twice at two sizes — across the header for the review being read, and
 * under every row of the rail — from one component and one set of numbers, so
 * the bar on a row and the bar above it cannot come to different answers
 * about the same review. That is not a hypothetical: "settled" is a judgement
 * (a finding the author has been told about has left your hands; one still
 * awaiting a verdict has not), and two places making it separately is two
 * places to change it in.
 */

import { GROUP_TITLES, type GroupKey } from "../shared/domain.ts";
import { cn } from "../shared/cn.ts";

export type Piles = Record<GroupKey, number>;

/**
 * The seven piles, laid out the way the track is.
 *
 * Left to right: invalid, tolerated, undecided, came back, accepted,
 * reported, fixed.
 * Accepted and reported were one blue, told apart by a wash of transparency
 * that read as a rendering artefact rather than as a boundary; they are two
 * hues now, and the four rungs of the climb run amber to green through them.
 * That is the board's own order — dismissed sits left of the start because it
 * is the way off the climb rather than the bottom of it, and the rest runs
 * right — so a glance at the bar and a glance at any row's mark agree about
 * which way progress goes. Came back is between undecided and accepted
 * because that is where a returned finding actually sits: back down the
 * climb, not up at the end of it.
 */
// The same rule the queue's discs follow: a slice that still asks for
// action is vivid, an ended one is washed toward the page. The bar then
// answers "how much of this still wants me" before anybody reads a number.
const BARS: { key: GroupKey; fill: string }[] = [
  { key: "invalid", fill: "color-mix(in srgb, var(--drop) 55%, transparent)" },
  {
    key: "tolerated",
    fill: "color-mix(in srgb, var(--tolerated) 55%, transparent)",
  },
  { key: "verdict", fill: "var(--open)" },
  { key: "back", fill: "var(--p1)" },
  { key: "fix", fill: "var(--todo)" },
  { key: "posted", fill: "var(--sent)" },
  { key: "resolved", fill: "color-mix(in srgb, var(--done) 55%, transparent)" },
];

/**
 * The piles that are somebody else's problem, or nobody's.
 *
 * Reported counts as settled because the author has been told: what is left
 * is waiting on them rather than on the person reading this. The two failed
 * verdicts count too — each is a decision, which is what the bar tracks —
 * and they keep their two colours in it, so a bar full of red misfires and a
 * bar full of slate carried findings say different things at a glance.
 */
const SETTLED: GroupKey[] = ["posted", "invalid", "tolerated", "resolved"];

function settledIn(piles: Piles): number {
  return SETTLED.reduce((sum, key) => sum + piles[key], 0);
}

function totalIn(piles: Piles): number {
  return BARS.reduce((sum, bar) => sum + piles[bar.key], 0);
}

/** What the bar says in words, for a tooltip or beside it. */
function progressSays(piles: Piles): string {
  const settled = settledIn(piles);
  return `${String(settled)} settled · ${String(totalIn(piles) - settled)} to go`;
}

export function Meter({
  piles,
  className,
  bare = false,
}: {
  piles: Piles;
  className?: string;
  /** Without the words, for a row that has no room for them. */
  bare?: boolean;
}) {
  const total = totalIn(piles);
  if (total === 0) return null;
  const says = progressSays(piles);
  const bar = (
    <span
      className={cn(
        "flex overflow-hidden rounded-full bg-[var(--cut)] shadow-[var(--sink)]",
        bare ? "h-[3px] w-full" : "h-1.5 w-52",
        className,
      )}
    >
      {BARS.map((one) => {
        const count = piles[one.key];
        if (count === 0) return null;
        return (
          <span
            key={one.key}
            className="h-full transition-[flex-grow] duration-300"
            style={{ flex: count, background: one.fill }}
            title={`${String(count)} ${GROUP_TITLES[one.key].toLowerCase()}`}
          />
        );
      })}
    </span>
  );
  if (bare) return <span title={says}>{bar}</span>;
  return (
    <div className="ml-auto flex flex-none items-center gap-2.5" title={says}>
      {bar}
      <span className="text-xs whitespace-nowrap text-muted">
        <b className="font-semibold text-fg">{settledIn(piles)}</b> settled ·{" "}
        <b className="font-semibold text-fg">{total - settledIn(piles)}</b> to
        go
      </span>
    </div>
  );
}
