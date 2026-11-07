/**
 * The system map, drawn.
 *
 * Nearly every Level 2 document ends in one `mermaid` fence: the executors,
 * the trust boundary, who owns which state. It is the most reusable thing
 * that level produces and the one thing in a review that is worth looking at
 * rather than reading — and until this existed the page printed it as source,
 * which asks the reader to run the layout in their own head.
 *
 * mermaid is three megabytes and it is imported here, dynamically, rather
 * than at the top of the page. Be honest about what that buys: the triage
 * page is built as one self-contained file, so the chunk is inlined with
 * everything else and the page is four megabytes rather than six hundred
 * kilobytes either way. What the import defers is the work — nothing is
 * drawn, and no diagram is laid out, until a document with one is open.
 *
 * It stays on this page. The report is a file somebody is emailed, six to
 * thirteen kilobytes of markup with no React behind it, and a drawing library
 * in there would be the whole of the download. A map in a report is still the
 * fence it was written as, which is why the renderer asks the surface rather
 * than reaching for this itself.
 *
 * A diagram that will not parse is not an error state worth a red box. The
 * fence is real content either way, so it comes back as the source it was,
 * with what mermaid made of it underneath.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** mermaid wants an id per drawing; it mounts a temporary element under it. */
let drawings = 0;

/**
 * How far a map may be shrunk to fit and still be worth looking at. Below
 * this the labels stop being words.
 */
const READABLE = 0.6;

/** The padding the drawing sits in, which is not room for the drawing. */
const PADDING = 12;

/**
 * The page's palette, as the handful of names mermaid asks for.
 *
 * Read off the document rather than written here, because these values flip
 * with the theme and a second copy of them would be a second thing to keep in
 * step. Only the plain tokens: the ones stated as a `color-mix` are a formula
 * the stylesheet resolves, and mermaid puts what it is given into an SVG
 * attribute, where a formula is not a colour.
 */
function palette(): Record<string, string> {
  const page = getComputedStyle(document.documentElement);
  const token = (name: string) => page.getPropertyValue(name).trim();
  const body = getComputedStyle(document.body);
  return {
    background: token("--bg"),
    // A node is a card on the page, and reads as one.
    mainBkg: token("--card"),
    primaryColor: token("--card"),
    primaryTextColor: token("--fg"),
    primaryBorderColor: token("--muted"),
    secondaryColor: token("--at"),
    tertiaryColor: token("--bg"),
    // The boxes a subgraph draws sit under the nodes, so they are the page a
    // shade off rather than a fill of their own.
    clusterBkg: token("--bg"),
    clusterBorder: token("--line"),
    lineColor: token("--muted"),
    textColor: token("--fg"),
    titleColor: token("--fg"),
    // An edge label lies on top of its edge and has to hide the line under it.
    edgeLabelBackground: token("--bg"),
    fontFamily: body.fontFamily,
    fontSize: "13px",
  };
}

/**
 * A number that changes whenever the theme does.
 *
 * The colours reach mermaid as values, not as variables, so a drawing made in
 * light stays light after the page is switched. Both ways of switching count:
 * the machine changing its mind, and this page being told.
 */
function useThemeEpoch(): number {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const bump = () => {
      setEpoch((was) => was + 1);
    };
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    system.addEventListener("change", bump);
    const told = new MutationObserver(bump);
    told.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    return () => {
      system.removeEventListener("change", bump);
      told.disconnect();
    };
  }, []);
  return epoch;
}

/**
 * What mermaid said, with the litany taken out.
 *
 * A parse error arrives as the line, the text around it, a caret under the
 * character, and then thirty token names it would have accepted there. The
 * first three are how the diagram gets fixed; the list is grammar internals,
 * and it is longer than everything useful put together.
 */
function plainly(message: string): string {
  return message.replace(/Expecting .*?got /s, "got ");
}

/**
 * One fenced diagram, drawn if mermaid can and printed if it cannot.
 *
 * `source` is the fence as the markdown renderer would have printed it,
 * handed in rather than built again here: it is what stands in while mermaid
 * loads, and what the reader is left with when the diagram will not parse.
 */
