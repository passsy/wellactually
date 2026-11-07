import { Maximize2, Minimize2, LoaderCircle } from "lucide-react";
import { Button } from "../components/ui/button.tsx";
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

import { ruleUrl } from "../shared/rule-url.ts";
import { Occurrences, FindingInformation } from "../shared/Occurrences.tsx";
import {
  Fragment,
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
import type { Host, DisplayState } from "./bridge.ts";
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
type Issue = Finding;

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

function DisplayButton({ host }: { host: Host }) {
  const [display, setDisplay] = useState<DisplayState>({
    mode: "inline",
    ready: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => host.onDisplayState?.(setDisplay), [host]);
  if (!host.requestDisplayMode || !host.onDisplayState) return null;
  const full = display.mode === "fullscreen";
  const target = full ? "inline" : "fullscreen";
  const unsupported =
    display.availableModes && !display.availableModes.includes(target);
  return (
    <div className="display-control">
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-7 w-7"
        aria-label={full ? "Restore inline review" : "Maximize review"}
        title={
          unsupported
            ? `This harness does not support ${target} mode`
            : full
              ? "Restore inline review"
              : "Maximize review"
        }
        disabled={busy || !display.ready || Boolean(unsupported)}
        onClick={() => {
          setBusy(true);
          setError(null);
          void host.requestDisplayMode!(target)
            .then((mode) => {
              if (mode !== target)
                setError(`The harness kept the review in ${mode} mode.`);
            })
            .catch((why: unknown) =>
              setError(why instanceof Error ? why.message : String(why)),
            )
            .finally(() => setBusy(false));
        }}
      >
        {busy ? (
          <LoaderCircle className="animate-spin" aria-hidden="true" />
        ) : full ? (
          <Minimize2 aria-hidden="true" />
        ) : (
          <Maximize2 aria-hidden="true" />
        )}
      </Button>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}

function Header({
  status,
  review,
  host,
}: {
  status: ReviewStatus;
  review: Review;
  host: Host;
}) {
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
      <DisplayButton host={host} />
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
            : status.phase === "verification"
              ? "Verifying findings"
              : status.phase === "review"
                ? "Reviewing changes"
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
  finding: Issue;
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
      {<Stage finding={finding} />}
      <Priority of={finding.priority} />
      <span className="id font-mono" title={finding.id}>
        {finding.id}
      </span>
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
        {!status.readOnly && <PostButton
          key={finding.id}
          finding={finding}
          status={status}
          review={review}
        />}
        {!status.readOnly && <>
          <PostAcceptedButton key={accepted.map(f=>f.id).join(",")} accepted={accepted} status={status} review={review} />
          <FixButton accepted={accepted} review={review} />
        </>}
      </div>
      <div className="one">
        <div className="facts">
          <Priority of={finding.priority} />
          <span className="font-mono font-semibold">{finding.id}</span>
          {(finding.tags ?? []).map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
          {!finding.record && <Evidence of={finding.evidence} />}
          {/*
            A rule id nobody could read was an id not worth printing: the
            chip said PW-G007 and the card had no way to say what PW-G007
            is. The server opens the page, the same way the Inbox button
            works, because it is on loopback and the host that draws the
            card opens https.
          */}
          {(
            finding.record?.rules ??
            (finding.rule ? [{ id: finding.rule }] : [])
          ).map((rule) => (
            <Rule
              key={rule.id}
              id={rule.id}
              href={ruleUrl(rule.id)}
              onPick={() => review.openRule(rule.id)}
            />
          ))}
          {/*
            On the line that says what the finding is, at its far end: the
            first thing in view, and no line of its own to pay for.
          */}
          {!status.readOnly && <span className="rate">
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
          </span>}
        </div>
        <h2>{finding.title}</h2>
        <div className="body">
          <Markdown body={finding.body} />
        </div>
        {finding.record ? (
          <>
            <FindingInformation record={finding.record} />
            <Occurrences
              key={finding.id}
              findingId={finding.id}
              summary={finding.occurrenceSummary}
              refreshKey={`${finding.record.updatedAt}:${finding.occurrenceSummary?.revisionKey}`}
              load={() => review.occurrences(finding.id)}
              save={status.readOnly ? undefined : review.saveOccurrence}
            />
          </>
        ) : (
          <Chunk
            at={{
              file: finding.anchor.file,
              line: finding.anchor.line,
              endLine: finding.anchor.endLine,
              context: finding.context,
            }}
            withDiff={false}
          />
        )}
        {/* Keyed by the finding, so a draft never follows the reader to the next one. */}
        {!status.readOnly && <NoteBox
          key={finding.id}
          finding={finding}
          review={review}
          boxRef={boxRef}
        />}
      </div>
    </>
  );
}

function PostButton({
  finding,
  status,
  review,
}: {
  finding: Finding;
  status: ReviewStatus;
  review: Review;
}) {
  const [state, setState] = useState<"ready" | "sending" | "sent">("ready");
  const [error, setError] = useState<string | null>(null);
  if (!status.pr?.number && !status.pr?.url) return null;
  if (finding.links.prComment)
    return (
      <a
        className="btn"
        href={finding.links.prComment}
        target="_blank"
        rel="noreferrer"
      >
        View PR comment ↗
      </a>
    );
  const eligible = finding.record
    ? finding.record.state === "open"
    : finding.resolution !== "resolved" &&
      (finding.verdict === "undecided" || finding.verdict === "accepted");
  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={!eligible || state !== "ready"}
        title="Ask the agent to post this finding as an inline PR comment"
        onClick={() => {
          setState("sending");
          setError(null);
          void review.post(finding).then(
            () => setState("sent"),
            (why: unknown) => {
              setState("ready");
              setError(why instanceof Error ? why.message : String(why));
            },
          );
        }}
      >
        {state === "sent"
          ? "Asked agent to post"
          : state === "sending"
            ? "Sending…"
            : "Post to PR"}
      </button>
      {error && <span role="alert">Could not ask the agent: {error}</span>}
    </>
  );
}

function PostAcceptedButton({accepted,status,review}: {accepted:Finding[];status:ReviewStatus;review:Review}) {
  const [state,setState]=useState<"ready"|"sending"|"sent">("ready");
  const [error,setError]=useState<string|null>(null);
  const pending=accepted.filter(f=>!f.links.prComment && !f.reportedAt && (!f.record || f.record.state==="open"));
  if ((!status.pr?.number && !status.pr?.url) || pending.length===0) return null;
  return <>
    <button type="button" className="btn" disabled={state!=="ready"}
      title="Ask the agent to post the accepted findings as inline PR comments"
      onClick={()=>{
        setState("sending");setError(null);
        void review.postAccepted(pending).then(()=>setState("sent"),(why:unknown)=>{
          setState("ready");setError(why instanceof Error?why.message:String(why));
        });
      }}>
      {state==="sent"?"Asked agent to post":state==="sending"?"Sending…":`Post ${pending.length} accepted`}
    </button>
    {error && <span role="alert">Could not ask the agent: {error}</span>}
  </>;
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
  const issues: Issue[] = findings;
  const here = issues.find((each) => each.id === cursor) ?? issues[0] ?? null;
  const shown =
    open === null ? null : (issues.find((each) => each.id === open) ?? null);

  // Which findings a reader who was already looking has not seen arrive.
  // The first draw is not news: a card opened halfway through a run would
  // otherwise announce everything found so far at once.
  const ids = issues.map((each) => each.id).join(" ");
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
      if (status?.readOnly && (key === "ArrowRight" || key === "ArrowLeft" || STOP_KEYS[key] !== undefined || key === "n")) return;
      const step = (by: number) => {
        const next = issues[issues.indexOf(here) + by];
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
      <Header status={status} review={review} host={host} />
      {status.readOnly && <div className="aside">Read-only · Decisions and notes are managed in the coding session.</div>}
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
        <div className="aside">
          Live updates stopped. The card shows its last saved snapshot.
          {review.refreshError && <span> Refresh request failed: {review.refreshError}. </span>}
          <button type="button" className="link" onClick={review.resumeRefresh}>Retry live updates</button>{" "}
          {host.connectionDetails && <details><summary>Connection details</summary><pre>{JSON.stringify(host.connectionDetails(), null, 2)}</pre></details>}
          <button type="button" className="link" onClick={review.redraw}>
            Draw it again
          </button>
        </div>
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
        issues.length > 0 && (
          <>
            <div className="queue">
              {issues.map((each) => (
                <Fragment key={each.id}>
                  <Row
                    finding={each}
                    at={each.id === here?.id}
                    fresh={fresh(each.id)}
                    onOpen={() => {
                      setCursor(each.id);
                      setOpen(each.id);
                    }}
                  />
                </Fragment>
              ))}
            </div>
            <footer className="foot">
              <span className="keys grow text-muted">
                <span>
                  <Key>↑</Key> <Key>↓</Key> move
                </span>
                {here && !status.readOnly && (
                  <span>
                    <Key>←</Key> <Key>→</Key> rate
                  </span>
                )}
                <span>
                  <Key>↵</Key> read
                </span>
                {here && !status.readOnly && (
                  <span>
                    <Key>N</Key> note
                  </span>
                )}
              </span>
              {!status.readOnly && <>
          <PostAcceptedButton key={accepted.map(f=>f.id).join(",")} accepted={accepted} status={status} review={review} />
          <FixButton accepted={accepted} review={review} />
        </>}
            </footer>
          </>
        )
      )}
    </div>
  );
}
