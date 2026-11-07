/**
 * The triage page.
 *
 * Keyboard-first because the job is a queue: thirty findings should take two
 * minutes, and a mouse cannot do that.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Group, Panel, Separator } from "react-resizable-panels";
import {
  keys,
  listFindings,
  listReviews,
  markFollow,
  markSeen,
  setNote,
  setStage,
  type Where,
} from "./api.ts";
import { useLive } from "./hooks/useLive.ts";
import { useVisible } from "./hooks/useVisible.ts";
import { openedWith, useAddress } from "./hooks/useAddress.ts";
import { Queue } from "./Queue.tsx";
import { Detail } from "./Detail.tsx";
import { NoteFooter } from "./NoteFooter.tsx";
import { Header, MergedBanner } from "./Header.tsx";
import { Rail } from "./Rail.tsx";
import { counted, flagged, isMerged, marked } from "./reviews.ts";
import { remember, remembered } from "./remembered.ts";
import { useKeys } from "./hooks/useKeys.ts";
import { STOPS, stopOf } from "../shared/stage.tsx";
import { FILTERS, keep, order } from "./filters.ts";
import { Documents } from "./Documents.tsx";
import { FilePanel, type Showing } from "./FilePanel.tsx";
import { Command } from "./Command.tsx";
import { jumpTo, type Hit } from "./palette.ts";
import type { SourceView } from "./api.ts";
import {
  countsOf,
  isUnseen,
  type Finding,
  type FindingList,
} from "../shared/domain.ts";

/**
 * A repository named by full path, by its directory name, or by neither.
 *
 * A link carries whichever the person writing it had, and a review worktree
 * is usually referred to by the last part of its path.
 */
function repoNamed(paths: string[], wanted: string | undefined): string | null {
  if (!wanted) return null;
  const trimmed = wanted.replace(/\/+$/, "");
  return (
    paths.find((path) => path === trimmed) ??
    paths.find((path) => path.split("/").pop() === trimmed) ??
    paths.find((path) => path.endsWith(`/${trimmed}`)) ??
    null
  );
}

/**
 * How long a finding is looked at before it counts as read.
 *
 * Long enough that holding an arrow key down does not mark the queue read on
 * the way past, short enough that reading never has to think about it.
 */
const SEEN_DELAY = 700;

/** Wide enough for a diff's two margins of context, not just one line. */
const PANEL_WIDE = 1040;

/** Narrower than this and it is a scrollbar with a header on it. */
const PANEL_LEAST = 260;

/** Wide enough for a review's title to be a title rather than an initial. */
const RAIL_WIDE = 291;

/**
 * Narrower than this and the reviews are ellipses with counts beside them.
 *
 * The only bound. There is no ceiling: a grip that stops moving while the
 * cursor keeps going is a grip that argues with the person holding it, and
 * dragged past what the window can hold the page simply pans — which is
 * already what it does at any width, and is one double-click from undone.
 */
const RAIL_LEAST = 180;

/**
 * The keyboard is a list of keys, not a file.
 *
 * Everything else the panel shows is as wide as the reader has dragged it,
 * because what it has to fit is a line of source. Two columns of shortcuts
 * across half the window is a list with a field of empty beside it.
 */
const PANEL_KEYS = 420;

