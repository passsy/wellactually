/**
 * Who a principle is by, in one line: "Original by @passsy, edited by @john
 * and @jimmy". `handles` starts with the expert of the original and goes on
 * with each who forked it on the way, oldest first. Null when only one
 * expert worked on it.
 */
export function describeCredits(handles: string[]): string | null {
  const [original, ...editors] = handles;
  if (original === undefined || editors.length === 0) {
    return null;
  }
  const named = editors.map((handle) => `@${handle}`);
  const last = named.pop() as string;
  return `Original by @${original}, edited by ${named.length > 0 ? `${named.join(", ")} and ${last}` : last}`;
}
