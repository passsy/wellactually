/**
 * How much text one hook call may hand the agent. Claude Code keeps hook
 * context above 10,000 characters out of the conversation, saves it to a file
 * and shows only its first 2 KB, so whatever lies beyond that never reaches the agent.
 */
export const ADVICE_BUDGET = 9_000;

/** The most advice that still fits in full beside the frame around it, when it is the only principle that fired. */
export const ADVICE_MAX = 7_500;

/** Advice above this is on the long end: it crowds out other principles that fire on the same change. */
export const ADVICE_LONG = 4_000;

/** Warnings for the author about how much of the advice an agent gets to read. */
export function adviceLengthWarnings(advice: string): string[] {
  const length = advice.length;
  if (length > ADVICE_MAX) {
    return [
      `The advice is ${length.toLocaleString("en")} characters, more than the ${ADVICE_MAX.toLocaleString("en")} that fit in full. Agents are only shown its summary. Shorten it or split it into several principles.`,
    ];
  }
  if (length > ADVICE_LONG) {
    return [
      `The advice is ${length.toLocaleString("en")} characters, on the long end. Above ${ADVICE_LONG.toLocaleString("en")} it leaves little room for other principles that fire on the same change, which then get only their summary.`,
    ];
  }
  return [];
}
