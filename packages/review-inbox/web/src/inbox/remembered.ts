/**
 * The handful of things this page remembers between visits.
 *
 * All in one key, because they are all the same kind of thing: a decision the
 * reader made about how they want to look at this, which nothing else should
 * re-decide for them.
 */

const KEY = "wellactually-review-inbox";

export interface Remembered {
  repo?: string;
  target?: string;
  filter?: string;
  theme?: string;
  notify?: boolean;
  /** Which version of a file the panel shows: diff, old or new. */
  view?: "diff" | "old" | "new";
  widths?: Record<string, number>;
  /** How wide the file panel is, in pixels. */
  panel?: number;
  /** What order the queue is in: "worst" or "newest". */
  sort?: string;
  /** Whether the rail is showing. Absent means it is. */
  rail?: boolean;
  /** How wide the rail is, in pixels. */
  railWidth?: number;
  /**
   * The reviews whose merged banner has been dismissed, as "<repo> <target>".
   *
   * Per review, because the banner is about one pull request having landed —
   * a reader who has taken that in for one review has not taken it in for the
   * next one.
   */
  mergedSeen?: string[];
}

export function remembered(): Remembered {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return stored !== null && typeof stored === "object" ? stored : {};
  } catch {
    // Written by an older version, or by nobody. Either way, no decisions.
    return {};
  }
}

export function remember(some: Remembered): void {
  try {
    const merged: Remembered = { ...remembered(), ...some };
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    // Private browsing, or a full store. Losing a width is not worth a throw.
  }
}
