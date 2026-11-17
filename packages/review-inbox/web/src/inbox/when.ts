/**
 * A moment, said the way a reader says it.
 *
 * The server speaks ISO with milliseconds because machines compare it; nobody
 * triaging a queue needs the milliseconds or the Z. The full form stays on
 * the title for the one reader who does.
 */

const WHEN = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function when(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : WHEN.format(at);
}

/** The day alone, for facts where the hour is noise — a pull request's age. */
const DAY = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

export function day(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : DAY.format(at);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY_LONG = 24 * HOUR;

/**
 * How long ago, in as few characters as it takes.
 *
 * For a list held in recency order, where the question a date answers is
 * "how recent" and not "which date": "2h" answers it at a glance and in a
 * quarter of the width, and a list of them can be read down without doing
 * arithmetic against today. Past a week the elapsed count stops meaning
 * anything to anybody, so it becomes the date after all. The exact moment
 * stays on the title.
 *
 * Floored rather than rounded: something written 90 minutes ago is an hour
 * ago and not two, the way a person would say it.
 */
export function since(iso: string): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return iso;
  const gap = Date.now() - at;
  if (gap < MINUTE) return "now";
  if (gap < HOUR) return `${String(Math.floor(gap / MINUTE))}m`;
  if (gap < DAY_LONG) return `${String(Math.floor(gap / HOUR))}h`;
  if (gap < 7 * DAY_LONG) return `${String(Math.floor(gap / DAY_LONG))}d`;
  return day(iso);
}
