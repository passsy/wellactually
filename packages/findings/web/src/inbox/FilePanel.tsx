import { ruleUrl } from "../shared/rule-url.ts";
/**
 * The file beside the finding, and the rules a finding cites.
 *
 * One panel for both because they answer the same question at different
 * depths — "show me the thing this is about" — and because a reader who opens
 * a rule from inside a file wants to come back to the file, not to lose it.
 *
 * Every finding of the target that touches the open file is banded, not only
 * the one being read. A file with four findings in it is a different thing to
 * look at from a file with one, and that is worth knowing before deciding
 * whether the one on screen is really the problem.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  docUrl,
  keys,
  readDoc,
  readRule,
  readSource,
  type SourceView,
  type Where,
} from "./api.ts";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Markdown, MarkdownSurface } from "../shared/markdown/Markdown.tsx";
import { resolveDoc } from "../shared/markdown/parse.ts";
import { Diagram } from "./Diagram.tsx";
import { languageOf, tokenLines } from "../shared/code/highlight.ts";
import { Line } from "../shared/code/Line.tsx";
import { cn } from "../shared/cn.ts";
import { GROUPS, SHORTCUTS } from "./hooks/useKeys.ts";
import type { Finding } from "../shared/domain.ts";

export interface PanelAt {
  file: string;
  line: number;
  endLine?: number | undefined;
}

/** Which view of a file is being read. Remembered across files. */
const VIEWS: { value: SourceView; says: string; title: string }[] = [
  { value: "diff", says: "Diff", title: "What the author did to this file" },
  { value: "old", says: "Old", title: "The file before the change" },
  { value: "new", says: "New", title: "The file as it is now" },
];

/**
 * Every place any finding of this target marks in one file.
 *
 * The finding being read wins an overlap, because the band under the cursor
 * should be the one the reader came here for.
 */
function bandsIn(
  file: string,
  findings: Finding[],
  current: Finding | undefined,
): { from: number; to: number; mine: boolean }[] {
  const bands = findings
    .filter((finding) => finding.anchor.file === file)
    .map((finding) => ({
      from: finding.anchor.line,
      to: Math.max(
        finding.anchor.line,
        finding.anchor.endLine ?? finding.anchor.line,
      ),
      mine: finding.id === current?.id,
    }));
  // Mine last, so it is what a line lands on when two bands cover it.
  return bands.sort((a, b) => Number(a.mine) - Number(b.mine));
}

/**
 * One rendered line of a view: what it says, which line of the file it is —
 * null for the lines that are not lines of the file, a removal or a hunk
 * header — and what kind of diff line it is, when the view is the diff.
 */
interface Row {
  text: string;
  number: number | null;
  kind?: "add" | "del" | "hunk" | "meta";
}

/** What a diff line wears. The same colours the chunks already use. */
const INK: Record<NonNullable<Row["kind"]>, string> = {
  add: "text-done",
  del: "text-drop",
  hunk: "text-hitline",
  meta: "text-muted",
};

/**
 * The lines of a view, numbered as the file the finding points into.
 *
 * The old and new views are the file, so a line's number is its position. The
 * diff is a text *about* the file: its own positions mean nothing, and the
 * finding's band landed on whatever happened to sit that far down the patch.
 * The hunk headers say where the new file resumes, so counting through them
 * gives every kept and added line its real number — which is what lets the
 * band land on the same lines in every view.
 */
function rowsOf(lines: string[], view: SourceView): Row[] {
  if (view !== "diff") {
    return lines.map((text, index) => ({ text, number: index + 1 }));
  }
  const rows: Row[] = [];
  let at: number | null = null;
  for (const text of lines) {
    if (text.startsWith("@@")) {
      const hunk = /\+(\d+)/.exec(text);
      at = hunk?.[1] !== undefined ? Number(hunk[1]) : null;
      rows.push({ text, number: null, kind: "hunk" });
    } else if (
      text.startsWith("+++") ||
      text.startsWith("---") ||
      at === null
    ) {
      rows.push({ text, number: null, kind: "meta" });
    } else if (text.startsWith("+")) {
      rows.push({ text, number: at++, kind: "add" });
    } else if (text.startsWith("-")) {
      rows.push({ text, number: null, kind: "del" });
    } else {
      rows.push({ text, number: at++ });
    }
  }
  return rows;
}

