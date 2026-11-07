/**
 * The two axes, and who is allowed to move each.
 *
 * ```text
 *   verdict     undecided ──human──► accepted
 *   (human)         ▲   ├──human──► invalid     (the review got it wrong)
 *                   │   └──human──► tolerated   (it stands, carried on purpose)
 *                   └────── human ──────┘
 *
 *   resolution  unresolved ──agent/human──► resolved ──review──► regressed
 *                    ▲                         │                    │
 *                    └───────── human ─────────┴────────────────────┘
 * ```
 *
 * They are independent. A finding is fixed by someone who never read the
 * review, or dismissed and then rewritten away by unrelated work, and neither
 * of those had a name while there was one axis. What the verdict still owns is
 * authority: nobody but a human decides whether a finding is a problem, and no
 * amount of code changing underneath it decides that for them.
 *
 * A rejected move is an error the caller reads, not a correction the server
 * makes quietly, because the caller is usually a model that will try again
 * with whatever the message tells it.
 */

import type { Actor, Resolution, Verdict } from "./types.mts";

interface Edge {
  to: Resolution;
  by: readonly Actor[];
  /** What the edge means, used to explain a rejection. */
  why: string;
}

const RESOLUTION_EDGES: Record<Resolution, readonly Edge[]> = {
  unresolved: [
    {
      to: "resolved",
      by: ["agent", "human"],
      why: "someone claims the code no longer has it",
    },
  ],
  resolved: [
    { to: "regressed", by: ["review"], why: "a review run found it again" },
    { to: "unresolved", by: ["human"], why: "the fix did not hold up" },
  ],
  regressed: [
    {
      to: "resolved",
      by: ["agent", "human"],
      why: "a commit claims to fix it again",
    },
    { to: "unresolved", by: ["human"], why: "it goes back on the pile" },
  ],
};

export class TransitionError extends Error {}

/**
 * Throws unless a human is the one deciding.
 *
 * There is no graph here on purpose. A human may reach any verdict from any
 * other, including taking one back, because changing your mind about a finding
 * is not a lifecycle violation. The only rule is whose call it is.
 */
export function checkVerdict(from: Verdict, to: Verdict, actor: Actor): void {
  if (from === to) {
    throw new TransitionError(`the finding is already ${to}.`);
  }
  if (actor !== "human") {
    throw new TransitionError(
      `only "human" decides a verdict, because accepting or failing a finding is the user's call and nobody else's. You passed actor "${actor}".`,
    );
  }
}

/**
 * Throws with the reachable states when the move is not allowed.
 *
 * The two failure modes read differently on purpose: a wrong target state is
 * a mistake about the lifecycle, a wrong actor is a mistake about authority,
 * and telling them apart is what stops a retry loop.
 */
export function checkResolution(
  from: Resolution,
  to: Resolution,
  actor: Actor,
): void {
  if (from === to) {
    throw new TransitionError(`the finding is already ${to}.`);
  }
  const edges = RESOLUTION_EDGES[from];
  const edge = edges.find((candidate) => candidate.to === to);
  if (!edge) {
    const reachable = edges.map((each) => `"${each.to}"`).join(", ");
    throw new TransitionError(
      `an ${from} finding cannot become ${to}. From ${from} it can only become ${reachable || "nothing"}.`,
    );
  }
  if (!edge.by.includes(actor)) {
    const allowed = edge.by.map((each) => `"${each}"`).join(" or ");
    throw new TransitionError(
      `only ${allowed} can move a finding from ${from} to ${to}, because ${edge.why}. You passed actor "${actor}".`,
    );
  }
}

/** The resolutions this one can still reach, for list output and the UI. */
export function nextResolutions(from: Resolution): readonly Resolution[] {
  return RESOLUTION_EDGES[from].map((edge) => edge.to);
}
