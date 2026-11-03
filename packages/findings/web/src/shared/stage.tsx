/**
 * The six stops of a finding, as a track.
 *
 * One control instead of three buttons. The three were three verbs that had
 * to be read before any of them could be pressed, and they said nothing about
 * the order they came in; a track says "you are here, and there is where you
 * would go" with its shape.
 *
 * The two failed verdicts sit left of the start and the rest runs right, so
 * the shape says that failing a finding is not the bottom of the climb — and
 * the two ways to fail are not the same way: invalid means the review got it
 * wrong and owes the rule an issue, tolerated means the finding stands and
 * is carried on purpose.
 */

import {
  ArrowUpRight,
  Check,
  Circle,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import type { Finding, GroupKey } from "./domain.ts";
import type { TrackFlag, TrackStop } from "./track/Track.tsx";

/**
 * Every mark is drawn, none is typed.
 *
 * They started as font glyphs, and a font seats each glyph on its own
 * metrics: ✕ carries its weight high, ~ rides the text baseline, and which
 * height either arrives at depends on whatever face the machine falls back
 * to. Centring the box centred the glyph's padding, not its ink, so no one
 * correction held across the set. An SVG's ink is its box — one centring
 * rule seats all of them, in a 2rem track hole and on a 15px disc alike.
 *
 * Sized in `em` because the marks are drawn at four sizes: engraved in a
 * hole, carried by the head, listed in the rail's filters, and lettered
 * into a disc on a queue row. A hair over 1, because a lucide icon fills
 * its box with nothing around it.
 *
 * The wrench, because the pile is called "To fix" everywhere else in here
 * and that is what accepting a finding means. The tilde is the one mark
 * lucide does not have — approximately fine — so it is drawn here in
 * lucide's own grammar: 24-box, stroke 2, round caps.
 */
const MARK = "size-[1.02em] flex-none";
const FIX = <Wrench className={MARK} aria-hidden="true" />;
const INVALID = <X className={MARK} aria-hidden="true" />;
const OPEN = <Circle className={MARK} aria-hidden="true" />;
const REPORTED = <ArrowUpRight className={MARK} aria-hidden="true" />;
const FIXED = <Check className={MARK} aria-hidden="true" />;
const BACK = <TriangleAlert className={MARK} aria-hidden="true" />;
const TOLERATED = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    className={MARK}
    aria-hidden="true"
  >
    <path d="M4 12c2.7-3.8 5.3-3.8 8 0s5.3 3.8 8 0" />
  </svg>
);

export const STOPS: TrackStop[] = [
  {
    to: "invalid",
    mark: INVALID,
    says: "Invalid — the review got this wrong",
    tone: "var(--drop)",
  },
  {
    to: "tolerated",
    mark: TOLERATED,
    says: "Tolerated — it stands, carried on purpose",
    tone: "var(--tolerated)",
  },
  {
    to: "open",
    mark: OPEN,
    says: "Open — nothing decided yet",
    tone: "var(--open)",
  },
  {
    to: "accepted",
    mark: FIX,
    says: "Accepted — a real problem, still to fix",
    tone: "var(--todo)",
  },
  {
    to: "reported",
    mark: REPORTED,
    says: "Reported — the author has been told",
    tone: "var(--sent)",
  },
  {
    to: "fixed",
    mark: FIXED,
    says: "Fixed — the code no longer has it",
    tone: "var(--done)",
  },
];

/**
 * Two breaks, and each is a boundary the marks alone do not show.
 *
 * The failed verdicts are not the bottom of the climb, they are the way off
 * it — and they sit together, because both mean "nobody is climbing with
 * this". Undecided is where a finding sits before anyone has ruled on it,
 * which is a different thing again from the three rungs of getting a real
 * problem dealt with.
 */
export const BLANK_AFTER = [1, 2];

/**
 * Which stop a finding is at.
 *
 * Read off the fields rather than from groupOf, because a finding that came
 * back is not at a stop of its own: it is back down the track, and where it
 * climbed to is what the flag says.
 */
export function stopOf(finding: Finding): number {
  if (finding.verdict === "invalid") return 0;
  if (finding.verdict === "tolerated") return 1;
  if (finding.resolution === "resolved") return 5;
  if (finding.reportedAt) return 4;
  if (finding.verdict === "accepted") return 3;
  return 2;
}

/** The stops, with what this particular finding can add to them. */
export function stopsFor(finding: Finding): TrackStop[] {
  if (!finding.reportedAt) return STOPS;
  const when = finding.reportedAt.slice(0, 10);
  return STOPS.map((stop) =>
    stop.to === "reported" ? { ...stop, says: `${stop.says} · ${when}` } : stop,
  );
}

