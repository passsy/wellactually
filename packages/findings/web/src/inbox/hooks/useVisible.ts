/**
 * Whether anybody is actually looking at this tab.
 *
 * A tab being open is not a tab being read, and this page had been treating
 * the two as the same thing in two places that both matter to somebody who
 * keeps a tab per review open all day. One holds a connection the browser
 * only has six of. The other decides what counts as having read a finding.
 *
 * `useSyncExternalStore` rather than state and an effect, because the answer
 * exists before React renders anything: a tab opened in the background starts
 * hidden, and a hook that learns this one paint later would have already told
 * the page it was being watched.
 */

import { useSyncExternalStore } from "react";

function watch(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => {
    document.removeEventListener("visibilitychange", onChange);
  };
}

export function useVisible(): boolean {
  return useSyncExternalStore(
    watch,
    () => document.visibilityState === "visible",
    // Rendered on a server there is no tab, and the page it produces is the
    // one somebody is about to look at.
    () => true,
  );
}
