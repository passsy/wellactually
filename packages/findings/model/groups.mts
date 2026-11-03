/**
 * The six piles a finding can be in, and how a finding lands in one.
 *
 * Its own module because everything that shows a finding needs it and they do
 * not otherwise share code: the report groups by it, the triage queue filters
 * by it, the track draws a stop per rung of it, and the SARIF export orders
 * by it. It used to live in the report and be shipped to the browser as the
 * text of its own source, which worked exactly as long as it kept having no
 * dependencies.
 *
 * Pure, and deliberately so. A pile is a function of three fields and nothing
 * else, so two surfaces can never come to different answers about the same
 * finding.
 */

export const GROUP_TITLES = {
  back: "Came back",
  verdict: "Needs a verdict",
  fix: "To fix",
  posted: "Reported",
  invalid: "Invalid",
  tolerated: "Tolerated",
  resolved: "Resolved",
} as const;

export type GroupKey = keyof typeof GROUP_TITLES;

/** Report order: what needs doing first, history last. Invalid sits with the
 * work rather than the history because it owes an action too — the rule
 * issue — and tolerated follows it as the pile that owes nothing. */
export const GROUP_ORDER: GroupKey[] = [
  "back",
  "verdict",
  "fix",
  "posted",
  "invalid",
  "tolerated",
  "resolved",
];

/**
 * Which pile a finding is in.
 *
 * Reported sits above accepted rather than beside it, because a finding the
 * author has been told about has left the reviewer's hands: what is left is
 * waiting for someone else. It outranks the verdict for the same reason
 * accepting is optional — the author has been told either way, and a finding
 * that says "undecided" after it has been reported is a lie about where it
 * stands. Only being fixed, failed or coming back outranks it.
 */
export function groupOf(finding: {
  verdict: string;
  resolution: string;
  reportedAt?: string;
}): GroupKey {
  if (finding.resolution === "regressed") return "back";
  if (finding.resolution === "resolved") return "resolved";
  if (finding.verdict === "invalid") return "invalid";
  if (finding.verdict === "tolerated") return "tolerated";
  if (finding.reportedAt) return "posted";
  if (finding.verdict === "accepted") return "fix";
  return "verdict";
}
