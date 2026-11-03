/**
 * The review card: what a host draws in the conversation when a review starts.
 *
 * A header first and nothing else: the levels, which one is running, the
 * clock. The queue grows under it as findings are written, and a finding
 * opens in place of the queue to be read, ruled on and noted.
 *
 * Built from the inbox's own parts, the track above all. A verdict given
 * here is the same verdict as one given there, so it has to be given with
 * the same control and the same keys.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  countsOf,
  levelOfFinding,
  type Finding,
  type LevelStatus,
  type ReviewStatus,
} from "../shared/domain.ts";
import {
  Evidence,
  Noted,
  Priority,
  Rule,
  Stage,
  Tag,
} from "../shared/chips.tsx";
import { Chunk } from "../shared/chunk/Chunk.tsx";
import { Markdown } from "../shared/markdown/Markdown.tsx";
import {
  BLANK_AFTER,
  STOPS,
  flagFor,
  stopOf,
  stopsFor,
} from "../shared/stage.tsx";
import { Track } from "../shared/track/Track.tsx";
import { Meter } from "../inbox/Meter.tsx";
import { cn } from "../shared/cn.ts";
import type { Host } from "./bridge.ts";
import { clock } from "./clock.ts";
import { useReview, type Review } from "./useReview.ts";

/** The letters the inbox binds to the stops, which are not all initials. */
const STOP_KEYS: Record<string, string> = {
  i: "invalid",
  t: "tolerated",
  u: "open",
  a: "accepted",
  p: "reported",
  r: "fixed",
};

const SAVE_AFTER_MS = 700;

/** A finding whose work has ended, one way or another. */
function ended(finding: Finding): boolean {
  const stop = stopOf(finding);
  return stop === 0 || stop === 1 || stop === 5;
}

function Key({ children }: { children: string }) {
  return <kbd className="key">{children}</kbd>;
}

const SAYS: Record<ReviewStatus["state"], string> = {
  running: "Reviewing",
  quiet: "Stopped",
  done: "Reviewed",
};

function Header({ status, review }: { status: ReviewStatus; review: Review }) {
  const title = status.title ?? status.target;
  return (
    <header className="top">
      <span className={cn("live", status.state)}>{SAYS[status.state]}</span>
      <span className="grow truncate" title={title}>
        {status.pr?.number !== undefined && (
          <span className="text-muted">#{status.pr.number} </span>
        )}
        <span className="font-semibold">{title}</span>
      </span>
      {status.elapsedMs !== undefined && (
        <span className="text-muted">{clock(status.elapsedMs)}</span>
      )}
      <button
        type="button"
        className="link"
        onClick={() => {
          review.openInbox();
        }}
      >
        Inbox ↗
      </button>
    </header>
  );
}

/** One level: its mark, its name, how long it took and what it found. */
function Level({ level, found }: { level: LevelStatus; found: Finding[] }) {
  const says =
    level.state === "skipped"
      ? `Level ${String(level.n)} skipped${level.skipReason ? `: ${level.skipReason}` : ""}`
      : `Level ${String(level.n)} · ${level.name}`;
  return (
    <div className={cn("lv", level.state)} title={says}>
      <span className={cn("pip", level.state)}>{level.mark}</span>
      <span className="name truncate">{level.name}</span>
      <span className="sub">
        {level.ms !== undefined && level.state !== "skipped" && (
          <span className="time">{clock(level.ms)}</span>
        )}
        {level.state === "skipped" && <span className="word">skipped</span>}
        {found.length > 0 && (
          <span
            className="found"
            title={found.map((each) => each.id).join(", ")}
          >
            {found.map((each) => (
              <i key={each.id} className={each.priority} />
            ))}
          </span>
        )}
      </span>
    </div>
  );
}

/** What the run is doing, or what it concluded, and how much is left to rule on. */
function Now({ status }: { status: ReviewStatus }) {
  const running = status.levels.find((level) => level.state === "running");
  const counts = countsOf(status.findings, {});
  const total = status.findings.length;
  const waiting = counts.piles.verdict;
  const last = new Date(status.lastAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <div className="now">
      {status.state === "done" ? (
        <span className="grow font-medium">
          {status.verdict ?? "The review is finished."}
        </span>
      ) : status.state === "quiet" ? (
        <span className="grow text-muted">
          Not finished. The last thing written was at {last}.
        </span>
      ) : (
        <span className="grow truncate text-muted italic">
          {running
            ? `Level ${String(running.n)} of 5 · ${running.name}`
            : status.phase === "verification" ? "Verifying findings"
            : status.phase === "review" ? "Reviewing changes"
            : "Starting"}
        </span>
      )}
      {total > 0 && (
        <span className="text-muted">
          {waiting === 0
            ? `${String(total)} decided`
            : `${String(waiting)} of ${String(total)} need a verdict`}
        </span>
      )}
      {total > 0 && <Meter piles={counts.piles} bare className="meter" />}
    </div>
  );
}

