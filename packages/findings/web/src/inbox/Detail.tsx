import { useEffect, useRef, type ReactNode } from "react";
import { ruleUrl } from "../shared/rule-url.ts";
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
import { Priority, Rule, State, Tag } from "../shared/chips.tsx";
import { Occurrences, FindingInformation } from "../shared/Occurrences.tsx";
import { occurrenceList, saveOccurrenceState, type Where } from "./api.ts";
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
function History({
  finding,
  onTag,
  tag,
  onOpenFile,
}: {
  finding: Finding;
  onTag: (tag: string) => void;
  tag: string | null;
  onOpenFile: (at: PanelAt) => void;
}) {
  const entries = finding.record
    ? finding.record.history.flatMap((change) => {
        const patch = change.patch;
        const actions: string[] = [];
        if (change.revision === 1 && patch.title)
          actions.push("Created finding");
        else {
          if (patch.verdict) actions.push(String(patch.verdict));
          if ("reportedAt" in patch)
            actions.push(patch.reportedAt ? "reported" : "reporting cleared");
          if (patch.state === "closed")
            actions.push(
              (patch.closure as { reason?: string } | undefined)?.reason ??
                "closed",
            );
          else if (patch.state === "open") actions.push("reopened");
          const edited = [
            "title",
            "description",
            "note",
            "rules",
            "priority",
            "tags",
            "links",
          ].filter((key) => key in patch);
          if (edited.length) actions.push(`updated ${edited.join(", ")}`);
        }
        return actions.length
          ? [{ at: change.at, actor: change.actor, what: actions.join(" · ") }]
          : [];
      })
    : finding.history.map((entry) => ({
        at: entry.at,
        actor: entry.actor,
        what: entry.edited
          ? `rewrote ${entry.edited.join(", ")}`
          : (entry.verdict ??
            entry.resolution ??
            entry.reason ??
            "Updated finding"),
      }));
  const proofs = [
    ...new Set([
      ...(finding.provenTest ? [finding.provenTest] : []),
      ...(finding.record?.evidence
        .filter((e) => e.kind === "test")
        .flatMap((e) => e.artifacts) ?? []),
    ]),
  ];
  return (
    <aside
      aria-label="Finding details"
      className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-sm"
    >
      <h2 className="shrink-0 border-b border-line px-4 py-3 text-sm font-medium">
        Details
      </h2>
      <div className="min-w-0">
        <div className="space-y-3 p-4 text-sm">
          <div className="flex flex-wrap gap-2">
            <Priority of={finding.priority} />
            <Reporter finding={finding} />
            <Posted finding={finding} />
          </div>
          {(finding.tags ?? []).length > 0 && (
            <div className="flex flex-wrap gap-2">
              {finding.tags!.map((one) => (
                <Tag key={one} on={one === tag} onPick={() => onTag(one)}>
                  {one}
                </Tag>
              ))}
            </div>
          )}
          <div className="flex flex-col items-start gap-2 [&_a]:break-all [&_a]:whitespace-normal">
            {(
              finding.record?.rules ??
              (finding.rule ? [{ id: finding.rule }] : [])
            ).map((rule) => (
              <Rule key={rule.id} id={rule.id} />
            ))}
          </div>
          <Reported finding={finding} />
          {finding.confirmedAt && (
            <State title={finding.confirmedAt}>{finding.resolution} ✓</State>
          )}
          {proofs.length > 0 && (
            <section aria-label="Proof tests">
              <h3 className="mb-2 text-xs font-medium text-muted">
                Proof tests
              </h3>
              {proofs.map((proof) => {
                const at = /^(.*?)(?::(\d+))?$/.exec(proof);
                const name = (at?.[1] ?? proof).split(/[\\/]/).pop() || proof;
                const label = name + (at?.[2] ? `:${at[2]}` : "");
                return (
                  <p key={proof} className="my-1 break-all font-mono text-xs">
                    {at ? (
                      <button
                        type="button"
                        className="text-left underline underline-offset-2"
                        title={proof}
                        onClick={() =>
                          onOpenFile({ file: at[1]!, line: Number(at[2] ?? 1) })
                        }
                      >
                        {label}
                      </button>
                    ) : (
                      label
                    )}
                  </p>
                );
              })}
            </section>
          )}
        </div>
        {entries.length > 0 && (
          <details className="border-t border-line">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
              History
            </summary>
            <ol className="space-y-3 px-4 pb-4 text-xs text-muted">
              {[...entries].reverse().map((entry, index) => (
                <li key={`${entry.at}:${index}`}>
                  <p className="font-medium text-fg">{entry.what}</p>
                  <span title={entry.at}>{when(entry.at)}</span> · {entry.actor}
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
    </aside>
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
  if (finding.record || finding.verdict !== "invalid") return null;
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
  comment,
  where,
  onMove,
  onOpenFile,
  onTag,
  tag,
}: {
  finding: Finding;
  where?: Where | undefined;
  comment?: ReactNode;
  onMove: (to: string) => void;
  onOpenFile: (at: PanelAt) => void;
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
  const article = useRef<HTMLElement | null>(null);
  useEffect(() => {
    article.current
      ?.closest<HTMLElement>("[data-radix-scroll-area-viewport]")
      ?.scrollTo?.({ top: 0 });
  }, [finding.id]);
  return (
    <article ref={article} className="@container p-5 wrap-anywhere">
      <h1 className="mb-[0.6rem] text-[1.15rem] font-semibold">
        <span className="font-mono text-muted">{finding.id}</span>
        <span className="text-muted"> — </span>
        {finding.title}
      </h1>

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

      {/*
        Prose stays bounded; history sits at the far edge of the pane. The
        container query follows the pane width, including when a file panel
        is open. Source code keeps the full available width, and history
        follows it in the reading order when the pane is narrow.
      */}
      <div className="relative mt-4 grid grid-cols-1 items-start gap-4 @[900px]:grid-cols-[minmax(0,1fr)_320px]">
        <section
          aria-label="Description"
          className="min-w-0 max-w-[680px] overflow-hidden rounded-lg border border-line bg-card text-[0.95rem]"
        >
          <h2 className="border-b border-line px-5 py-3 text-sm font-medium text-muted">
            Description
          </h2>
          <div className="px-5 py-4">
            <MarkdownSurface
              surface={{
                // In the page there is a panel to open it in, so a citation does
                // not have to leave. The report has no panel and opens a tab.
                rule: (id) => ({ href: ruleUrl(id), external: true }),
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
        </section>

        {comment && (
          <div className="min-w-0 max-w-[680px] @[900px]:col-start-1 @[900px]:row-start-2">
            {comment}
          </div>
        )}
        <div className="min-w-0 @[900px]:col-span-2">
          {/*
        What the reviewer was looking at. A finding carries its own source
        because line numbers drift and a reader coming back next week needs
        to see what was seen, not what the file says by then.
      */}
          {finding.record && where ? (
            <>
              <FindingInformation record={finding.record} />
              <Occurrences
                key={`${where.repo}:${where.target}:${finding.id}`}
                findingId={finding.id}
                summary={finding.occurrenceSummary}
                refreshKey={`${finding.record.updatedAt}:${finding.occurrenceSummary?.revisionKey}`}
                load={() => occurrenceList(where, finding.id)}
                save={(occurrence) => saveOccurrenceState(where, occurrence)}
                onOpen={onOpenFile}
              />
            </>
          ) : (
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
          )}
        </div>
        <div className="min-w-0 max-w-[680px] @[900px]:absolute @[900px]:top-0 @[900px]:right-0 @[900px]:z-20 @[900px]:w-80">
          <History
            key={finding.id}
            finding={finding}
            onTag={onTag}
            tag={tag}
            onOpenFile={onOpenFile}
          />
        </div>
      </div>
    </article>
  );
}