function Source({
  where,
  at,
  view,
  findings,
  current,
}: {
  where: Where;
  at: PanelAt;
  view: SourceView;
  findings: Finding[];
  current: Finding | undefined;
}) {
  const file = useQuery({
    queryKey: keys.file(where, at.file, view),
    queryFn: () => readSource(where, at.file, view),
  });
  const anchor = useRef<HTMLSpanElement>(null);

  // The line the finding is about, not the top of the file. A panel that
  // opens at line 1 of a 900-line file has not answered anything.
  useEffect(() => {
    anchor.current?.scrollIntoView({ block: "center" });
  }, [file.data, view]);

  if (file.isError) {
    return (
      <p className="p-4 text-sm text-drop">
        {file.error instanceof Error
          ? file.error.message
          : "Could not read it."}
      </p>
    );
  }
  if (!file.data) return <p className="p-4 text-sm text-muted">Reading…</p>;

  const bands = bandsIn(at.file, findings, current);
  const effectiveView = file.data.view ?? view;
  const rows = rowsOf(file.data.lines, effectiveView);

  /*
   * Where the reader is taken: the place the panel was opened at, which is
   * not always the current finding's anchor — a related chunk opens its own
   * lines. Exact when the view has that line; the first line past it when it
   * does not, which is a diff whose hunks do not cover it.
   */
  const exact = rows.findIndex((row) => row.number === at.line);
  const anchorAt =
    exact >= 0
      ? exact
      : rows.findIndex((row) => row.number !== null && row.number >= at.line);

  /*
   * The diff carries its own colour — what changed — and the two file views
   * carry the language's. Both at once is noise, so the diff stays plain.
   */
  const code =
    effectiveView === "diff"
      ? null
      : tokenLines(file.data.lines.join("\n"), languageOf(at.file));

  return (
    <pre
      key={view}
      className="code animate-in fade-in overflow-auto p-0 text-xs leading-relaxed duration-150"
    >
      <code className="block w-max min-w-full">
        {rows.map((row, index) => {
          const number = row.number;
          const band =
            number === null
              ? undefined
              : bands.findLast(
                  (each) => number >= each.from && number <= each.to,
                );
          const first = band && number === band.from;
          return (
            <span
              key={index}
              ref={index === anchorAt ? anchor : undefined}
              {...(number !== null ? { "data-n": number } : {})}
              className={cn(
                "line block px-2",
                row.kind && INK[row.kind],
                band && (band.mine ? "at bg-band" : "bg-band/40"),
                band && first && "first rounded-t",
                band && number === band.to && "last rounded-b",
              )}
            >
              <span className="n mr-3 inline-block w-10 text-right text-muted select-none">
                {row.number}
              </span>
              {code ? <Line toks={code[index] ?? []} /> : row.text || " "}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

function Rule({ id, onRule }: { id: string; onRule: (id: string) => void }) {
  const rule = useQuery({
    queryKey: keys.rule(id),
    queryFn: () => readRule(id),
  });

  if (rule.isError) {
    return <p className="p-4 text-sm text-drop">No rule {id}.</p>;
  }
  if (!rule.data) return <p className="p-4 text-sm text-muted">Reading…</p>;

  return (
    <div className="overflow-auto p-4">
      <h2 className="text-base font-semibold">
        <span className="font-mono text-muted">{rule.data.id}</span>{" "}
        {rule.data.title}
      </h2>
      {rule.data.description && (
        <p className="mt-1 text-sm text-muted">{rule.data.description}</p>
      )}
      <div className="mt-4 text-[0.9rem]">
        {/*
          Rules cite each other, and in here a citation stays in the panel
          rather than opening a tab: the reader is already reading a rule.
        */}
        <MarkdownSurface
          surface={{
            rule: (other) => ({
              href: ruleUrl(other),
              onPick: () => {
                onRule(other);
              },
            }),
          }}
        >
          <Markdown body={rule.data.body} />
        </MarkdownSurface>
      </div>
    </div>
  );
}

/**
 * A document the review wrote, in the panel like everything else it cites.
 *
 * Markdown is rendered because that is what a level document is; any other
 * text is shown as it is. A binary neighbour — a PDF, a screenshot — cannot
 * be shown here, so it gets the one thing that can show it: a link handing
 * the browser the bytes.
 */
function Doc({
  where,
  path,
  onRule,
  onDoc,
}: {
  where: Where;
  path: string;
  onRule: (id: string) => void;
  onDoc: (path: string) => void;
}) {
  const doc = useQuery({
    queryKey: keys.doc(where, path),
    queryFn: () => readDoc(where, path),
  });

  if (doc.isError) {
    return (
      <p className="p-4 text-sm text-drop">
        {doc.error instanceof Error ? doc.error.message : "Could not read it."}
      </p>
    );
  }
  if (!doc.data) return <p className="p-4 text-sm text-muted">Reading…</p>;

  if (doc.data.binary || doc.data.text === undefined) {
    return (
      <p className="p-4 text-sm text-muted">
        Not text — {Math.max(1, Math.round(doc.data.bytes / 1024))} kB of
        something the browser shows better than this panel:{" "}
        <a
          href={docUrl(where, path)}
          target="_blank"
          rel="noopener"
          className="text-todo underline underline-offset-2"
        >
          open it
        </a>
        .
      </p>
    );
  }

  if (!path.endsWith(".md")) {
    return (
      <pre className="code animate-in fade-in overflow-auto p-2 text-xs leading-relaxed whitespace-pre-wrap duration-150">
        {doc.data.text}
      </pre>
    );
  }

  return (
    <div className="animate-in fade-in overflow-auto p-4 duration-150">
      <div className="text-[0.9rem]">
        <MarkdownSurface
          surface={{
            rule: (id) => ({
              href: ruleUrl(id),
              onPick: () => {
                onRule(id);
              },
            }),
            // A level document links its sub-reports, and they open here
            // like the document that linked them. The href is the raw file,
            // so a modified click still gets it in a tab of its own.
            doc: (href) => {
              const to = resolveDoc(path, href);
              if (!to) return null;
              return {
                href: docUrl(where, to),
                onPick: () => {
                  onDoc(to);
                },
              };
            },
            draw: (language, code, source) =>
              language === "mermaid" ? (
                <Diagram code={code} source={source} />
              ) : null,
          }}
        >
          <Markdown body={doc.data.text} />
        </MarkdownSurface>
      </div>
    </div>
  );
}

/**
 * Every key this page answers to, in the panel like everything else it can
 * show you.
 *
 * Built from the table that implements them, exactly as the dialog this
 * replaced was: a legend written by hand goes stale silently and keeps
 * promising a key that stopped doing anything.
 *
 * In the panel rather than in a modal, which is the whole point of moving it.
 * A reference you have to dismiss before you can use what it told you is the
 * one interaction a reference must not have — here the queue is still there,
 * still selected, still answering to the keys on the list.
 */
function Keys() {
  return (
    <div className="p-4">
      {GROUPS.map((group) => {
        const entries = SHORTCUTS.filter((one) => one.group === group);
        if (entries.length === 0) return null;
        return (
          <section key={group} className="mb-5 last:mb-0">
            <h2 className="mb-2 text-[0.68rem] font-semibold tracking-wider text-muted uppercase">
              {group}
            </h2>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 text-sm">
              {entries.map((entry) => (
                <div key={entry.does} className="contents">
                  <dt className="flex items-center gap-1">
                    {entry.show.map((key) => (
                      <Key key={key}>{key}</Key>
                    ))}
                    {entry.also && (
                      <>
                        <span className="px-0.5 text-xs text-muted">or</span>
                        {entry.also.map((key) => (
                          <Key key={key}>{key}</Key>
                        ))}
                      </>
                    )}
                  </dt>
                  <dd className="text-muted">{entry.does}</dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}
    </div>
  );
}

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-chip px-1.5 py-0.5 font-mono text-[0.7rem]">
      {children}
    </kbd>
  );
}

/** What the panel is showing. Every one of them has a name, which is what
 * lets one box reach all of them. */
export type Showing =
  | { kind: "file"; at: PanelAt }
  | { kind: "rule"; id: string }
  | { kind: "doc"; path: string }
  | { kind: "keys" };

/** What the panel calls the thing it is showing. */
function nameOf(showing: Showing): string {
  switch (showing.kind) {
    case "file":
      return `${showing.at.file}:${String(showing.at.line)}`;
    case "rule":
      return showing.id;
    case "doc":
      return showing.path;
    case "keys":
      return "Keyboard";
  }
}

export function FilePanel({
  where,
  showing,
  findings,
  current,
  view,
  onView,
  onRule,
  onDoc,
  onClose,
}: {
  /** Absent only for the keyboard, which is not about a review. */
  where: Where | null;
  showing: Showing;
  findings: Finding[];
  current: Finding | undefined;
  view: SourceView;
  onView: (view: SourceView) => void;
  onRule: (id: string) => void;
  onDoc: (path: string) => void;
  /** Closing is the page's to do: the panel is inside a sheet it does not own. */
  onClose: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-none items-center gap-3 border-b border-line px-3 py-1.5 text-xs">
        <span
          className={cn(
            "truncate text-muted",
            showing.kind !== "keys" && "font-mono",
          )}
        >
          {nameOf(showing)}
        </span>
        {showing.kind === "file" && !(where && showing.at.file.startsWith("/") && !showing.at.file.startsWith(where.repo + "/")) && (
          <Tabs
            value={view}
            onValueChange={(next) => {
              onView(next as SourceView);
            }}
          >
            <TabsList className="h-6 rounded-md p-0.5">
              {VIEWS.map((one) => (
                <TabsTrigger
                  key={one.value}
                  value={one.value}
                  title={one.title}
                  className="h-5 rounded px-1.5 text-xs"
                >
                  {one.says}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}
        {/*
          The way out, and the key that is the same way out. Every other
          surface on this page closes with Esc, so the panel says so where
          the button is rather than leaving it to be discovered.

          Both sit in this row rather than one of them being pinned to the
          sheet's corner. They were: the badge was laid out here and the
          cross was absolutely placed sixteen pixels down from the top of the
          sheet, so their centres were six pixels apart — and the distance
          moved with the header, which is two pixels taller for a file than
          for a rule because of the view tabs. Laid out side by side they are
          aligned by the same flexbox that aligns everything else in the bar,
          at every height it takes.
        */}
        <span className="ml-auto flex flex-none items-center gap-2 text-muted">
          <Key>Esc</Key>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-sm opacity-70 transition-opacity hover:opacity-100"
          >
            <X className="size-4" />
            <span className="sr-only">Close the panel</span>
          </button>
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {showing.kind === "keys" ? (
          <Keys />
        ) : where === null ? null : showing.kind === "file" ? (
          <Source
            where={where}
            at={showing.at}
            view={view}
            findings={findings}
            current={current}
          />
        ) : showing.kind === "rule" ? (
          <Rule id={showing.id} onRule={onRule} />
        ) : (
          <Doc
            where={where}
            path={showing.path}
            onRule={onRule}
            onDoc={onDoc}
          />
        )}
      </div>
    </div>
  );
}
