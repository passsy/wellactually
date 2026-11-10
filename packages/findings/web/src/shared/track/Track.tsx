/**
 * The track: a slider that can only rest in one of its stops.
 *
 * Modelled on the physical thing, because that is what makes it read without
 * a legend. A board with holes bored through it, each hole engraved with what
 * it means. A slit runs the length of the board and joins every hole. Riding
 * in the slit is a pin whose head is wider than the slit and narrower than a
 * hole: it cannot come out, it cannot rest between two holes, and wherever it
 * has dropped in is the answer. The head carries the icon of the hole it is
 * sitting in, so the state can be read off the moving part alone.
 *
 * That shape is the argument for the control. Radio buttons say "pick one of
 * five" and stop there; this says "these five are in an order, you are here,
 * and the way to somewhere else is to slide".
 *
 * Nothing here knows what a finding is. It is given stops, told which one is
 * current, and calls back with the one that was chosen.
 *
 * Most of what this replaced was bookkeeping that no longer has anything to
 * do. The old track was markup rewritten on every repaint, so its head was a
 * new element each time, starting at the left end of the board — which is why
 * one press animated three times, and why there was a module-level map
 * remembering where each head had got to so its replacement could carry on.
 * A component that stays mounted keeps its head, and the browser finishes the
 * transition it started. What is left is the one case that is genuinely a
 * different question: a track that has been handed a different finding places
 * its head rather than sliding it across from the last one's answer.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import "./track.css";

export interface TrackStop {
  /** The value handed back when this stop is chosen. */
  to: string;
  /**
   * Engraved in the hole, and carried by the head while it sits there.
   *
   * A node rather than a character, because not every mark can be typed: the
   * one that has to be a flag has no glyph that is both stroked like the rest
   * of them and the same shape on every machine, so it is drawn.
   */
  mark: ReactNode;
  /** The hole's tooltip: what being here means. */
  says: string;
  /**
   * Tone this stop lends the head, as a CSS colour or variable. Only the head
   * spends it: five coloured holes is five things to read where the position
   * has already said it.
   */
  tone?: string;
}

export interface TrackFlag {
  index: number;
  mark: ReactNode;
  says: string;
}

export interface TrackProps {
  stops: TrackStop[];
  /** The hole the head is in. */
  at: number;
  onPick: (to: string) => void;
  /**
   * What this track is currently showing. When it changes, the head is placed
   * rather than slid: the new value is a different question, not an answer
   * moving.
   */
  owner?: string | undefined;
  /**
   * One hole marked as saying something the position cannot: a finding that
   * was resolved and came back is not at a stop of its own, it is back down
   * the track, and the hole it climbed to is the only thing left that can say
   * it was ever there.
   */
  flag?: TrackFlag | undefined;
  /**
   * A run of plain board after each stop named. The slit still crosses it and
   * the head still slides over it, but there is nothing to drop into, which is
   * how a board separates one part of a track from the next without adding
   * anything to read.
   */
  blankAfter?: number[] | undefined;
  label?: string | undefined;
}

interface Drag {
  from: number;
  startX: number;
  moved: boolean;
  /** The hole the head is currently over, and would drop into. */
  over: number;
}

