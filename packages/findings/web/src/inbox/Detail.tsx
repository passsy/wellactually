/**
 * One finding, read.
 *
 * The track is drawn twice on purpose: once above the body, because the
 * answer is often obvious from the title and the cursor is already up there
 * when it is, and once under the note, where a verdict is given at the end of
 * reading. Both are the same props, so neither can show a state the other
 * does not.
 */

import { Markdown, MarkdownSurface } from "../shared/markdown/Markdown.tsx";
import { Diagram } from "./Diagram.tsx";
import { Track } from "../shared/track/Track.tsx";
import { BLANK_AFTER, flagFor, stopOf, stopsFor } from "../shared/stage.tsx";
import { Evidence, Priority, Rule, State, Tag } from "../shared/chips.tsx";
import { VerificationNotice } from "../shared/VerificationNotice.tsx";
import { Chunks } from "../shared/chunk/Chunk.tsx";
import { AUTHORSHIP_SAYS, type Finding } from "../shared/domain.ts";
import type { PanelAt } from "./FilePanel.tsx";
import { when } from "./when.ts";

/**
 * Who reported this, when it was not the review itself.
 *
 * A finding raised by a human reading the pull request is a different kind of
 * claim from one a review run produced, and the queue is worked by someone
 * who wants to know which they are looking at. The usual case says nothing,
 * because "the review found it" is what every other row already means.
 */
function Reporter({ finding }: { finding: Finding }) {
  if (!finding.reporter || finding.reporter === "review") return null;
  const who =
    finding.reporter === "pr-comment"
      ? `@${finding.reporterName ?? "someone"}`
      : (finding.reporterName ?? "you");
  return <Tag title="Who reported this">{who}</Tag>;
}

/**
 * That the author has been told, and where, when there is a where.
 *
 * Only some reports leave an address behind, so the tag says the fact and
 * links the address when one exists rather than making the address the fact.
 */
function Posted({ finding }: { finding: Finding }) {
  if (!finding.reportedAt) return null;
  const when = `Reported ${finding.reportedAt.slice(0, 10)}`;
  const url = finding.links.prComment;
  if (!url) return <State title={when}>↗ reported</State>;
  // `inline-flex`, so the chip is what the row lines up and not the line box
  // of the link around it. Left inline the anchor was 23px tall against the
  // chip's 20px, and centring the row put this one chip 1.6px below its
  // neighbours — the only pill in the row wearing a link, and the only one
  // out of line.
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener"
      title={`${when} · ${url}`}
      className="inline-flex"
    >
      <State>↗ reported</State>
    </a>
  );
}

/**
 * Where the finding was reported, as an address you can open.
 *
 * The tag above says the author has been told; this says where, which is what
 * a reader wants a week later when they need to know what was already said and
 * what came back.
 *
 * Only when there is a where. Most findings are marked reported from the track
 * and carry no address, and a line reading "no address recorded" is a row of
 * the page spent saying that the tag beside it is the whole story — inserted
 * the moment the track is moved, so the body under it jumps. The date it also
 * carried is on the tag.
 */
function Reported({ finding }: { finding: Finding }) {
  const url = finding.links.prComment;
  if (!finding.reportedAt || !url) return null;
  return (
    <p className="my-[0.8rem] text-[0.8rem] text-muted">
      Reported {finding.reportedAt.slice(0, 10)} at{" "}
      <a
        href={url}
        target="_blank"
        rel="noopener"
        className="text-todo underline underline-offset-2"
      >
        {url}
      </a>
    </p>
  );
}

/**
 * What has happened to this finding, oldest first.
 *
 * Two axes move independently, so an entry names the one it moved rather than
 * describing a single state that never existed. An entry that rewrote the
 * finding says so too: text changed after a human ruled on it means the
 * verdict was given to something else, and the only place that is visible is
 * here.
 */
