/**
 * The address bar, which follows the page rather than driving it.
 *
 * A link into a review is read once, on the first load. After that the page
 * is the truth and the address is written from it, so what is in the bar is
 * always a link back to what is on screen. Reading it on every render would
 * drag the reader back to wherever the link pointed every time a finding
 * landed, which is exactly when a review is being watched.
 *
 * Replaced rather than pushed: moving down a queue is not thirty entries of
 * browser history.
 */

import { useEffect, useRef } from "react";

export interface Address {
  repo?: string | undefined;
  target?: string | undefined;
  finding?: string | undefined;
}

/** What the page was opened with. Read once, deliberately. */
export function openedWith(): Address {
  const asked = new URLSearchParams(location.search);
  return {
    repo: asked.get("repo") ?? undefined,
    target: asked.get("target") ?? undefined,
    finding: asked.get("finding") ?? undefined,
  };
}

export function useAddress(now: Address): void {
  const last = useRef("");
  useEffect(() => {
    const url = new URL(location.href);
    for (const key of ["repo", "target", "finding"] as const) {
      const value = now[key];
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    if (url.href === location.href || url.href === last.current) return;
    last.current = url.href;
    history.replaceState(null, "", url);
  }, [now]);
}
