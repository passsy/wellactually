/**
 * How much text one hook call may hand the agent, in UTF-8 bytes. Claude Code
 * keeps hook context above 10,000 characters out of the conversation, saves it
 * to a file and shows only its first 2 KB. Codex does the same above 2,500
 * tokens, which it counts as 4 bytes each, and shows the start and the end. So
 * whatever lies beyond 10,000 bytes never reaches the agent. Counting bytes
 * covers both, since a character is at least one byte.
 */
export const ADVICE_BUDGET = 9_000;

/** The most advice that still fits in full beside the frame around it, when it is the only principle that fired. */
export const ADVICE_MAX = 7_500;

/** Advice above this is on the long end: it crowds out other principles that fire on the same change. */
export const ADVICE_LONG = 4_000;

const encoder = new TextEncoder();

/** The size of `text` as the budget counts it: UTF-8 bytes, so ä takes 2 and → takes 3. */
export function adviceBytes(text: string): number {
  return encoder.encode(text).length;
}

/** Warnings for the author about how much of the advice an agent gets to read. */
export function adviceLengthWarnings(advice: string): string[] {
  const length = adviceBytes(advice);
  if (length > ADVICE_MAX) {
    return [
      `The advice is ${length.toLocaleString("en")} bytes, more than the ${ADVICE_MAX.toLocaleString("en")} that fit in full (a letter like ä takes 2, a symbol like → takes 3). Agents are only shown its summary. Shorten it or split it into several principles.`,
    ];
  }
  if (length > ADVICE_LONG) {
    return [
      `The advice is ${length.toLocaleString("en")} bytes, on the long end. Above ${ADVICE_LONG.toLocaleString("en")} it leaves little room for other principles that fire on the same change, which then get only their summary.`,
    ];
  }
  return [];
}
