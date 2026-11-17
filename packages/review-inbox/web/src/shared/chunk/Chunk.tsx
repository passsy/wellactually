/**
 * A place in the code, as it read when the finding was written.
 *
 * A finding carries its own source rather than pointing at a line number and
 * hoping. Line numbers drift, branches get rebased, and a reader coming back
 * a week later needs to see what the reviewer saw, not what the file says
 * now. The anchor lines are marked as one band so a finding about six lines
 * reads as one thing rather than six.
 *
 * The same component draws the queue's detail pane and the generated report,
 * so the two cannot come to different conclusions about the same finding.
 * That used to be done by shipping this function's own source text into the
 * browser with `fn.toString()`, which is the thing a shared module is for.
 */

import { cn } from "../cn.ts";
import { languageOf, tokenLines } from "../code/highlight.ts";
import { Line } from "../code/Line.tsx";

export interface ChunkAt {
  file: string;
  line: number;
  endLine?: number | undefined;
  /** Why this place belongs to the finding, when it is not the anchor. */
  note?: string | undefined;
  context?: { start: number; lines: string[] } | undefined;
  diff?: string | undefined;
}

/**
 * What the change did to these lines, counted off the hunk already here.
 *
 * The `+++` and `---` of a file header are not lines of the file, and a zero
 * is not information: a hunk that only added shows the one number that
 * happened.
 */
function churnOf(diff: string | undefined): { added: number; removed: number } {
  const lines = (diff ?? "").split("\n");
  return {
    added: lines.filter(
      (line) => line.startsWith("+") && !line.startsWith("+++"),
    ).length,
    removed: lines.filter(
      (line) => line.startsWith("-") && !line.startsWith("---"),
    ).length,
  };
}

function kindOf(line: string): string {
  if (line.startsWith("@@")) return "text-hitline";
  if (line.startsWith("+")) return "text-done";
  if (line.startsWith("-")) return "text-drop";
  return "text-muted";
}

export function Chunk({
  at,
  withDiff = true,
  onOpen,
}: {
  at: ChunkAt;
  /** The report shows the hunk; the triage page has a panel for it. */
  withDiff?: boolean | undefined;
  /** Given a way to open the file, the header becomes the way. */
  onOpen?: ((at: ChunkAt) => void) | undefined;
}) {
  const last = Math.max(at.line, at.endLine ?? at.line);
  const where = `${at.file}:${at.line}${last > at.line ? `-${last}` : ""}`;
  // Split where a path breaks, so the half that can be given up is a
  // different element from the half that cannot. A path is one unbreakable
  // word a hundred characters long and the widest thing in a chunk, which is
  // a box that clips: something has to go on a narrow card, and the
  // directories above a file are what a reader can do without. The file and
  // its line never move.
  const cut = where.lastIndexOf("/") + 1;
  const dirs = where.slice(0, cut);
  const name = where.slice(cut);
  const { added, removed } = churnOf(at.diff);
  const source = at.context?.lines.length ? at.context : null;
  const change = withDiff ? at.diff : undefined;

  if (!source && !change) return null;

  return (
    <div className="mt-4">
      {/*
        Why this place belongs to the finding, above the block rather than
        alongside the path. It is a sentence about the code, so it reads
        before the code and gets the width to be a sentence in.
      */}
      {at.note && <p className="mb-1 text-sm text-muted">{at.note}</p>}
      <div className="overflow-hidden rounded border border-line">
        {/*
          Every chunk says where it is, and the line that says so is what
          opens the file. The block itself is text someone reads and selects;
          a block that is also a link cannot be copied out of without
          navigating away from it.
        */}
        {/*
          The semantic names beside the utilities are a contract, not
          decoration. The report's enhancement finds a chunk by them to give
          the header somewhere to go, and a reader who saves the file and
          greps it finds the same names the server writes.
        */}
        <p
          className="chunk-head flex items-baseline gap-2 border-b border-line bg-card px-2 py-1 text-xs"
          data-file={at.file}
          data-line={at.line}
        >
          {onOpen ? (
            <button
              type="button"
              onClick={() => {
                onOpen(at);
              }}
              className="flex min-w-0 font-mono text-muted underline-offset-2 hover:underline"
              title={`${where} — open this file beside the finding`}
            >
              <span className="truncate">{dirs}</span>
              <span className="flex-none">{name}</span>
            </button>
          ) : (
            <span className="flex min-w-0 font-mono text-muted" title={where}>
              <span className="truncate">{dirs}</span>
              <span className="flex-none">{name}</span>
            </span>
          )}
          {added + removed > 0 && (
            <span className="churn font-mono">
              {added > 0 && <span className="add text-done">+{added}</span>}
              {removed > 0 && (
                <span className="del text-drop"> -{removed}</span>
              )}
            </span>
          )}
        </p>

        {source && (
          <pre className="code overflow-x-auto text-xs leading-relaxed">
            <code className="block w-max min-w-full">
              {/*
                Tokenized as one text, not line by line: a doc comment keeps
                its colour past its first line only if the tokenizer saw it
                open.
              */}
              {tokenLines(source.lines.join("\n"), languageOf(at.file)).map(
                (toks, index) => {
                  const number = source.start + index;
                  const marked = number >= at.line && number <= last;
                  return (
                    <span
                      key={number}
                      data-n={number}
                      className={cn(
                        "line block px-2",
                        // The whole marked block reads as one band: the ends
                        // round off, the lines between do not, so it cannot be
                        // mistaken for several.
                        marked && "at bg-band",
                        marked && number === at.line && "first rounded-t",
                        marked && number === last && "last rounded-b",
                      )}
                    >
                      <span className="n mr-3 inline-block w-8 text-right text-muted select-none">
                        {number}
                      </span>
                      <Line toks={toks} />
                    </span>
                  );
                },
              )}
            </code>
          </pre>
        )}

        {change && (
          <>
            <p className="border-y border-line bg-card px-2 py-1 text-xs text-muted">
              The change here
            </p>
            <pre className="code diff overflow-x-auto text-xs leading-relaxed">
              <code className="block w-max min-w-full">
                {change.split("\n").map((line, index) => (
                  <span
                    key={`${String(index)} ${line}`}
                    className={cn("line block px-2", kindOf(line))}
                  >
                    {line || " "}
                  </span>
                ))}
              </code>
            </pre>
          </>
        )}
      </div>
    </div>
  );
}

/** The anchor, then every other place the finding points at. */
export function Chunks({
  anchor,
  related,
  withDiff,
  onOpen,
}: {
  anchor: ChunkAt;
  related?: ChunkAt[] | undefined;
  withDiff?: boolean | undefined;
  onOpen?: ((at: ChunkAt) => void) | undefined;
}) {
  return (
    <>
      <Chunk at={anchor} withDiff={withDiff} onOpen={onOpen} />
      {(related ?? []).map((place) => (
        <Chunk
          key={`${place.file}:${place.line}`}
          at={place}
          withDiff={withDiff}
          onOpen={onOpen}
        />
      ))}
    </>
  );
}
