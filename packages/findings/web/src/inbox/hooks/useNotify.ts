/**
 * Telling you about a review that arrived while you were elsewhere.
 *
 * Off until asked for. A page that demands permission on load is refused out
 * of reflex, and the browser remembers that refusal long after the reason for
 * it is gone — so the ask is behind a button, and the button only appears
 * where notifications are possible at all.
 *
 * What is worth a notification is a review that has started since the page
 * was opened, not a finding. A run writes thirty of those in a minute and
 * nobody wants thirty notifications; the review starting is the one event
 * that means "there is something new to work".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReviewSummary } from "../../shared/domain.ts";
import { remember, remembered } from "../remembered.ts";

export type Notify = "unavailable" | "off" | "asking" | "on" | "refused";

function stateNow(): Notify {
  if (typeof Notification === "undefined") return "unavailable";
  if (Notification.permission === "denied") return "refused";
  if (Notification.permission === "granted") {
    return remembered().notify ? "on" : "off";
  }
  return "off";
}

export function useNotify(reviews: ReviewSummary[]): {
  state: Notify;
  ask: () => void;
} {
  const [state, setState] = useState<Notify>(stateNow);

  /**
   * What was already there when the page opened.
   *
   * Null until the first list arrives, because opening the page is not news
   * about every review that has ever run — only about what shows up after.
   */
  const before = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (reviews.length === 0 && before.current === null) return;
    const now = new Set(
      reviews.map((review) => `${review.repo} ${review.target}`),
    );
    const seen = before.current;
    before.current = now;
    if (!seen || state !== "on") return;

    for (const review of reviews) {
      const key = `${review.repo} ${review.target}`;
      if (seen.has(key)) continue;
      const note = new Notification(review.title ?? review.target, {
        body: `A review started in ${review.repo.split("/").pop() ?? review.repo}`,
        tag: key,
      });
      // The window that is already open, rather than another one.
      note.onclick = () => {
        window.focus();
        note.close();
      };
    }
  }, [reviews, state]);

  const ask = useCallback(() => {
    if (state === "on") {
      remember({ notify: false });
      setState("off");
      return;
    }
    if (Notification.permission === "granted") {
      remember({ notify: true });
      setState("on");
      return;
    }
    setState("asking");
    void Notification.requestPermission().then((answer) => {
      const on = answer === "granted";
      remember({ notify: on });
      setState(on ? "on" : answer === "denied" ? "refused" : "off");
    });
  }, [state]);

  return { state, ask };
}
