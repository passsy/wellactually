/**
 * Every key the page answers to, and what the popup says about each.
 *
 * One table rather than a handler and a legend beside it. A list of shortcuts
 * written next to the code that implements them is a list that goes stale,
 * and the failure is silent: the popup keeps promising a key that stopped
 * doing anything. Built from the same entries, it cannot.
 *
 * The table is data, at module level: what "j" means does not change per
 * render, only what it lands on. Each binding closes over the actions
 * parameter it will be handed at press time, so the page hands its current
 * handlers to the hook and the table never has to be rebuilt.
 *
 * Every shortcut swallows its key, so a key that acts never also types.
 */

import { useEffect, useRef } from "react";

export interface Actions {
  /** Mark the shown finding to come back to, or clear it. */
  flag: () => void;
  up: () => void;
  down: () => void;
  step: (by: number) => void;
  tap: (to: string) => void;
  openFile: () => void;
  writeNote: () => void;
  toggleRead: () => void;
  openReviews: () => void;
  openKeys: () => void;
  openCommand: () => void;
  toggleRail: () => void;
}

/** The three questions a key can answer, in the order they come up. */
export const GROUPS = [
  "Getting around",
  "Ruling on this finding",
  "Looking closer",
] as const;

export type Group = (typeof GROUPS)[number];

export interface Shortcut {
  /** As drawn in the list. */
  show: string[];
  /** The same keys written another way, when there is one. */
  also?: string[];
  does: string;
  group: Group;
  /** What `event.key` has to be. Absent for Escape, which is handled first. */
  on?: Record<string, (actions: Actions) => void>;
  /**
   * A key that has to be answered before the guards.
   *
   * Everything else on this page is a bare letter, so a note being typed into
   * has to keep its letters. This one is held with a modifier precisely so it
   * still works mid-sentence — which is exactly when you want to jump
   * somewhere else — so it is checked first, the way Escape is.
   */
  needs?: "mod";
}

export const SHORTCUTS: Shortcut[] = [
  {
    show: ["⌘", "K"],
    also: ["Ctrl", "K"],
    does: "Jump to anything",
    group: "Getting around",
    needs: "mod",
    on: {
      k: (a) => {
        a.openCommand();
      },
    },
  },
  {
    show: ["↑", "↓"],
    also: ["k", "j"],
    does: "Move through the queue",
    group: "Getting around",
    on: {
      ArrowUp: (a) => {
        a.up();
      },
      ArrowDown: (a) => {
        a.down();
      },
      k: (a) => {
        a.up();
      },
      j: (a) => {
        a.down();
      },
    },
  },
  {
    show: ["←", "→"],
    does: "Move this finding a stop along the track",
    group: "Ruling on this finding",
    on: {
      ArrowLeft: (a) => {
        a.step(-1);
      },
      ArrowRight: (a) => {
        a.step(1);
      },
    },
  },
  // Each of these presses the stop it names, and pressing the stop the
  // finding is already at steps back to open. So the popup says the stop,
  // not a verb.
  {
    show: ["i"],
    does: "Invalid — the review got this wrong",
    group: "Ruling on this finding",
    on: {
      i: (a) => {
        a.tap("invalid");
      },
    },
  },
  {
    show: ["t"],
    does: "Tolerated — it stands, carried on purpose",
    group: "Ruling on this finding",
    on: {
      t: (a) => {
        a.tap("tolerated");
      },
    },
  },
  {
    show: ["u"],
    does: "Open — back to undecided",
    group: "Ruling on this finding",
    on: {
      u: (a) => {
        a.tap("open");
      },
    },
  },
  {
    show: ["a"],
    does: "Accepted",
    group: "Ruling on this finding",
    on: {
      a: (a) => {
        a.tap("accepted");
      },
    },
  },
  {
    show: ["p"],
    does: "Reported",
    group: "Ruling on this finding",
    on: {
      p: (a) => {
        a.tap("reported");
      },
    },
  },
  {
    show: ["r"],
    does: "Fixed",
    group: "Ruling on this finding",
    on: {
      r: (a) => {
        a.tap("fixed");
      },
    },
  },
  {
    show: ["v"],
    does: "Open the file beside the finding",
    group: "Looking closer",
    on: {
      v: (a) => {
        a.openFile();
      },
    },
  },
  {
    show: ["n"],
    does: "Write a note",
    group: "Ruling on this finding",
    on: {
      n: (a) => {
        a.writeNote();
      },
    },
  },
  {
    show: ["f"],
    does: "Flag it to come back to, or take the flag off",
    group: "Ruling on this finding",
    on: {
      f: (a) => {
        a.flag();
      },
    },
  },
  {
    show: ["m"],
    does: "Mark unread, or read again",
    group: "Getting around",
    on: {
      m: (a) => {
        a.toggleRead();
      },
    },
  },
  {
    show: ["b"],
    does: "Show or put away the rail",
    group: "Getting around",
    on: {
      b: (a) => {
        a.toggleRail();
      },
    },
  },
  {
    show: ["g"],
    does: "Every review, from every checkout",
    group: "Getting around",
    on: {
      g: (a) => {
        a.openReviews();
      },
    },
  },
  {
    show: ["?"],
    does: "This list",
    group: "Looking closer",
    on: {
      "?": (a) => {
        a.openKeys();
      },
    },
  },
  {
    show: ["Esc"],
    does: "Close whatever is open",
    group: "Getting around",
  },
];

/** Every binding in one map, checked once rather than per keystroke. */
const PRESSED: Record<string, (actions: Actions) => void> = Object.assign(
  {},
  ...SHORTCUTS.filter((entry) => !entry.needs).map((entry) => entry.on ?? {}),
) as Record<string, (actions: Actions) => void>;

/** The same, for the ones held with a modifier. */
const HELD: Record<string, (actions: Actions) => void> = Object.assign(
  {},
  ...SHORTCUTS.filter((entry) => entry.needs === "mod").map(
    (entry) => entry.on ?? {},
  ),
) as Record<string, (actions: Actions) => void>;

/**
 * Whether a keystroke belongs to whoever is typing rather than to the page.
 *
 * Every letter here is a shortcut, so a note being written would otherwise be
 * one long sequence of verdicts.
 */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  );
}

export function useKeys(actions: Actions, escape: () => void): void {
  // The listener is bound once; what the keys land on is read at press time.
  // Rebinding a document listener because a handler closed over new state is
  // churn the reader can feel: a key pressed during the swap goes nowhere.
  const live = useRef({ actions, escape });
  useEffect(() => {
    live.current = { actions, escape };
  });

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // Leaving the note is the same key as the way out of everything else,
      // so it is answered before the check that would ignore it.
      if (event.key === "Escape") {
        if (typing(event.target)) (event.target as HTMLElement).blur();
        else live.current.escape();
        return;
      }
      // Before both guards below, for the same reason Escape is: a key held
      // with a modifier is not a letter anybody is typing, and the one moment
      // you most want to jump somewhere else is mid-sentence in a note.
      if ((event.metaKey || event.ctrlKey) && !event.altKey) {
        const held = HELD[event.key.toLowerCase()];
        if (held) {
          event.preventDefault();
          held(live.current.actions);
        }
        return;
      }
      if (typing(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const act = PRESSED[event.key];
      if (!act) return;
      event.preventDefault();
      act(live.current.actions);
    }

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, []);
}
