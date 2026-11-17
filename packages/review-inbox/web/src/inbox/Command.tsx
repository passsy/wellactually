/**
 * Jump to anything.
 *
 * One box over every name this page knows. What it searches is listed in
 * `command.ts`; what it does here is the part a person feels — the input
 * keeps the keyboard the whole time, the highlight is moved by pointing at a
 * row rather than by focusing it, and the whole thing is one press from
 * wherever you were, including mid-sentence in a note.
 */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "../shared/cn.ts";
import type { Finding, ReviewSummary } from "../shared/domain.ts";
import { keys, listDocs, listRules, type Where } from "./api.ts";
import { flatten, search, type Group, type Hit } from "./palette.ts";
import type { Tally } from "./filters.ts";

export function Command({
  open,
  onOpenChange,
  where,
  reviews,
  findings,
  counts,
  tags,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  where: Where | null;
  reviews: ReviewSummary[];
  findings: Finding[];
  counts: Tally;
  tags: string[];
  onChoose: (hit: Hit) => void;
}) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  // Asked on the first open rather than prefetched on mount: the catalogue
  // cannot change while the server is running, and most sessions never open
  // this at all.
  const rules = useQuery({
    queryKey: ["rules"],
    queryFn: listRules,
    enabled: open,
  });
  const docs = useQuery({
    queryKey: where ? keys.docs(where) : ["docs", "none"],
    queryFn: () => {
      if (!where) return Promise.reject(new Error("no review open"));
      return listDocs(where);
    },
    enabled: open && where !== null,
  });

  const groups: Group[] = search(query, {
    reviews,
    open: where,
    findings,
    counts,
    tags,
    docs: (docs.data ?? []).map((doc) => doc.path),
    rules: rules.data ?? [],
  });
  const hits = flatten(groups);

  // Adjusted while rendering: a shorter result set with a stale index would
  // paint one frame with nothing highlighted, and the row Enter would take is
  // the row the reader is looking at.
  const [lastQuery, setLastQuery] = useState(query);
  if (lastQuery !== query) {
    setLastQuery(query);
    setAt(0);
  }
  const on = Math.min(at, Math.max(0, hits.length - 1));
  const chosen = hits[on];

  useEffect(() => {
    if (!open) return;
    list.current
      ?.querySelector('[data-on="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [on, open, query]);

  // Opening is a fresh question, and whatever was typed last time is not it.
  // Adjusted while rendering rather than in an effect: an effect would paint
  // one frame of the last search under the new empty box.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setQuery("");
      setAt(0);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[18%] max-w-xl translate-y-0 gap-0 overflow-hidden border-line bg-card p-0 [&>button]:hidden"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Jump to anything</DialogTitle>
        <input
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          placeholder="Jump to a review, a pile, a finding, a file, a rule…"
          aria-activedescendant={chosen?.key}
          aria-controls="jump-list"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-[0.95rem] outline-none placeholder:text-muted"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setAt(Math.min(hits.length - 1, on + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setAt(Math.max(0, on - 1));
            } else if (event.key === "Enter" && chosen) {
              event.preventDefault();
              onChoose(chosen);
              onOpenChange(false);
            }
          }}
        />
        <div
          ref={list}
          id="jump-list"
          role="listbox"
          aria-label="Everywhere you can go"
          className="max-h-[52vh] min-h-0 overflow-auto py-1"
        >
          {hits.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-muted">
              Nothing here matches. Findings are searched in this review only.
            </p>
          )}
          {groups.map((group) => (
            <div key={group.kind}>
              <h3 className="mt-1 px-4 py-1 text-[0.63rem] font-semibold tracking-[0.09em] text-muted uppercase">
                {group.says}
                {group.more > 0 && (
                  <span className="ml-2 font-normal normal-case opacity-70">
                    +{group.more} more
                  </span>
                )}
              </h3>
              {group.hits.map((hit) => (
                <div
                  key={hit.key}
                  id={hit.key}
                  role="option"
                  aria-selected={hit.key === chosen?.key}
                  data-on={hit.key === chosen?.key}
                  // Pointed at rather than focused: the input keeps the
                  // keyboard, or typing after arrowing lands nowhere.
                  onMouseMove={() => {
                    const index = hits.findIndex((one) => one.key === hit.key);
                    if (index >= 0 && index !== on) setAt(index);
                  }}
                  onClick={() => {
                    onChoose(hit);
                    onOpenChange(false);
                  }}
                  className={cn(
                    "flex cursor-pointer items-baseline gap-2 px-4 py-1 text-sm",
                    hit.key === chosen?.key && "bg-at",
                  )}
                >
                  <span className="truncate">{hit.says}</span>
                  {hit.sub && (
                    <span className="truncate font-mono text-[0.7rem] text-muted">
                      {hit.sub}
                    </span>
                  )}
                  {hit.count !== undefined && (
                    <span className="ml-auto flex-none font-mono text-[0.7rem] text-muted">
                      {hit.count}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
