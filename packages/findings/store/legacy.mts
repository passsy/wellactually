/**
 * Findings written before the verdict and the resolution came apart.
 *
 * The file format is the interface, and reviews already on disk outlive the
 * shape they were written in. So an old finding is read, not rejected: the
 * single `status` it carries maps onto the two axes it would have been given
 * today, and the same for every entry in its history.
 *
 * Upgrading happens on read and is not written back on its own. A finding
 * that is touched gets saved in the new shape; one that is only ever read
 * stays as it is on disk and still reads correctly.
 */

import {
  modernVerdict,
  type Finding,
  type Priority,
  type Resolution,
  type TransitionEntry,
  type Verdict,
} from "../model/types.mts";

/**
 * The five names the priority axis used to have.
 *
 * They were an ordered scale wearing five judgements, so the order is what
 * survives: a finding filed as a Blocker is a p0, one filed as a Nit is a p4.
 * What the words were trying to say about the finding is now its tags, and
 * nothing here invents those — an old finding keeps none.
 */
const RANKED: Record<string, Priority> = {
  Blocker: "p0",
  Degraded: "p1",
  Tripwire: "p2",
  Polish: "p3",
  Nit: "p4",
};

interface Axes {
  verdict: Verdict;
  resolution: Resolution;
  /** The old "verified", which is now a stamp rather than a state. */
  confirmed?: boolean;
}

/** The one axis this server used to store. */
const AXES: Record<string, Axes> = {
  open: { verdict: "undecided", resolution: "unresolved" },
  accepted: { verdict: "accepted", resolution: "unresolved" },
  // The single-axis era had no reasons, so nothing can prove an old dismissal
  // was a claim of invalidity. Tolerated is the verdict that demands nothing.
  dismissed: { verdict: "tolerated", resolution: "unresolved" },
  // Reaching fixed took an acceptance first, so the verdict is recovered
  // rather than guessed. What cannot be recovered is a finding that was
  // fixed without being accepted, because the old lifecycle had no way to
  // say it.
  fixed: { verdict: "accepted", resolution: "resolved" },
  verified: { verdict: "accepted", resolution: "resolved", confirmed: true },
  regressed: { verdict: "accepted", resolution: "regressed" },
};

const OPEN: Axes = { verdict: "undecided", resolution: "unresolved" };

/** An entry as it was written before entries named their axis. */
type LegacyEntry = TransitionEntry & { to?: string };

interface LegacyFinding {
  status?: string;
  history?: LegacyEntry[];
  /** The named scale that became `priority`. */
  impact?: string;
}

function axesOf(status: string | undefined): Axes {
  return AXES[status ?? "open"] ?? OPEN;
}

/** An entry that named a state gets told which axis that state was on. */
function upgradeEntry(entry: LegacyEntry): TransitionEntry {
  if (entry.verdict || entry.resolution || !entry.to) return entry;
  const axes = axesOf(entry.to);
  const moved =
    entry.to === "dismissed"
      ? // The one state that split in two, and the entry's own reason is the
        // witness for which half it meant.
        { verdict: modernVerdict("dismissed", entry.reason) }
      : entry.to === "open" || entry.to === "accepted"
        ? { verdict: axes.verdict }
        : { resolution: axes.resolution };
  const { to: _was, ...rest } = entry;
  return { ...rest, ...moved };
}

/** The finding as this version stores it, whichever version wrote it. */
export function upgrade(finding: Finding): Finding {
  const old = finding as Finding & LegacyFinding;
  if (finding.verdict && finding.resolution) return modern(ranked(finding));

  const axes = axesOf(old.status);
  const entries: LegacyEntry[] = old.history ?? [];
  const history = entries.map(upgradeEntry);
  // A verified finding knew when a run confirmed it: the entry that said so.
  const confirmedAt = axes.confirmed
    ? (entries.findLast((entry) => entry.to === "verified")?.at ??
      finding.createdAt)
    : undefined;

  const upgraded: Finding = {
    ...ranked(finding),
    verdict:
      old.status === "dismissed"
        ? modernVerdict(
            "dismissed",
            entries.findLast((entry) => entry.to === "dismissed")?.reason,
          )
        : axes.verdict,
    resolution: axes.resolution,
    ...(confirmedAt ? { confirmedAt } : {}),
    history,
  };
  delete (upgraded as LegacyFinding).status;
  return modern(upgraded);
}

/**
 * A finding written while the failed verdict was "dismissed", or during the
 * day it was "dismissed"/"parked" with a reason field on the side.
 *
 * The reason is the witness for which of the two new verdicts an old
 * dismissal meant, so it is read before it is dropped: the finding's own
 * field where yesterday's shape wrote one, the dismissing entry's otherwise.
 */
function modern(finding: Finding): Finding {
  const old = finding as Finding & { reason?: string };
  const reason =
    old.reason ??
    finding.history.findLast(
      (entry) => (entry.verdict as string) === finding.verdict && entry.reason,
    )?.reason;
  const verdict = modernVerdict(finding.verdict, reason);
  if (verdict === finding.verdict && old.reason === undefined) return finding;
  const upgraded: Finding = { ...finding, verdict };
  delete (upgraded as { reason?: string }).reason;
  return upgraded;
}

/** A finding written when the priority axis was five names. */
function ranked(finding: Finding): Finding {
  const old = finding as Finding & LegacyFinding;
  if (finding.priority) return finding;
  const upgraded: Finding = {
    ...finding,
    // An unrecognised name lands in the middle rather than at either end: the
    // ordering is a guess either way, and a guess that shouts is worse.
    priority: RANKED[old.impact ?? ""] ?? "p2",
  };
  delete (upgraded as LegacyFinding).impact;
  return upgraded;
}