/**
 * A finding that was resolved and came back is not at a stop of its own, so
 * the hole it climbed to is the only thing left that can say it was there.
 */
export function flagFor(finding: Finding): TrackFlag | undefined {
  if (finding.resolution !== "regressed") return undefined;
  return {
    index: 5,
    mark: BACK,
    says: "Came back — a review run found it again",
  };
}

/**
 * Which rung a finding is on, as one glyph.
 *
 * Taken from groupOf, which is what the filter and the report's headings are
 * built from, so the mark on a row cannot come to a different answer about a
 * finding than the pile it is filed under.
 *
 * A glyph per rung rather than one shape filling up. The filling circles were
 * a nice progression on paper and unreadable at the size a row draws them:
 * half full and three-quarters full are the same mark to a glance down a
 * column. Each of these says its own rung instead, and the two states off the
 * climb say so in their own glyph rather than in a shade.
 */
export const STAGE_MARK: Record<GroupKey, ReactNode> = {
  verdict: OPEN,
  fix: FIX,
  posted: REPORTED,
  invalid: INVALID,
  tolerated: TOLERATED,
  resolved: FIXED,
  back: BACK,
};

/**
 * What each rung is worth at a glance down a column.
 *
 * One rule ranks them: a rung that still asks for action is vivid, a rung
 * where the work has ended is washed. Needs-a-verdict, to-fix, reported and
 * came-back are the queue's to-do list — ink, blue, teal, amber at full
 * strength. Fixed, invalid and tolerated keep their hues so the glance still
 * says which ending it was, at reduced strength so an ending never competes
 * with work.
 *
 * Undecided used to be dimmed on the argument that the default state of most
 * of the queue should not shout. But the queue is a to-do list, and the rows
 * still waiting on a decision are exactly the ones that should.
 *
 * "back" takes the p1 token rather than the hex the old sheet used, so it
 * lightens in the dark theme instead of staying a dark orange on a dark row.
 */
export const STAGE_TONE: Record<GroupKey, string> = {
  verdict: "text-open",
  fix: "text-todo",
  posted: "text-sent",
  invalid: "text-drop opacity-60",
  tolerated: "text-tolerated opacity-70",
  resolved: "text-done opacity-60",
  back: "text-p1",
};

/**
 * The same rungs as a filled disc, for a queue row.
 *
 * What this replaced was the whole board at chip height: five holes, a slit
 * and the head, drawn once per row. At that size only one of those was ever
 * read — the head — and the other five glyphs were a control nobody could hit
 * and a lot of ink down the column. So the head is what is left: a disc in
 * the rung's colour with its mark lettered in the page's own background, the
 * one colour guaranteed to read on any of these fills in either theme.
 *
 * The same rule as the tones, drawn as solid against hollow: a state that
 * still asks for action is a solid vivid disc wearing a halo in its own
 * hue, an ended one is an outline with nothing in it — done work literally
 * looks emptied out, and no wash can take an ending further back than
 * hollowness does while still naming its colour.
 *
 * Undecided sits between those two classes and its disc says so: hollow like
 * an ending, because nothing has been put into it yet, but a dashed ring in
 * full-strength ink wearing the halo — the marks of a state that asks. A
 * hole drawn in outline that has not been filled in, next to solid discs
 * that have.
 *
 * The halo floats off the disc through `outline-offset`, whose gap is
 * genuinely transparent — the one ring construction that survives the three
 * backgrounds a row can sit on. It is also what makes the actionable marks
 * physically larger, which is half of what the halo is for.
 */
export const STAGE_FILL: Record<GroupKey, string> = {
  verdict:
    "border-[1.5px] border-dashed border-open text-open [outline:1.5px_solid_color-mix(in_srgb,var(--open)_45%,transparent)] outline-offset-2",
  fix: "bg-todo text-bg [outline:1.5px_solid_var(--todo)] outline-offset-2",
  posted: "bg-sent text-bg [outline:1.5px_solid_var(--sent)] outline-offset-2",
  invalid: "border-[1.5px] border-drop/70 text-drop/80",
  tolerated: "border-[1.5px] border-tolerated/70 text-tolerated/80",
  resolved: "border-[1.5px] border-done/70 text-done/80",
  back: "bg-p1 text-bg [outline:1.5px_solid_var(--p1)] outline-offset-2",
};

export const STAGE_SAYS: Record<GroupKey, string> = {
  verdict: "Needs a verdict",
  fix: "Accepted, still to fix",
  posted: "Reported to the author",
  invalid: "Invalid — the review got this wrong",
  tolerated: "Tolerated — it stands, carried on purpose",
  resolved: "Fixed",
  back: "Came back",
};