function Row({
  finding,
  at,
  fresh,
  onOpen,
}: {
  finding: Finding;
  at: boolean;
  fresh: boolean;
  onOpen: () => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  // Brought into view inside the queue, by moving the queue. scrollIntoView
  // would scroll every ancestor that can scroll, and the outermost one is
  // the conversation: a finding arriving must not move what somebody is
  // reading there.
  useEffect(() => {
    const element = row.current;
    const list = element?.parentElement;
    if (!at || !element || !list) return;
    const top = element.offsetTop;
    const bottom = top + element.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }, [at]);
  const last = finding.anchor.file.split("/").pop() ?? finding.anchor.file;
  return (
    <div
      ref={row}
      role="button"
      tabIndex={-1}
      aria-current={at}
      className={cn(
        "row",
        at && "at",
        fresh && "fresh",
        ended(finding) && "ended",
      )}
      onClick={onOpen}
    >
      <Stage finding={finding} />
      <Priority of={finding.priority} />
      <span className="id font-mono">{finding.id}</span>
      <span className="says grow truncate" title={finding.title}>
        {finding.title}
      </span>
      {(finding.note ?? "") !== "" && <Noted note={finding.note ?? ""} />}
      {finding.tags?.[0] !== undefined && (
        <span className="tag">
          <Tag>{finding.tags[0]}</Tag>
        </span>
      )}
      <span className="where font-mono text-muted">
        {last}:{finding.anchor.line}
      </span>
    </div>
  );
}

/**
 * The reader's own words on a finding, for whoever fixes it.
 *
 * Saved a moment after the typing stops, and again on the way out. What is
 * in the box is the draft until the reader leaves it, because swapping in
 * the stored text mid-sentence would trim the space they had just typed.
 */
function NoteBox({
  finding,
  review,
  boxRef,
}: {
  finding: Finding;
  review: Review;
  boxRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const stored = finding.note ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const sent = useRef(stored);
  const timer = useRef<number | undefined>(undefined);

  const save = (text: string) => {
    window.clearTimeout(timer.current);
    if (text.trim() === sent.current) return;
    sent.current = text.trim();
    review.note(finding, text.trim());
  };

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );

  return (
    <div className="note">
      <label htmlFor="note">
        Your note, for whoever fixes it <Key>N</Key>
        {draft !== null && draft.trim() === stored && stored !== "" && (
          <span>Saved</span>
        )}
      </label>
      <textarea
        id="note"
        ref={boxRef}
        rows={2}
        placeholder="How you want it fixed, or why it stands."
        value={draft ?? stored}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            save(text);
          }, SAVE_AFTER_MS);
        }}
        onBlur={() => {
          if (draft === null) return;
          save(draft);
          setDraft(null);
        }}
      />
    </div>
  );
}