function History({ finding }: { finding: Finding }) {
  if (finding.history.length === 0) return null;
  return (
    <ol className="mt-6 border-t border-line pt-2 text-[0.8rem] text-muted">
      {finding.history.map((entry, index) => {
        const what = entry.edited
          ? `rewrote ${entry.edited.join(", ")}`
          : (entry.verdict ??
            entry.resolution ??
            // A reason with no verdict is the why arriving after the throw.
            (entry.reason ? "why" : ""));
        return (
          <li key={`${entry.at} ${index}`}>
            <span className="font-mono" title={entry.at}>
              {when(entry.at)}
            </span>{" "}
            · {entry.actor} → {what}
            {entry.reason ? ` (${entry.reason})` : ""}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The rule chip with its id narrowed: inside here `rule` is a string, so
 * opening it needs no cast and cannot drift from the guard above.
 */
function RuleChip({
  rule,
  onOpenRule,
}: {
  rule: string;
  onOpenRule: (id: string) => void;
}) {
  return (
    <Rule
      id={rule}
      onPick={() => {
        onOpenRule(rule);
      }}
    />
  );
}

export function FindingTrack({
  finding,
  onMove,
}: {
  finding: Finding;
  onMove: (to: string) => void;
}) {
  return (
    <Track
      stops={stopsFor(finding)}
      at={stopOf(finding)}
      flag={flagFor(finding)}
      blankAfter={BLANK_AFTER}
      owner={finding.id}
      onPick={onMove}
    />
  );
}

/**
 * What an invalid verdict still owes, or the proof it was paid.
 *
 * Marking a finding invalid is a claim against the review, and the claim is
 * worth nothing on this machine: it becomes calibration the moment it is
 * filed as an issue on the handbook. So an invalid finding without one says
 * so where the verdict was given, and one with it links the receipt. Filing
 * happens through report_finding — a human has to read the scrubbed body
 * before it goes out, which is not a browser interaction — so the line asks
 * rather than offering a button that could not keep the promise.
 */
function RuleIssue({ finding }: { finding: Finding }) {
  if (finding.verdict !== "invalid") return null;
  const url = finding.links.ruleIssue;
  if (!url) {
    return (
      <p className="mt-[0.6rem] text-[0.8rem] text-drop">
        Owes the handbook an issue — file it with report_finding.
      </p>
    );
  }
  return (
    <p className="mt-[0.6rem] text-[0.8rem] text-muted">
      Reported to the handbook at{" "}
      <a
        href={url}
        target="_blank"
        rel="noopener"
        className="underline underline-offset-2"
      >
        {url}
      </a>
    </p>
  );
}

export function Detail({
  finding,
  onMove,
  onOpenFile,
  onOpenRule,
  onTag,
  tag,
}: {
  finding: Finding;
  onMove: (to: string) => void;
  onOpenFile: (at: PanelAt) => void;
  onOpenRule: (id: string) => void;
  /** The same hold the queue's tags offer: one control, both places. */
  onTag: (tag: string) => void;
  /** The tag the queue is held to, so that chip can wear its on state. */
  tag: string | null;
}) {
  /*
   * A file path is one word to a line breaker, and the words on this page are
   * mostly paths: an anchor, a failing test, a chunk head. Left to normal
   * wrapping they hang off the column's right edge, which the column clips and
   * offers no way to scroll to. `anywhere` rather than `break-word` because it
   * is the one that also shrinks the min-content width, and the rows here are
   * flex — a path that cannot be measured smaller pushes its row wide however
   * it wraps. Prose is untouched: an ordinary word only breaks when the line
   * cannot hold it either way, and `pre` opts out of overflow wrapping
   * entirely, so source keeps scrolling in its own frame.
   */
  return (
    <article className="p-5 wrap-anywhere">
      <h1 className="mb-[0.6rem] text-[1.15rem] font-semibold">
        <span className="font-mono text-muted">{finding.id}</span>
        <span className="text-muted"> — </span>
        {finding.title}
      </h1>

      <VerificationNotice finding={finding} />
      <p className="mb-4 flex flex-wrap items-center gap-[0.4rem] text-muted">
        <Priority of={finding.priority} />
        <Evidence of={finding.evidence} />
        {(finding.tags ?? []).map((one) => (
          <Tag
            key={one}
            on={one === tag}
            onPick={() => {
              onTag(one);
            }}
          >
            {one}
          </Tag>
        ))}
        {finding.rule !== undefined && finding.rule !== "" && (
          <RuleChip rule={finding.rule} onOpenRule={onOpenRule} />
        )}
        <Reporter finding={finding} />
        <Posted finding={finding} />
        {/*
          No chip for the verdict or the resolution: the track below is the
          same facts as a control, and saying them twice on one screen makes
          the reader check whether the two agree. The one thing the track
          cannot say — that a later review run went looking and did not find
          it any more — keeps a chip, because that is a check, not a claim.
        */}
        {finding.confirmedAt && (
          <State
            title={`Confirmed by a later review run on ${finding.confirmedAt.slice(0, 10)}`}
          >
            {finding.resolution} ✓
          </State>
        )}
        {/* Pressable like every other place-in-the-code on this page. */}
        <button
          type="button"
          onClick={() => {
            onOpenFile({
              file: finding.anchor.file,
              line: finding.anchor.line,
              endLine: finding.anchor.endLine,
            });
          }}
          className="cursor-pointer font-mono text-[0.8rem] underline-offset-2 hover:underline"
          title="Open this file beside the finding"
        >
          {finding.anchor.file}:{finding.anchor.line}
          {(finding.anchor.endLine ?? finding.anchor.line) > finding.anchor.line
            ? `-${String(finding.anchor.endLine)}`
            : ""}
        </button>
      </p>

      {/*
        Under the labels rather than above the title: the labels say what this
        finding is, and the track is the answer to it. Above the title it was
        the first thing on the page, which is the one place the answer does
        not belong.
      */}
      <div className="mb-[1.1rem]">
        {/*
          The one thing on this page with a physical size. Its holes are cut to
          take a head and the head is cut to stay in the slit, so the board is
          as wide as it is however narrow the column gets — shrink it and it
          stops being a board with a piece in it. Narrower than the board, the
          board slides; the alternative was the column carrying the overrun,
          which put the last two stops past an edge with nothing to scroll.

          The headroom is not spacing. Asking for `overflow-x` gets `overflow-y`
          along with it — CSS will not clip one axis and leave the other
          visible — so this box clips the top of whatever it holds, and what
          sits above the board is the label naming the stop under the cursor.
          The padding is the room that label needs and the negative margin
          gives it straight back, which leaves the page where it was and the
          label inside the box rather than sawn off by it.

          That room lies over the tags above, so it lets the pointer through
          and the board takes it back. Otherwise the fix for a clipped label
          would be a strip of dead space across the row of tags, which is a
          worse bug than the one being fixed.
        */}
        <div className="pointer-events-none -mx-5 -mt-8 overflow-x-auto px-5 pt-8 pb-1">
          <div className="pointer-events-auto">
            <FindingTrack finding={finding} onMove={onMove} />
          </div>
        </div>
        <RuleIssue finding={finding} />
      </div>

      {/*
        The code moved out from under the finding since it was written, so the
        lines it quotes are not the lines that are there now. Not a verdict
        and not an error — a reason to look before ruling on it.
      */}
      {finding.staleAnchor && (
        <p className="my-[0.8rem] text-[0.8rem] text-drop">
          The code under this finding moved since it was written.
        </p>
      )}

      {/*
        The anchor lines are not the author's work, even though every diff
        view shows them as changed. The reader deciding whether this is a fair
        comment on the change needs that before the argument.
      */}
      {finding.authorship && AUTHORSHIP_SAYS[finding.authorship] && (
        <p className="my-[0.8rem] text-[0.8rem] text-drop">
          {AUTHORSHIP_SAYS[finding.authorship]}
        </p>
      )}

      {finding.provenTest && (
        <p className="my-[0.8rem] text-[0.8rem] text-muted">
          Failing test:{" "}
          {/*
            The same affordance as the chunk header: a place in the code
            opens beside the finding. Two paths on one page, one pressable
            and one inert, teaches the reader that paths here do nothing.
          */}
          <button
            type="button"
            onClick={() => {
              const test = /^(.*?):(\d+)$/.exec(finding.provenTest ?? "");
              onOpenFile(
                test?.[1] !== undefined && test[2] !== undefined
                  ? { file: test[1], line: Number(test[2]) }
                  : { file: finding.provenTest ?? "", line: 1 },
              );
            }}
            className="cursor-pointer font-mono underline-offset-2 hover:underline"
            title="Open this test beside the finding"
          >
            {finding.provenTest}
          </button>
        </p>
      )}

      <Reported finding={finding} />

      {/*
        A measure, not a column: on a wide window the prose was running the
        full pane and the eye lost the line on the way back. The code blocks
        below stay full width — code does not rewrap.
      */}
      <div className="mt-4 max-w-[600px] text-[0.95rem]">
        <MarkdownSurface
          surface={{
            // In the page there is a panel to open it in, so a citation does
            // not have to leave. The report has no panel and opens a tab.
            rule: (id) => ({
              href: `/rule/${id}`,
              onPick: () => {
                onOpenRule(id);
              },
            }),
            // A finding that argues about where something belongs sometimes
            // carries its own small map. Same fence, same drawing.
            draw: (language, code, source) =>
              language === "mermaid" ? (
                <Diagram code={code} source={source} />
              ) : null,
          }}
        >
          <Markdown body={finding.body} />
        </MarkdownSurface>
      </div>

      {/*
        What the reviewer was looking at. A finding carries its own source
        because line numbers drift and a reader coming back next week needs
        to see what was seen, not what the file says by then.
      */}
      <Chunks
        anchor={{
          file: finding.anchor.file,
          line: finding.anchor.line,
          endLine: finding.anchor.endLine,
          context: finding.context,
          diff: finding.diff,
        }}
        related={finding.related}
        onOpen={onOpenFile}
        withDiff={false}
      />

      <History finding={finding} />
    </article>
  );
}
