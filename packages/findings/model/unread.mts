/**
 * Whether this is a finding Pascal has not read yet.
 *
 * The reason the queue needs this at all: findings arrive while the review is
 * still running, so by the time he looks, "undecided" holds both the ones he
 * read and left open on purpose and the ones that appeared while he was
 * reading. Those are different piles and only one of them is work.
 *
 * A finding the review rewrote after it was read comes back as unread, which
 * is why this asks the history when the last edit was rather than whether the
 * finding has been opened at all.
 *
 * Its own module, and pure, because the triage page needs the same answer as
 * the server and the two must not be able to disagree about which findings
 * are new. It used to be shipped to the browser as the text of its own
 * source, which worked exactly as long as it kept having no dependencies.
 */

export function isUnseen(
  finding: { history?: { at: string; edited?: string[] }[] },
  seenAt: string | undefined,
): boolean {
  if (!seenAt) return true;
  const edits = (finding.history ?? []).filter((entry) => entry.edited);
  const last = edits.length ? edits[edits.length - 1] : null;
  // Both are UTC from toISOString, so they compare as text.
  return last ? last.at > seenAt : false;
}
