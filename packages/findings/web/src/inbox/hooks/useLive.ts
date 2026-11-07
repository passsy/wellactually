/**
 * What the server says has changed, and whether it is still there.
 *
 * The browser and an agent work the same queue at the same time, and the
 * agent writes files rather than calling this page. The server watches those
 * files and pushes when any of them move, which covers this page's own writes
 * for free — so nothing is refetched because time passed, only because
 * something actually happened.
 *
 * How it hears about it depends on whether anybody is looking.
 *
 * A browser allows six connections to one origin, shared across every tab of
 * that origin, and an event stream holds one of them open for as long as its
 * tab exists. A reader with a tab per review — which is how this page is
 * actually used — runs out at six, and the way that fails is the worst kind:
 * requests queue instead of erroring, with no timeout, so the seventh page
 * sits there looking exactly like a server that has died.
 *
 * So the stream belongs to the tab being read, and a tab in the background
 * asks instead: one stamp on /api/health saying when anything last moved,
 * against the last one this tab acted on. The same fact as the event, pulled
 * rather than pushed, on a connection handed back to the pool as soon as it
 * answers. It costs a background tab up to a poll of staleness, which the two
 * things a hidden tab still does — count unread in the title, and raise a
 * notification when findings land — can comfortably afford.
 */

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { readHealth } from "../api.ts";
import { useVisible } from "./useVisible.ts";

export type Live = "connecting" | "live" | "gone";

/**
 * How often a tab nobody is looking at asks whether anything moved.
 *
 * Slow enough that ten of them are nothing, quick enough that a notification
 * is still about something that just happened. Browsers throttle timers in
 * background tabs and will stretch this, which is the right thing to happen
 * to it: the longer a tab has been ignored the less it matters when it hears.
 */
const ASK_EVERY = 30_000;

/** The stamp a change event carries, when it carries a readable one. */
function stampOf(event: MessageEvent<string>): string | null {
  try {
    return (JSON.parse(event.data) as { at?: string }).at ?? null;
  } catch {
    return null;
  }
}

export function useLive(): Live {
  const client = useQueryClient();
  const visible = useVisible();
  const [state, setState] = useState<Live>("connecting");
  /** The last moment this tab has already caught up with. */
  const caught = useRef<string | null>(null);
  /** Survives the swap between listening and asking, which the stamp must. */
  const opened = useRef(false);

  useEffect(() => {
    // Everything, rather than working out which review a directory belongs
    // to: the page holds one review's findings and a list of all of them,
    // and a refetch of both is two small requests over loopback.
    const catchUp = (): void => {
      void client.invalidateQueries();
    };
    const first = !opened.current;
    opened.current = true;

    if (visible) {
      // Whatever moved since the last ask is unknown, and this tab is being
      // looked at now. Not on the first mount, where the queries are already
      // on their way and this would only fetch them twice.
      if (!first) catchUp();
      const source = new EventSource("/api/events");
      source.addEventListener("open", () => {
        setState("live");
      });
      source.addEventListener("change", (event: MessageEvent<string>) => {
        caught.current = stampOf(event);
        catchUp();
      });
      source.addEventListener("error", () => {
        // The server ends with the session that started it, and EventSource
        // retries by itself. Saying so beats a page that quietly goes stale.
        setState(
          source.readyState === EventSource.CLOSED ? "gone" : "connecting",
        );
      });
      return () => {
        source.close();
      };
    }

    let stopped = false;
    const ask = async (): Promise<void> => {
      try {
        const health = await readHealth();
        if (stopped) return;
        setState("live");
        if (!health.changedAt || health.changedAt === caught.current) return;
        caught.current = health.changedAt;
        catchUp();
      } catch {
        if (!stopped) setState("gone");
      }
    };
    void ask();
    const timer = setInterval(() => void ask(), ASK_EVERY);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [client, visible]);

  return state;
}