export function Track({
  stops,
  at,
  onPick,
  owner,
  flag,
  blankAfter,
  label = "Where this finding stands",
}: TrackProps) {
  const board = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLSpanElement>(null);
  const sign = useRef<HTMLSpanElement>(null);
  const holes = useRef<(HTMLButtonElement | null)[]>([]);
  const [drag, setDrag] = useState<Drag | null>(null);
  /** Which stop is being named right now, and where to hang the name. */
  const [hint, setHint] = useState<{ at: number; x: number } | null>(null);
  const lastOwner = useRef(owner);
  /** The board width the head was last measured against. */
  const wide = useRef(0);

  /**
   * Where the head is right now, mid-slide included.
   *
   * Read off the matrix rather than off what was last written, so a head
   * grabbed halfway through a slide carries on from where it visibly is
   * rather than jumping to where it was going.
   */
  const xNow = useCallback((): number => {
    if (!head.current) return 0;
    const { transform } = getComputedStyle(head.current);
    if (transform === "none") return 0;
    return new DOMMatrixReadOnly(transform).m41;
  }, []);

  /**
   * The x a head must sit at to be centred in a hole.
   *
   * Measured off rectangles rather than off `offsetLeft`, which is rounded to
   * a whole pixel. The board's padding is 0.3rem, so every hole's true offset
   * ends in .8 and every head was seated a fifth of a pixel to the right of
   * the hole it was in — which is nothing on its own, and is a visibly fatter
   * gap on one side than the other once the two circles are 4px apart.
   *
   * In the same frame of reference the head is positioned in: `left: 0` is the
   * left edge of the board's padding box, which is its border box inset by
   * whatever border it has.
   */
  const centreOf = useCallback((index: number): number | null => {
    const hole = holes.current[index];
    if (!hole || !head.current || !board.current) return null;
    const from =
      board.current.getBoundingClientRect().left +
      parseFloat(getComputedStyle(board.current).borderLeftWidth);
    const box = hole.getBoundingClientRect();
    return (
      box.left -
      from +
      (box.width - head.current.getBoundingClientRect().width) / 2
    );
  }, []);

  /**
   * The middle of a hole, for hanging its name over.
   *
   * Read off `offsetLeft` rather than off rectangles, unlike `centreOf`: this
   * positions a label a reader glances at, not a pin that has to land in a
   * hole, and a fifth of a pixel is not visible on a word.
   */
  const centreX = useCallback((index: number): number => {
    const hole = holes.current[index];
    return hole ? hole.offsetLeft + hole.offsetWidth / 2 : 0;
  }, []);

  /** The hole whose centre is nearest an x within the board. */
  const nearest = useCallback((x: number): number => {
    let best = 0;
    let gap = Infinity;
    for (const [index, hole] of holes.current.entries()) {
      if (!hole) continue;
      const distance = Math.abs(hole.offsetLeft + hole.offsetWidth / 2 - x);
      if (distance < gap) {
        gap = distance;
        best = index;
      }
    }
    return best;
  }, []);

  /**
   * Puts the head at an x, sliding there or arriving there.
   *
   * The transform is written rather than a custom property the transform
   * reads. An unregistered custom property is not a value the engine
   * interpolates, and changing one does not start a transition on the
   * property that substitutes it: `--x` went from one number to the next in a
   * single frame and the head teleported, with `transition-duration` sitting
   * there reading 0.26s the whole time.
   */
  const place = useCallback((x: number, animated: boolean) => {
    if (!head.current || !board.current) return;
    if (!animated) {
      board.current.classList.add("nofx");
      head.current.style.transform = `translate(${x}px, -50%)`;
      // Read something back, so the position without the transition is a
      // style the browser has settled on before transitions are allowed again.
      void head.current.offsetWidth;
      board.current.classList.remove("nofx");
      return;
    }
    head.current.style.transform = `translate(${x}px, -50%)`;
  }, []);

  /**
   * Seats the head over the hole the track says it is in.
   *
   * Not while it is being dragged: the finger owns the position then, and this
   * would fight it every frame.
   */
  useLayoutEffect(() => {
    if (drag) return;
    const to = centreOf(at);
    if (to === null) return;
    const placed = lastOwner.current !== owner;
    lastOwner.current = owner;
    place(to, !placed);
  }, [at, owner, drag, centreOf, place]);

  /**
   * Keeps the hint readable when the stop it names sits near an edge.
   *
   * The label is centred over its hole, and a board sits flush against the
   * edges of whatever pane holds it — so the name of the last stop ran off
   * the window, and the long name of a left-hand stop ran under the detail
   * pane's scrollport, which clips what the window would still have shown.
   * The window is only one of the edges that matter: every ancestor that
   * clips overflow is another, so the hint is fenced into the intersection
   * of all of them. Written straight to the element rather than held in
   * state: it is a correction to where something already is, measured after
   * the layout that needs correcting, and a render to carry it would be a
   * render that changes nothing else.
   */
  useLayoutEffect(() => {
    const element = sign.current;
    if (!element) return;
    const edge = 8;
    element.style.setProperty("--nudge", "0px");
    const box = element.getBoundingClientRect();
    let left = edge;
    let right = window.innerWidth - edge;
    for (let up = board.current?.parentElement; up; up = up.parentElement) {
      if (getComputedStyle(up).overflowX === "visible") continue;
      const clip = up.getBoundingClientRect();
      left = Math.max(left, clip.left + edge);
      right = Math.min(right, clip.right - edge);
    }
    const over = box.right - right;
    const under = left - box.left;
    element.style.setProperty(
      "--nudge",
      over > 0
        ? `${String(-over)}px`
        : under > 0
          ? `${String(under)}px`
          : "0px",
    );
  });

  /**
   * The board reflows with the pane it is in, and a head measured against the
   * old width sits between two holes until something else redraws it.
   *
   * Only when the width genuinely changed. A ResizeObserver on the board also
   * fires for changes inside it, and moving the head moves the `at` class from
   * one hole to another, which was enough: the observer re-placed the head
   * without a transition a frame after the slide started, so every move
   * arrived instantly and the animation was never seen.
   */
  useEffect(() => {
    const element = board.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      if (width === wide.current) return;
      wide.current = width;
      const to = centreOf(at);
      if (to !== null) place(to, false);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [at, centreOf, place]);

  /**
   * Says what a stop means, over the stop it means it about.
   *
   * Measured at the moment it is asked for. The board reflows with the pane
   * and the answer is only wanted while a pointer is resting on it, so there
   * is nothing here to keep in step with anything.
   */
  const name = useCallback(
    (index: number) => {
      setHint({ at: index, x: centreX(index) });
    },
    [centreX],
  );

  function grab(event: React.PointerEvent<HTMLSpanElement>) {
    if (!head.current) return;
    event.preventDefault();
    head.current.setPointerCapture(event.pointerId);
    setDrag({
      from: xNow(),
      startX: event.clientX,
      moved: false,
      over: at,
    });
    name(at);
  }

  function move(event: React.PointerEvent<HTMLSpanElement>) {
    if (!drag || !head.current) return;
    const first = centreOf(0);
    const last = centreOf(stops.length - 1);
    if (first === null || last === null) return;
    // Clamped to the two end holes: the head is captive in the slit, and a
    // control that can be dragged somewhere it cannot stay is a control that
    // lies about what it will do.
    const x = Math.min(
      last,
      Math.max(first, drag.from + (event.clientX - drag.startX)),
    );
    head.current.style.transform = `translate(${x}px, -50%)`;
    const over = nearest(x + head.current.offsetWidth / 2);
    // The head wears the tone and the mark of the hole it is over. This is
    // the same fact in words, which is the half a mark cannot carry.
    if (over !== drag.over || !hint) name(over);
    setDrag({
      ...drag,
      moved: drag.moved || Math.abs(event.clientX - drag.startX) > 2,
      over,
    });
  }

  function release() {
    if (!drag) return;
    // Never left between two holes, whatever happened to the pointer: it drops
    // into the nearest one, and into the one it started in when nothing moved.
    const into = drag.moved ? drag.over : at;
    const to = centreOf(into);
    // Into the hole it fell in, from wherever the finger let go, with the
    // transition on: the last few pixels are the drop.
    if (to !== null) place(to, true);
    // The finger is still on the head, which is now in a different hole, so
    // the hint answers for that one rather than going out under the cursor.
    name(into);
    setDrag(null);
    if (drag.moved && stops[into]) onPick(stops[into].to);
  }

  // While the head is dragged it wears whatever hole it is over, because that
  // is where it will drop. The board is not touched: the hole it came from
  // stays open until something is actually chosen.
  const worn = stops[drag ? drag.over : at];

  // A drag owns the hint outright: the pointer has been captured by the head,
  // so hovering has stopped happening and what is "under the cursor" is
  // whatever the head would drop into.
  const shown = drag ? drag.over : (hint?.at ?? null);

  return (
    <div
      ref={board}
      className={`track${drag ? " dragging" : ""}`}
      role="radiogroup"
      aria-label={label}
    >
      <span className="slit" aria-hidden="true" />
      {/*
        What the stop under the cursor means, in words, hung over it.
        Out of the accessibility tree: every hole carries the same sentence as
        its name, so a screen reader has already been told.
      */}
      {shown !== null && (
        <span
          ref={sign}
          className="hint"
          aria-hidden="true"
          style={{ left: `${String(hint?.x ?? 0)}px` }}
        >
          {flag?.index === shown ? flag.says : (stops[shown]?.says ?? "")}
        </span>
      )}
      {stops.map((stop, index) => {
        const flagged = flag?.index === index;
        return (
          <span key={stop.to} className="contents">
            <button
              type="button"
              ref={(element) => {
                holes.current[index] = element;
              }}
              className={`hole${index === at ? " at" : ""}${
                flagged ? " flagged" : ""
              }`}
              role="radio"
              aria-checked={index === at}
              // The name, not a tooltip: the board draws its own, and a
              // `title` beside it is the platform's grey box arriving a
              // second later to say the same thing in a different voice.
              aria-label={flagged ? flag.says : stop.says}
              onPointerEnter={() => {
                if (!drag) name(index);
              }}
              onPointerLeave={() => {
                if (!drag) setHint(null);
              }}
              {...(stop.tone
                ? { style: { "--tone": stop.tone } as React.CSSProperties }
                : {})}
              // A hole is a place the head can go, so pressing one sends it
              // there. Reading a track is most of what it is for, so pressing
              // the hole it is already in is deliberately nothing.
              onClick={() => {
                if (index !== at) onPick(stop.to);
              }}
            >
              <span className="engraved">
                {flagged ? flag.mark : stop.mark}
              </span>
            </button>
            {blankAfter?.includes(index) && (
              <span className="blank" aria-hidden="true" />
            )}
          </span>
        );
      })}
      {/*
        Out of the accessibility tree: the holes are the controls and each says
        whether it is the checked one. The head is the same fact drawn again.
      */}
      <span
        ref={head}
        className="head"
        aria-hidden="true"
        onPointerDown={grab}
        onPointerMove={move}
        onPointerUp={release}
        onPointerCancel={release}
        // The head covers the hole it is in, so without this the one stop a
        // reader cannot get a word out of is the one they are on.
        onPointerEnter={() => {
          if (!drag) name(at);
        }}
        onPointerLeave={() => {
          if (!drag) setHint(null);
        }}
        {...(worn?.tone
          ? { style: { "--tone": worn.tone } as React.CSSProperties }
          : {})}
      >
        {/* The same wrapper the holes give their marks, so the one nudge that
            seats a mark optically in a round opening is written once. */}
        <span className="engraved">{worn?.mark}</span>
      </span>
    </div>
  );
}
