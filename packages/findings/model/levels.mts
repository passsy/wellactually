/**
 * How far a multi-level review has got, read off what it has written.
 *
 * Nothing tells the server which level is running. What it can see is which
 * level documents exist: the skill finishes a level by writing `Level-N.md`,
 * a skipped level still writes its document holding the one line that says
 * why, and the README is the last thing a run writes. That is enough to say
 * where a run is, and it costs the skill nothing.
 *
 * Pure, and its own module, for the reason counts.mts is: the card that
 * draws this imports the level names from here rather than restating them.
 */

export interface LevelName {
  /** The level's number, as the skill counts them. */
  n: number;
  /** What a card draws for it: the letter its findings sign with. */
  mark: string;
  /**
   * The letter its findings' ids begin with. Level 0 gathers information and
   * writes no findings of its own, so it has none.
   */
  letter?: string;
  name: string;
}

export const LEVELS: LevelName[] = [
  { n: 0, mark: "0", name: "Context" },
  { n: 1, mark: "A", letter: "A", name: "Approach" },
  { n: 2, mark: "H", letter: "H", name: "Architecture" },
  { n: 3, mark: "T", letter: "T", name: "Tests" },
  { n: 4, mark: "L", letter: "L", name: "Low-level" },
  { n: 5, mark: "R", letter: "R", name: "Framework" },
];

export const LEVEL_STATE = ["pending", "running", "done", "skipped"] as const;
export type LevelState = (typeof LEVEL_STATE)[number];

export interface LevelStatus extends LevelName {
  state: LevelState;
  /**
   * How long it took, or has been running. Absent when the gap to the mark
   * before it is too long to be one sitting: a review that is run again keeps
   * the day it first started, and "Context took three days" is not a duration
   * anybody measured.
   */
  ms?: number;
  /** Why it was skipped, in the level document's own words. */
  skipReason?: string;
}

/** One level document, as far as progress cares about it. */
export interface LevelDocument {
  n: number;
  /** ISO timestamp of the last write. */
  changed: string;
  text: string;
}

/**
 * Longer than this between two marks is two sittings, not one level.
 *
 * Generous on purpose. Level 1 designs blind in sub-agents and can run past
 * an hour; nothing a single level does runs past six.
 */
const ONE_SITTING_MS = 6 * 60 * 60 * 1000;

/**
 * The one line a skipped level's document holds.
 *
 * The skill asks for the skip condition answered in one line at the top, and
 * for a skipped level to hold only that line. So a document is a skip when
 * its body is that short and says so. A level that ran and happens to use
 * the word is not caught by this: it has a body.
 */
export function skipReasonOf(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  // The date and the commit are asked for in every level document, so they
  // are not what makes one a body.
  const said = lines.filter(
    (line) => !/^[-*]?\s*(date|commit|head|base)\b/i.test(line),
  );
  if (said.length !== 1) return undefined;
  const line = said[0] ?? "";
  // The condition is answered either way, and "Not skipped: it has tests"
  // answers it with the same word.
  if (!/\bskip/i.test(line) || /\b(not|no|never)\s+skip/i.test(line)) {
    return undefined;
  }
  return line
    .replace(/^[-*>]\s*/, "")
    .replace(/^\**skipp?(ed|ing)?\**\s*[:.,–-]?\s*/i, "")
    .trim();
}

export function levelsOf(input: {
  /** When the review first wrote anything. */
  startedAt: string;
  documents: readonly LevelDocument[];
  /** Whether the run has written its README, which it does last. */
  finished: boolean;
  now: string;
}): LevelStatus[] {
  const written = new Map(input.documents.map((doc) => [doc.n, doc]));
  // A run told to start at a later level leaves the earlier ones unwritten,
  // and they are not waiting for anything.
  const furthest = Math.max(-1, ...written.keys());
  const running = input.finished
    ? undefined
    : LEVELS.find((level) => level.n > furthest)?.n;

  let mark = Date.parse(input.startedAt);
  return LEVELS.map((level) => {
    const doc = written.get(level.n);
    if (!doc) {
      if (level.n === running) {
        return { ...level, state: "running", ...sitting(mark, input.now) };
      }
      return {
        ...level,
        state: level.n < furthest || input.finished ? "skipped" : "pending",
      };
    }
    const from = mark;
    mark = Date.parse(doc.changed);
    const skipReason = skipReasonOf(doc.text);
    if (skipReason !== undefined) {
      return {
        ...level,
        state: "skipped",
        ...(skipReason === "" ? {} : { skipReason }),
      };
    }
    return { ...level, state: "done", ...sitting(from, doc.changed) };
  });
}

function sitting(from: number, to: string): { ms?: number } {
  const ms = Date.parse(to) - from;
  return ms >= 0 && ms <= ONE_SITTING_MS ? { ms } : {};
}

/** Which level a finding came from, read off the letter its id begins with. */
export function levelOfFinding(id: string): number | undefined {
  return LEVELS.find((level) => level.letter === id[0])?.n;
}