export function Diagram({ code, source }: { code: string; source: ReactNode }) {
  const epoch = useThemeEpoch();
  const [svg, setSvg] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  /** Fit to the panel to see the shape; full size to read the labels. */
  const [fitted, setFitted] = useState(true);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          // The document was written by the review that ran here, but a label
          // is still text from a diff, and there is no reason for any of it
          // to arrive as markup.
          securityLevel: "strict",
          // mermaid's own answer to a bad diagram is to draw a bomb into the
          // page it was asked about. This page has a better one below.
          suppressErrorRendering: true,
          theme: "base",
          themeVariables: palette(),
          // Labels as SVG text, so a `<br/>` in one is a line break and
          // nothing else in one is anything at all. useMaxWidth would hand
          // back a drawing that is always exactly as wide as the panel, which
          // is the decision the toggle below exists to leave to the reader.
          flowchart: { htmlLabels: false, useMaxWidth: false },
          sequence: { useMaxWidth: false },
        });
        drawings += 1;
        const drawn = await mermaid.render(`map-${String(drawings)}`, code);
        if (!live) return;
        setSvg(drawn.svg);
        setRefused(null);
      } catch (trouble) {
        if (!live) return;
        setRefused(
          trouble instanceof Error ? trouble.message : "mermaid refused it",
        );
      }
    })();
    return () => {
      live = false;
    };
  }, [code, epoch]);

  /**
   * Fitted, unless fitting it is the same as not showing it.
   *
   * A map of six boxes fits a panel and reads perfectly; the ones that come
   * out of a real Level 2 are three thousand pixels wide, and squeezed into
   * a panel their labels are four pixels tall — a picture of a diagram
   * rather than a diagram. Past a point, then, the useful first sight is the
   * left-hand end at full size with the rest a scroll away, and the toggle
   * is there for whichever of the two this guessed wrong.
   */
  useLayoutEffect(() => {
    const held = frame.current;
    const drawn = held?.querySelector("svg");
    if (!held || !drawn) return;
    const wide = Number(drawn.getAttribute("width") ?? "");
    const room = held.clientWidth - PADDING * 2;
    if (!wide || room <= 0) return;
    setFitted(room / wide >= READABLE);
  }, [svg]);

  if (refused !== null) {
    return (
      <figure className="my-2">
        {source}
        {/*
          All of what mermaid said, not the first line of it. The reader of a
          review is often the one who can fix the diagram, and the caret line
          under the offending text is the whole of the fix — "line 7" on its
          own sends them counting lines in a fence that has no numbers.
        */}
        <figcaption className="mt-1 text-[0.7rem] text-muted">
          Not drawn.
          <pre className="mt-1 font-mono text-[0.7rem] whitespace-pre-wrap">
            {plainly(refused)}
          </pre>
        </figcaption>
      </figure>
    );
  }

  // Before mermaid has answered, the fence is still what the document says.
  if (svg === null) return <>{source}</>;

  return (
    <figure className="my-2 rounded-md border border-line bg-card">
      <div
        ref={frame}
        // Tall maps are as common as wide ones, and a thousand pixels of
        // diagram between the heading and the prose under it means scrolling
        // past the picture to find out what it was about. Its own window,
        // then, rather than a mile of page.
        className={`max-h-[70vh] overflow-auto p-3 ${fitted ? "[&_svg]:h-auto [&_svg]:max-w-full" : "[&_svg]:max-w-none"}`}
        // mermaid's own output, and it sanitises what it puts in there.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <button
        type="button"
        onClick={() => {
          setFitted((was) => !was);
        }}
        title={
          fitted
            ? "Draw it at its own size — a dense map is unreadable squeezed into the panel"
            : "Fit it to the panel"
        }
        className="w-full border-t border-line px-3 py-1 text-right text-[0.65rem] tracking-wider text-muted uppercase transition-colors hover:text-hitline"
      >
        {fitted ? "Full size" : "Fit"}
      </button>
    </figure>
  );
}