function One({
  status,
  finding,
  review,
  boxRef,
  onShow,
}: {
  status: ReviewStatus;
  finding: Finding;
  review: Review;
  boxRef: RefObject<HTMLTextAreaElement | null>;
  onShow: (id: string | null) => void;
}) {
  const position = status.findings.indexOf(finding) + 1;
  const accepted = status.findings.filter((each) => stopOf(each) === 3);
  return (
    <>
      <div className="strip">
        <button
          type="button"
          className="btn"
          onClick={() => {
            onShow(null);
          }}
        >
          ← Findings <Key>Esc</Key>
        </button>
        <span className="dots">
          {status.findings.map((each) => (
            <button
              key={each.id}
              type="button"
              className={cn(each.id === finding.id && "at")}
              title={`${each.id} · ${each.title}`}
              onClick={() => {
                onShow(each.id);
              }}
            >
              <Stage finding={each} />
            </button>
          ))}
        </span>
        <span className="grow text-muted">
          {position} of {status.findings.length}
        </span>
        <span className="text-muted">
          <Key>↑</Key> <Key>↓</Key>
        </span>
        <FixButton accepted={accepted} review={review} />
      </div>
      <div className="one">
        <div className="facts">
          <Priority of={finding.priority} />
          <span className="font-mono font-semibold">{finding.id}</span>
          {(finding.tags ?? []).map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
          <Evidence of={finding.evidence} />
          {/*
            A rule id nobody could read was an id not worth printing: the
            chip said PW-G007 and the card had no way to say what PW-G007
            is. The server opens the page, the same way the Inbox button
            works, because it is on loopback and the host that draws the
            card opens https.
          */}
          {finding.rule !== undefined && finding.rule !== "" && (
            <Rule
              id={finding.rule}
              href={new URL(`/rule/${finding.rule}`, status.url).href}
              onPick={() => {
                review.openRule(finding.rule ?? "");
              }}
            />
          )}
          {/*
            On the line that says what the finding is, at its far end: the
            first thing in view, and no line of its own to pay for.
          */}
          <span className="rate">
            <span className="text-muted">
              <Key>←</Key> <Key>→</Key>
            </span>
            <Track
              stops={stopsFor(finding)}
              at={stopOf(finding)}
              flag={flagFor(finding)}
              blankAfter={BLANK_AFTER}
              owner={finding.id}
              onPick={(to) => {
                review.move(finding, to);
              }}
            />
          </span>
        </div>
        <h2>{finding.title}</h2>
        <div className="body">
          <Markdown body={finding.body} />
        </div>
        <Chunk
          at={{
            file: finding.anchor.file,
            line: finding.anchor.line,
            endLine: finding.anchor.endLine,
            context: finding.context,
          }}
          withDiff={false}
        />
        {/* Keyed by the finding, so a draft never follows the reader to the next one. */}
        <NoteBox
          key={finding.id}
          finding={finding}
          review={review}
          boxRef={boxRef}
        />
      </div>
    </>
  );
}

/**
 * Hands the accepted findings to the agent, as a message from the user.
 *
 * The card decides nothing about how they get fixed. It says what the user
 * would otherwise have typed, and the conversation carries on from there.
 */
function FixButton({
  accepted,
  review,
}: {
  accepted: Finding[];
  review: Review;
}) {
  const [asked, setAsked] = useState(false);
  if (accepted.length === 0) return null;
  return (
    <button
      type="button"
      className="btn primary"
      disabled={asked}
      onClick={() => {
        setAsked(true);
        review.fix(accepted);
      }}
    >
      {asked
        ? "Asked Claude to fix them"
        : `Fix ${String(accepted.length)} accepted`}
    </button>
  );
}

export function Card({ host }: { host: Host }) {
  const review = useReview(host);
  const { status } = review;
  const [cursor, setCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // Set when N is pressed on a finding that is not open yet: the box it asks
  // for does not exist until the next draw.
  const wantsNote = useRef(false);

  const findings = status?.findings ?? [];
  const here =
    findings.find((each) => each.id === cursor) ?? findings[0] ?? null;
  const shown =
    open === null ? null : (findings.find((each) => each.id === open) ?? null);

  // Which findings a reader who was already looking has not seen arrive.
  // The first draw is not news: a card opened halfway through a run would
  // otherwise announce everything found so far at once.
  const ids = findings.map((each) => each.id).join(" ");
  const [seen, setSeen] = useState<ReadonlySet<string> | null>(null);
  const first = useRef(true);
  const loaded = status !== null;
  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(
      () => {
        setSeen(new Set(ids.split(" ")));
      },
      // Long enough for a row to finish saying it has arrived.
      first.current ? 0 : 1500,
    );
    first.current = false;
    return () => {
      window.clearTimeout(timer);
    };
  }, [ids, loaded]);
  const fresh = (id: string): boolean => seen !== null && !seen.has(id);

  // Said after every draw as well as from an observer. An observer only
  // fires when the page is painted, so a card in a background tab would stay
  // the height it was born with; and a draw is not the only thing that
  // changes the height, so the observer is still needed.
  useLayoutEffect(() => {
    const element = card.current;
    if (element)
      host.resized(Math.ceil(element.getBoundingClientRect().height));
  });
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      host.resized(Math.ceil(element.getBoundingClientRect().height));
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [host]);

  const showing = shown?.id;
  useEffect(() => {
    if (!wantsNote.current || showing === undefined) return;
    wantsNote.current = false;
    box.current?.focus();
  }, [showing]);

  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key;
      if (event.target instanceof HTMLTextAreaElement) {
        // Typing is typing. Only Escape means something else in here.
        if (key === "Escape") {
          event.target.blur();
          event.preventDefault();
        }
        return;
      }
      if (!here) return;
      const step = (by: number) => {
        const next = findings[findings.indexOf(here) + by];
        if (!next) return;
        setCursor(next.id);
        if (open !== null) setOpen(next.id);
      };
      // The inbox's own keys: the arrows slide the pin a stop along, and a
      // letter drops it into the stop it names, or back to open from there.
      const slide = (by: number) => {
        const to =
          STOPS[Math.max(0, Math.min(STOPS.length - 1, stopOf(here) + by))];
        if (to && to.to !== STOPS[stopOf(here)]?.to) review.move(here, to.to);
      };
      const named = STOP_KEYS[key];
      if (key === "j" || key === "ArrowDown") step(1);
      else if (key === "k" || key === "ArrowUp") step(-1);
      else if (key === "ArrowRight") slide(1);
      else if (key === "ArrowLeft") slide(-1);
      else if (named !== undefined) {
        review.move(here, STOPS[stopOf(here)]?.to === named ? "open" : named);
      } else if (key === "Enter" && open === null) setOpen(here.id);
      else if (key === "Escape" && open !== null) setOpen(null);
      else if (key === "n") {
        if (open === here.id) box.current?.focus();
        else {
          wantsNote.current = true;
          setCursor(here.id);
          setOpen(here.id);
        }
      } else if (key === "o") review.openInbox(here);
      else return;
      event.preventDefault();
    };
    document.addEventListener("keydown", press);
    return () => {
      document.removeEventListener("keydown", press);
    };
  });

  // The same element before and after the first answer, so the observer that
  // reports its height is watching the card and not the blank it replaced.
  if (!status) return <div ref={card} />;

  const accepted = findings.filter((each) => stopOf(each) === 3);
  return (
    <div ref={card} className="card">
      <Header status={status} review={review} />
      {status.levels.length > 0 && (
        <div className="levels">
          {status.levels.map((level) => (
            <Level
              key={level.n}
              level={level}
              found={findings.filter(
                (each) => levelOfFinding(each.id) === level.n,
              )}
            />
          ))}
        </div>
      )}
      <Now status={status} />
      {(status.candidates ?? []).length > 0 && (
        <section className="queue" aria-label="Unverified findings" aria-live="polite">
          <p className="aside">Incoming findings · awaiting verification</p>
          {status.candidates!.map(candidate => (
            <details key={candidate.id}>
              <summary><span className="text-muted">Unverified · </span>{candidate.title}</summary>
              <div className="aside">
                <p className="font-mono">{candidate.anchor.file}:{candidate.anchor.line}</p>
                <Markdown body={candidate.body} />
              </div>
            </details>
          ))}
        </section>
      )}
      {review.refreshPaused && !review.stranded && (
        <div className="aside" role="status">
          Live updates paused because the host did not answer. Resolve any
          pending approval before retrying.{" "}
          <button type="button" className="link" onClick={review.resumeRefresh}>
            Retry live updates
          </button>
        </div>
      )}
      {review.stranded && (
        <p className="aside">
          This host does not let the card update, so it shows the review as it
          was when it was drawn.{" "}
          <button type="button" className="link" onClick={review.redraw}>
            Draw it again
          </button>
        </p>
      )}
      {review.link !== null && (
        <p className="aside">
          Open the inbox in a browser:{" "}
          <a href={review.link} target="_blank" rel="noreferrer">
            {review.link}
          </a>
        </p>
      )}
      {review.failed !== null && (
        <p className="failed" role="alert">
          Not saved: {review.failed}
        </p>
      )}
      {shown ? (
        <One
          status={status}
          finding={shown}
          review={review}
          boxRef={box}
          onShow={(id) => {
            if (id !== null) setCursor(id);
            setOpen(id);
          }}
        />
      ) : (
        findings.length > 0 && (
          <>
            <div className="queue">
              {findings.map((each) => (
                <Row
                  key={each.id}
                  finding={each}
                  at={each.id === here?.id}
                  fresh={fresh(each.id)}
                  onOpen={() => {
                    setCursor(each.id);
                    setOpen(each.id);
                  }}
                />
              ))}
            </div>
            <footer className="foot">
              <span className="keys grow text-muted">
                <span>
                  <Key>↑</Key> <Key>↓</Key> move
                </span>
                <span>
                  <Key>←</Key> <Key>→</Key> rate
                </span>
                <span>
                  <Key>↵</Key> read
                </span>
                <span>
                  <Key>N</Key> note
                </span>
              </span>
              <FixButton accepted={accepted} review={review} />
            </footer>
          </>
        )
      )}
    </div>
  );
}