export function App() {
  const live = useLive();
  /** Whether anybody is looking, which decides what counts as being read. */
  const visible = useVisible();
  const client = useQueryClient();
  const asked = useMemo(() => openedWith(), []);
  const [chosen, setChosen] = useState<Where | null>(null);
  const [at, setAt] = useState(0);
  const [filter, setFilter] = useState("");
  /** The tag the queue is held to, and null when it is not. */
  const [tag, setTag] = useState<string | null>(null);
  /** What the panel is showing, and null when it is closed. */
  const [panel, setPanel] = useState<Showing | null>(null);
  /** What order the queue is in, remembered because it is a preference. */
  const [sort, setSort] = useState(() => remembered().sort ?? "worst");
  /**
   * Whether the rail is out.
   *
   * A link that names a review is a link to *that* review — somebody was sent
   * it, or posted it at the start of a run — and the column for choosing a
   * different one is the last thing they need. Opening the page at its root
   * is the opposite: no review was named, so the first question is which one,
   * and that is the rail's whole job.
   *
   * Deliberately not written back to storage. This is what the address asked
   * for on one visit, not a preference, and a link arriving while the rail is
   * away must not turn "away" into how this reader likes it.
   */
  const [rail, setRail] = useState(() =>
    (asked.repo ?? asked.target ?? asked.finding)
      ? false
      : (remembered().rail ?? true),
  );
  const [railWide, setRailWide] = useState(
    () => remembered().railWidth ?? RAIL_WIDE,
  );

  /**
   * What the page insists the window be wide enough for.
   *
   * The three working columns need a floor of their own and the rail is
   * however wide it has been dragged, so the stylesheet adds the two rather
   * than naming a number that goes stale the first time somebody drags it.
   * Put away the rail costs nothing, which is most of the reason to put it
   * away on a small screen. On the body, because the width the window pans
   * over is the body's.
   */
  useEffect(() => {
    document.body.classList.toggle("rail-closed", !rail);
    document.body.style.setProperty("--rail", `${String(railWide)}px`);
  }, [rail, railWide]);

  const showRail = useCallback((next: boolean) => {
    setRail(next);
    remember({ rail: next });
  }, []);

  /**
   * What the panel shows while it leaves.
   *
   * Closing sets `panel` to null, and content keyed on that alone unmounts on
   * the spot — the sheet's exit animation plays on an empty frame. The last
   * thing shown stays rendered through the slide out; the library unmounts it
   * when the animation ends.
   */
  const [lastPanel, setLastPanel] = useState(panel);
  if (panel && panel !== lastPanel) setLastPanel(panel);
  const leaving = panel ?? lastPanel;
  // Remembered across files: a reader working through a change stays in the
  // same view, and re-picking it on every file is a click per finding.
  const [view, setView] = useState<SourceView>(
    () => remembered().view ?? "new",
  );

  const reviews = useQuery({ queryKey: keys.reviews, queryFn: listReviews });

  /**
   * Which review is open.
   *
   * The link wins the first time and the page wins afterwards. A link naming
   * a review nobody has written to yet is the normal early case rather than a
   * bad link — the address is posted before the run starts, which is the
   * point of posting it — so nothing falls back to a different review: a page
   * showing somebody else's findings under the name you asked for is worse
   * than a page showing nothing.
   */
  const where: Where | null = useMemo(() => {
    if (chosen) return chosen;
    const all = reviews.data ?? [];
    const repo = repoNamed(
      all.map((review) => review.repo),
      asked.repo,
    );
    const wanted = all.find(
      (review) =>
        (!repo || review.repo === repo) &&
        (!asked.target || review.target === asked.target),
    );
    if (wanted) return { repo: wanted.repo, target: wanted.target };
    if (asked.repo) return null;
    const first = all[0];
    return first ? { repo: first.repo, target: first.target } : null;
  }, [chosen, reviews.data, asked]);

  const findings = useQuery({
    queryKey: where ? keys.findings(where) : ["findings", "none"],
    queryFn: () => {
      if (!where) return Promise.reject(new Error("no review open"));
      return listFindings(where);
    },
    enabled: where !== null,
  });

  /**
   * The one finding allowed to stay unread while being looked at.
   *
   * Put back by hand, so the clock that marks findings read on sight has to
   * be told, or it would take the mark straight back off again while the
   * reader is still on it. Leaving ends the deliberate "not yet": coming back
   * is a fresh look.
   */
  const [kept, setKept] = useState<string | null>(null);

  /**
   * Read findings still shown under the "new" filter.
   *
   * Reading one would otherwise drop it out of the list under the cursor.
   * Each stays until the filter is set again, which is when the reader asks
   * the question anew. State rather than a ref, because the queue is computed
   * from it: a held row is a row the render has to keep drawing.
   */
  const [held, setHeld] = useState<ReadonlySet<string>>(new Set());

  const queue: Finding[] = useMemo(
    () =>
      order(
        keep(
          findings.data?.findings ?? [],
          filter,
          findings.data?.seen ?? {},
          tag,
          held,
          findings.data?.follow ?? {},
        ),
        sort,
      ),
    [findings.data, filter, tag, held, sort],
  );
  /**
   * The cursor follows the finding, not the row number.
   *
   * A review writes while it is being read, and the queue is worst-first: a
   * p0 arriving sorts into the middle and every row below it moves down one.
   * The cursor is an index, so on its own it stays on the number and the
   * finding under the reader changes — mid-sentence, with a verdict about to
   * be pressed on it.
   *
   * Keyed on the findings array rather than on the queue. React Query hands
   * back the same array when a refetch changes nothing, so this fires when
   * the review actually wrote something, and not when the reader asks a
   * different question: setting a filter or holding to a tag rebuilds the
   * queue too, and those are meant to start at the top.
   *
   * The review switch below wins, because arriving at a new review is not a
   * queue moving under the cursor — and finding ids repeat across reviews,
   * so following one by id would land on a namesake.
   */
  const [lastFindings, setLastFindings] = useState(findings.data?.findings);
  /** What the cursor was on when the queue last stood still. */
  const [resting, setResting] = useState<string | null>(null);
  let index = Math.min(at, queue.length - 1);
  if (findings.data?.findings !== lastFindings) {
    setLastFindings(findings.data?.findings);
    const moved = queue.findIndex((finding) => finding.id === resting);
    // Not found is a finding that has gone: dismissed out of this filter, or
    // deleted. The cursor stays on the row number, which is the nearest thing
    // left to where the reader was.
    if (moved >= 0 && moved !== at) {
      setAt(moved);
      index = moved;
    }
  }
  const here = queue[index];
  if (here && here.id !== resting) setResting(here.id);

  /**
   * Every count the page shows, from one pass over one array.
   *
   * The rail's rows, the header's bar and the filter list are the same facts
   * drawn three times, and counters that can disagree is a bug report waiting
   * to be written. This is the one, counted by the server's own function.
   */
  const counts = useMemo(
    () =>
      countsOf(
        findings.data?.findings ?? [],
        findings.data?.seen ?? {},
        findings.data?.follow ?? {},
      ),
    [findings.data],
  );

  /**
   * Every review, with the open one counted from what is in front of you.
   *
   * The rest of the list is the server's, which is the only place it can come
   * from. The open one is not: everything it takes to count that review is
   * already here, so the row and the page it names move together instead of
   * the row catching up a few hops later.
   */
  const every = useMemo(
    () => counted(reviews.data ?? [], where, findings.data ? counts : null),
    [reviews.data, where, findings.data, counts],
  );

  /** How many findings wear each tag, for the rail and the palette. */
  const tagCounts = useMemo(() => {
    const per: Record<string, number> = {};
    for (const finding of findings.data?.findings ?? []) {
      for (const one of finding.tags ?? []) per[one] = (per[one] ?? 0) + 1;
    }
    return per;
  }, [findings.data]);

  /**
   * The tab title says what the rail says.
   *
   * The page is usually behind something else while a review runs, and a
   * count that only exists on screen is a count nobody sees arrive.
   */
  const unread = every.reduce((sum, review) => sum + review.counts.unread, 0);
  useEffect(() => {
    document.title = unread > 0 ? `Review Inbox (${unread})` : "Review Inbox";
  }, [unread]);

  useAddress({ repo: where?.repo, target: where?.target, finding: here?.id });

  // A review that has been switched to starts at the top of its own queue.
  // Adjusted while rendering rather than in an effect: the queue below would
  // otherwise paint one frame of the new review with the old review's row
  // selected, and React re-runs this pass before anything reaches the screen.
  const showing = `${where?.repo ?? ""} ${where?.target ?? ""}`;
  const [shown, setShown] = useState(showing);
  if (shown !== showing) {
    setShown(showing);
    setAt(0);
    setResting(null);
  }

  /**
   * A link naming a finding opens that finding, once.
   *
   * Once only: after the first queue has arrived the reader is driving, and a
   * link that keeps reasserting itself would drag them back to where the link
   * pointed every time the review writes anything.
   */
  const [aimed, setAimed] = useState(asked.finding === undefined);
  if (!aimed && queue.length > 0) {
    setAimed(true);
    const index = queue.findIndex((finding) => finding.id === asked.finding);
    if (index >= 0) setAt(index);
  }

  /**
   * A finding the palette asked for that the queue was not showing.
   *
   * The filter has been cleared by then, so the row arrives in the queue a
   * render later and this is what catches it. Given up on once the queue is
   * showing everything and it still is not there, which is a finding that has
   * been deleted under the reader rather than one that is hidden.
   */
  const [wanted, setWanted] = useState<string | null>(null);
  if (wanted !== null) {
    const index = queue.findIndex((finding) => finding.id === wanted);
    if (index >= 0) {
      setWanted(null);
      setAt(index);
    } else if (filter === "" && tag === null) {
      setWanted(null);
    }
  }

  const fresh = useCallback(() => {
    if (where)
      void client.invalidateQueries({ queryKey: keys.findings(where) });
  }, [client, where]);

  /**
   * Records that a finding has been read, or puts it back.
   *
   * Written here first and sent afterwards, because this is the one thing on
   * the page the page itself decides: the server is being told what was read,
   * not asked. It used to be sent, then read back, and the rail waited on a
   * third hop after that — so the row you were looking at and the row naming
   * the review it is in disagreed for a moment every time.
   *
   * A write that does not land puts the page back to whatever the server
   * says, which is the only honest answer once the two have come apart.
   */
  const setRead = useCallback(
    (id: string, read: boolean) => {
      if (!where) return;
      if (read && filter === "new") setHeld((was) => new Set(was).add(id));
      setKept(read ? null : id);
      const at = new Date().toISOString();
      const key = keys.findings(where);
      // A fetch already on its way would land on top of this with the answer
      // from before it, and the mark would blink off and back on.
      void client.cancelQueries({ queryKey: key });
      client.setQueryData<FindingList>(key, (was) =>
        was ? marked(was, id, read, at) : was,
      );
      void markSeen(where, [id], read).catch(fresh);
    },
    [where, filter, fresh, client],
  );

  /**
   * Looking at a finding is reading it.
   *
   * The clock restarts when the shown finding changes, and a finding
   * rewritten under the reader starts one too, because it just went unread
   * again while being looked at. The cleanup is what makes "moved" need no
   * bookkeeping: leaving a finding cancels its clock.
   *
   * Only while somebody is looking, which is the part this used to take for
   * granted. A tab left open on a review is not a tab being read, and a
   * finding that lands in one while it sits behind six other windows was
   * being marked read by nobody — the one mark the reader has for "I have
   * seen this", spent on their behalf without them.
   */
  // Leaving ends a deliberate "not yet": the kept finding is put back and the
  // reader moves on, and coming to it again is a fresh look. Adjusted while
  // rendering, the same way the review switch is, so the clock below never
  // sees a kept id from a finding that is no longer shown.
  if (kept !== null && here && kept !== here.id) setKept(null);

  useEffect(() => {
    if (!visible) return;
    if (!here || !where) return;
    if (!isUnseen(here, findings.data?.seen[here.id])) return;
    if (kept === here.id) return;
    const timer = setTimeout(() => {
      setRead(here.id, true);
    }, SEEN_DELAY);
    return () => {
      clearTimeout(timer);
    };
  }, [here, where, findings.data, setRead, kept, visible]);

  /**
   * The reader's flag: come back to this one.
   *
   * Written into the page's own copy before it is sent, for the same reason
   * reading is — this is the reader's own mark, and a mark that waits for a
   * round trip is a mark that can be lost to the next keystroke.
   */
  const flag = useCallback(
    (id: string, on: boolean) => {
      if (!where) return;
      const at = new Date().toISOString();
      const key = keys.findings(where);
      void client.cancelQueries({ queryKey: key });
      client.setQueryData<FindingList>(key, (was) =>
        was ? flagged(was, id, on, at) : was,
      );
      void markFollow(where, [id], on).catch(fresh);
    },
    [where, fresh, client],
  );

  const move = useMutation({
    mutationFn: ({ id, to }: { id: string; to: string }) => {
      if (!where) return Promise.reject(new Error("no review open"));
      return setStage(where, id, to);
    },
    onSuccess: fresh,
  });

  const open = every.find(
    (review) => review.repo === where?.repo && review.target === where.target,
  );

  // Read once: this is localStorage plus a JSON parse, and it was running on
  // every render for a value that only changes through this page's own
  // remember() calls.
  const [sizes] = useState(() => remembered().widths ?? {});

  /**
   * How much of the page the file panel covers.
   *
   * In pixels rather than a share of the width, because it is over the page
   * rather than a column of it: what it has to fit is a line of source, which
   * is a number of characters and not a proportion of the window.
   */
  const [wide, setWide] = useState(() => remembered().panel ?? PANEL_WIDE);

  const grab = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      // Not prevented: that would suppress the double-click that resets it.
      document.body.classList.add("dragging");
      const from = event.clientX;
      const was = target.parentElement?.getBoundingClientRect().width ?? 0;
      const drag = (moved: PointerEvent) => {
        setWide(
          Math.max(PANEL_LEAST, Math.round(was + (from - moved.clientX))),
        );
      };
      const drop = () => {
        target.removeEventListener("pointermove", drag);
        document.body.classList.remove("dragging");
        setWide((now) => {
          remember({ panel: now });
          return now;
        });
      };
      target.addEventListener("pointermove", drag);
      target.addEventListener("pointerup", drop, { once: true });
      target.addEventListener("pointercancel", drop, { once: true });
    },
    [setWide],
  );

  /**
   * The same drag, on the other edge and the other way round.
   *
   * How wide a list of review titles wants to be is a question about the
   * titles, the screen and who is reading, which is not a thing a stylesheet
   * can know. So the page ships a width that works and then gets out of the
   * way; double-clicking the grip puts it back.
   */
  const grabRail = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      document.body.classList.add("dragging");
      const from = event.clientX;
      const was = target.parentElement?.getBoundingClientRect().width ?? 0;
      const drag = (moved: PointerEvent) => {
        setRailWide(
          Math.max(RAIL_LEAST, Math.round(was + (moved.clientX - from))),
        );
      };
      const drop = () => {
        target.removeEventListener("pointermove", drag);
        document.body.classList.remove("dragging");
        setRailWide((now) => {
          remember({ railWidth: now });
          return now;
        });
      };
      target.addEventListener("pointermove", drag);
      target.addEventListener("pointerup", drop, { once: true });
      target.addEventListener("pointercancel", drop, { once: true });
    },
    [setRailWide],
  );

  /**
   * Holding the queue to a tag is a new question, so it starts at the top.
   * The same tag pressed again is the answer withdrawn: the press is a
   * toggle, so the way into the hold is also the way out of it.
   */
  const pickTag = useCallback((picked: string | null) => {
    setTag((was) => (picked !== null && was === picked ? null : picked));
    setAt(0);
  }, []);

  /**
   * A different question gets a fresh answer: the row that was selected is
   * usually not in the new list at all.
   */
  const pickFilter = useCallback((next: string) => {
    setHeld(new Set());
    setFilter(next);
    setAt(0);
  }, []);

  const [commandOpen, setCommandOpen] = useState(false);

  /** The rail's review list, for the key that means "somewhere else". */
  const railReviews = useRef<HTMLDivElement>(null);

  /**
   * What choosing something in the palette does.
   *
   * Every one of these is state this page already owns: the palette gets a
   * callback, not a copy of anything. The only one with any logic in it is a
   * finding, because the palette searches every finding of the review and the
   * queue is showing one pile of them.
   */
  const choose = useCallback(
    (hit: Hit) => {
      switch (hit.kind) {
        case "review":
          if (hit.review)
            setChosen({ repo: hit.review.repo, target: hit.review.target });
          return;
        case "pile":
          pickFilter(hit.value);
          return;
        case "tag":
          pickTag(hit.value);
          return;
        case "finding": {
          const found = jumpTo(hit.value, queue);
          if ("at" in found) {
            setAt(found.at);
            return;
          }
          // Hidden by the filter, so the filter goes rather than the jump.
          setHeld(new Set());
          setFilter("");
          setTag(null);
          setWanted(hit.value);
          return;
        }
        case "doc":
          setPanel({ kind: "doc", path: hit.value });
          return;
        case "file":
          setPanel({ kind: "file", at: { file: hit.value, line: 1 } });
          return;
        case "rule":
          setPanel({ kind: "rule", id: hit.value });
      }
    },
    [queue, pickFilter, pickTag],
  );

  /**
   * The merged banner, once per review.
   *
   * Kept in state as well as in storage so dismissing it takes effect now:
   * `remembered()` is read once, and a banner that needs a reload to go away
   * is a banner that gets dismissed twice.
   */
  const [mergedSeen, setMergedSeen] = useState<string[]>(
    () => remembered().mergedSeen ?? [],
  );
  const openKey = `${where?.repo ?? ""} ${where?.target ?? ""}`;
  const banner = isMerged(open) && !mergedSeen.includes(openKey);

  /**
   * The note box, for the key that jumps into it. A selector would find any
   * textarea on the page; the ref names the one this shortcut means.
   */
  const note = useRef<HTMLTextAreaElement>(null);

  const focusNote = useCallback(() => {
    note.current?.focus();
  }, []);

  /**
   * A key that toggles: to the stop it names, or back off it.
   *
   * The keys and the track are the same control, so a key presses the stop it
   * names — and pressing the stop a finding is already at is the way back to
   * undecided, which is what the track does when the head is dragged left.
   */
  const tap = useCallback(
    (to: string) => {
      if (!here) return;
      const now = STOPS[stopOf(here)]?.to;
      move.mutate({ id: here.id, to: to === now ? "open" : to });
    },
    [here, move],
  );

  /** One stop along, and nothing at either end. */
  const step = useCallback(
    (by: number) => {
      if (!here) return;
      const next =
        STOPS[Math.max(0, Math.min(STOPS.length - 1, stopOf(here) + by))];
      if (next) move.mutate({ id: here.id, to: next.to });
    },
    [here, move],
  );

  useKeys(
    {
      up: () => {
        setAt((was) => Math.max(0, was - 1));
      },
      down: () => {
        setAt((was) => Math.min(queue.length - 1, was + 1));
      },
      step,
      tap,
      openFile: () => {
        if (!here) return;
        setPanel({
          kind: "file",
          at: {
            file: here.anchor.file,
            line: here.anchor.line,
            endLine: here.anchor.endLine,
          },
        });
      },
      writeNote: focusNote,
      flag: () => {
        if (here) flag(here.id, !findings.data?.follow[here.id]);
      },
      toggleRead: () => {
        if (!here || !where) return;
        setRead(here.id, isUnseen(here, findings.data?.seen[here.id]));
      },
      openReviews: () => {
        // The list is on the page now, so the key that used to open a sheet
        // over it puts the keyboard in it instead. The review already open is
        // where a reader is coming from, so that is the row it lands on.
        const list = railReviews.current;
        (
          list?.querySelector<HTMLElement>('[aria-current="true"]') ??
          list?.querySelector<HTMLElement>("[data-review]")
        )?.focus();
      },
      openKeys: () => {
        setPanel((was) => (was?.kind === "keys" ? null : { kind: "keys" }));
      },
      openCommand: () => {
        setCommandOpen((was) => !was);
      },
      toggleRail: () => {
        showRail(!rail);
      },
    },
    useCallback(() => {
      // Innermost first is not needed: whichever surfaces are open, Escape
      // takes them all away, and the ones already closed do not notice.
      setCommandOpen(false);
      setPanel(null);
    }, [setCommandOpen, setPanel]),
  );

  return (
    <div className="flex h-full">
      {/*
        Everything about getting somewhere else, on the page rather than
        behind a keystroke you have to already know about.
      */}
      <Rail
        reviews={every}
        open={open ?? null}
        onOpen={(review) => {
          setChosen({ repo: review.repo, target: review.target });
        }}
        reviewsRef={railReviews}
        counts={counts}
        filter={filter}
        onFilter={pickFilter}
        tags={open?.tags ?? []}
        tagCounts={tagCounts}
        tag={tag}
        onTag={pickTag}
        onCommand={() => {
          setCommandOpen(true);
        }}
        keysOpen={panel?.kind === "keys"}
        onKeys={() => {
          setPanel((was) => (was?.kind === "keys" ? null : { kind: "keys" }));
        }}
        showing={rail}
        onShowing={showRail}
        width={railWide}
        onGrip={grabRail}
        onGripReset={() => {
          setRailWide(RAIL_WIDE);
          remember({ railWidth: RAIL_WIDE });
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          live={live}
          open={open ?? null}
          counts={counts}
          onShowRail={
            rail
              ? undefined
              : () => {
                  showRail(true);
                }
          }
        />
        {banner && open && (
          <MergedBanner
            review={open}
            onDismiss={() => {
              setMergedSeen((was) => {
                const next = [...was, openKey];
                remember({ mergedSeen: next });
                return next;
              });
            }}
          />
        )}
        <Group
          orientation="horizontal"
          className="min-h-0 flex-1"
          // A stylesheet cannot know how wide a finding list wants to be: it
          // depends on the titles, the screen and who is reading. So the page
          // ships a width that works, remembers what was dragged, and otherwise
          // gets out of the way. Double-clicking a separator puts it back.
          defaultLayout={sizes}
          onLayoutChanged={(layout) => {
            remember({ widths: layout });
          }}
        >
          <Panel id="queue" defaultSize="30" minSize="14">
            {/*
            The documents sit under the queue rather than behind a menu: the
            findings are conclusions and these are the argument they came out
            of, so a reader who doubts one wants them in the same glance.
          */}
            <Group orientation="vertical" className="h-full">
              <Panel id="findings" defaultSize="72" minSize="20">
                <Queue
                  findings={queue}
                  at={at}
                  seen={findings.data?.seen ?? {}}
                  follow={findings.data?.follow ?? {}}
                  onPick={setAt}
                  onTag={pickTag}
                  tag={tag}
                  waiting={where === null && asked.repo !== undefined}
                  total={findings.data?.findings.length ?? 0}
                  onShowAll={() => {
                    setTag(null);
                    pickFilter("");
                  }}
                  says={
                    tag ??
                    FILTERS.find((one) => one.value === filter)?.says ??
                    "All"
                  }
                  sort={sort}
                  onSort={(next) => {
                    // Reordering is not choosing something else: the finding
                    // being read stays the one being read, wherever the new
                    // order puts it.
                    if (here) setWanted(here.id);
                    setSort(next);
                    remember({ sort: next });
                  }}
                />
              </Panel>
              <Separator className="h-px bg-line transition-colors hover:bg-todo data-[state=drag]:bg-todo" />
              <Panel id="docs" minSize="8">
                <Documents
                  where={where}
                  onOpen={(path) => {
                    setPanel({ kind: "doc", path });
                  }}
                />
              </Panel>
            </Group>
          </Panel>
          <Separator className="w-px bg-line transition-colors hover:bg-todo data-[state=drag]:bg-todo" />
          <Panel id="finding" minSize="30">
            <section className="flex h-full min-h-0 flex-col">
              {here ? (
                <>
                  <ScrollArea
                    // Keyed by finding: the swap remounts the pane, which both
                    // starts the entrance and puts the scroll back at the top
                    // of the new finding rather than wherever the last one was.
                    key={here.id}
                    className="animate-in fade-in-0 slide-in-from-bottom-1 min-h-0 flex-1 duration-200"
                  >
                    <Detail
                      finding={here}
                      onMove={(to) => {
                        move.mutate({ id: here.id, to });
                      }}
                      onOpenFile={(at) => {
                        setPanel({ kind: "file", at });
                      }}
                      onOpenRule={(id) => {
                        setPanel({ kind: "rule", id });
                      }}
                      onTag={pickTag}
                      tag={tag}
                    />
                  </ScrollArea>
                  <NoteFooter
                    boxRef={note}
                    finding={here}
                    onMove={(to) => {
                      move.mutate({ id: here.id, to });
                    }}
                    onSave={(id, text) =>
                      where
                        ? setNote(where, id, text).then(fresh)
                        : Promise.reject(new Error("no review open"))
                    }
                  />
                </>
              ) : (
                <p className="animate-in fade-in p-8 text-muted duration-300">
                  {where === null && asked.repo
                    ? "Waiting for this review to write its first finding."
                    : "Nothing to triage here."}
                </p>
              )}
            </section>
          </Panel>
        </Group>
      </div>

      {/*
        Over the page rather than beside it. A file is opened to check a claim
        the finding beside it is making, and a column that takes its width out
        of the queue and the finding reflows both of them to answer a question
        about one — the queue you were reading down loses its titles, and the
        finding you were reading rewraps under the cursor. It comes in from the
        edge it sits on, which is what says it is over the page and not part of
        it.
      */}
      <Sheet
        // The keyboard is the one view in here that is not about a review, so
        // it is also the one that opens before any review has arrived.
        open={panel !== null && (panel.kind === "keys" || where !== null)}
        onOpenChange={(next) => {
          if (!next) setPanel(null);
        }}
        // Not modal: away is still a click. A row picked while the panel is
        // open should select that row, not spend the press on closing.
        modal={false}
      >
        {leaving && (leaving.kind === "keys" || where) && (
          <SheetContent
            side="right"
            data-keeps-panel
            // The sheet's own cross is put away rather than positioned: the
            // panel draws its own in its header bar, where it lines up with
            // the key beside it at whatever height that bar takes.
            className="flex w-[min(var(--panel-wide),92vw)] flex-col gap-0 border-line bg-card p-0 shadow-[-14px_0_34px_rgba(0,0,0,0.22)] sm:max-w-none [&>[data-slot=sheet-close]]:hidden"
            style={
              {
                "--panel-wide": `${String(leaving.kind === "keys" ? PANEL_KEYS : wide)}px`,
              } as CSSProperties
            }
            // The reader is mid-queue; the panel is glanced at, not moved
            // into, so it must not take the keyboard with it as it opens.
            onOpenAutoFocus={(event) => {
              event.preventDefault();
            }}
            // Only two surfaces are not "away", and both act on the panel
            // rather than beside it: the document list, which loads the next
            // document into it, and the footer, where a verdict is a decision
            // about the finding rather than a way of putting the panel down.
            onPointerDownOutside={(event) => {
              const target = event.target as Element | null;
              if (target?.closest("[data-keeps-panel]")) event.preventDefault();
            }}
            onFocusOutside={(event) => {
              event.preventDefault();
            }}
          >
            {/*
              The grip is on the panel's own edge rather than between two
              columns, because there is nothing on the other side of it to
              give width back to: it sets how much of the page the panel
              covers.
            */}
            {leaving.kind !== "keys" && (
              <div
                // The same grip the rail has: a wide hit area with a hairline
                // in it, so every edge on this page that can be moved is a
                // 1px line that goes blue.
                className="group absolute top-0 bottom-0 -left-[3px] z-10 w-[7px] cursor-col-resize"
                onPointerDown={grab}
                onDoubleClick={() => {
                  setWide(PANEL_WIDE);
                  remember({ panel: PANEL_WIDE });
                }}
              >
                <span className="absolute inset-y-0 left-[3px] w-px transition-colors group-hover:bg-todo group-active:bg-todo" />
              </div>
            )}
            <FilePanel
              where={where}
              showing={leaving}
              findings={findings.data?.findings ?? []}
              current={here}
              view={view}
              onView={(next) => {
                setView(next);
                remember({ view: next });
              }}
              onClose={() => {
                setPanel(null);
              }}
              onRule={(id) => {
                setPanel({ kind: "rule", id });
              }}
              onDoc={(path) => {
                setPanel({ kind: "doc", path });
              }}
            />
          </SheetContent>
        )}
      </Sheet>

      <Command
        open={commandOpen}
        onOpenChange={setCommandOpen}
        where={where}
        reviews={every}
        findings={findings.data?.findings ?? []}
        counts={counts}
        tags={open?.tags ?? []}
        onChoose={choose}
      />
    </div>
  );
}
