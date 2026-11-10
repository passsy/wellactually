/**
 * What the review wrote by hand, under the queue.
 *
 * Not behind a menu: the findings are the conclusions and these are the
 * argument they came out of, so a reader who doubts a finding wants them in
 * the same glance rather than after a click they have to think of.
 *
 * A review can also drop hundreds of attachments into folders, and a flat
 * list of full paths would drown the argument in its supporting material.
 * So the list is a tree: files before folders, because the documents at the
 * root are the point and the folders hold what backs them up. Folders start
 * closed and remember being opened for as long as the page lives.
 *
 * The generated report sits here too, as the odd one out. It is not something
 * the review wrote, so it is not in the list — but it is the thing you send
 * to somebody who has none of this installed, and the only other way to it is
 * a link buried inside a document.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";
import { keys, listDocs, type DocumentEntry, type Where } from "./api.ts";

interface Folder {
  name: string;
  path: string;
  folders: Folder[];
  files: DocumentEntry[];
  /** Files anywhere beneath, so a closed folder still says how much it holds. */
  count: number;
}

/**
 * The flat listing regrouped by folder, in the order the server sorted it:
 * the README first, then everything else in reading order.
 */
function treeOf(docs: DocumentEntry[]): Folder {
  const root: Folder = { name: "", path: "", folders: [], files: [], count: 0 };
  for (const doc of docs) {
    const parts = doc.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.folders.find((child) => child.name === part);
      if (!next) {
        next = {
          name: part,
          path: node.path === "" ? part : `${node.path}/${part}`,
          folders: [],
          files: [],
          count: 0,
        };
        node.folders.push(next);
      }
      next.count += 1;
      node = next;
    }
    node.files.push(doc);
  }
  root.count = docs.length;
  return root;
}

function Rows({
  node,
  depth,
  open,
  onToggle,
  onOpen,
}: {
  node: Folder;
  depth: number;
  open: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const indent = { paddingLeft: `${String(0.8 + depth * 0.9)}rem` };
  return (
    <>
      {node.files.map((doc) => (
        <li key={doc.path}>
          <button
            type="button"
            title={doc.path}
            onClick={() => {
              onOpen(doc.path);
            }}
            className="flex w-full items-baseline gap-2 py-1 pr-[0.8rem] text-left text-sm transition-colors hover:bg-at"
            style={indent}
          >
            <span className="truncate">{doc.path.split("/").at(-1)}</span>
            <span className="ml-auto flex-none font-mono text-[0.7rem] text-muted">
              {Math.max(1, Math.round(doc.bytes / 1024))}k
            </span>
          </button>
        </li>
      ))}
      {node.folders.map((folder) => (
        <li key={folder.path}>
          <button
            type="button"
            aria-expanded={open.has(folder.path)}
            onClick={() => {
              onToggle(folder.path);
            }}
            className="flex w-full items-baseline gap-1.5 py-1 pr-[0.8rem] text-left text-sm transition-colors hover:bg-at"
            style={indent}
          >
            <span aria-hidden className="flex-none text-[0.7rem] text-muted">
              {open.has(folder.path) ? "▾" : "▸"}
            </span>
            <span className="truncate">{folder.name}</span>
            <span className="ml-auto flex-none font-mono text-[0.7rem] text-muted">
              {folder.count}
            </span>
          </button>
          {open.has(folder.path) && (
            <ul>
              <Rows
                node={folder}
                depth={depth + 1}
                open={open}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            </ul>
          )}
        </li>
      ))}
    </>
  );
}

export function Documents({
  where,
  onOpen,
}: {
  where: Where | null;
  onOpen: (path: string) => void;
}) {
  const docs = useQuery({
    queryKey: where ? keys.docs(where) : ["docs", "none"],
    queryFn: () => {
      if (!where) return Promise.reject(new Error("no review open"));
      return listDocs(where);
    },
    enabled: where !== null,
  });

  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (path: string) => {
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const root = treeOf(docs.data ?? []);

  return (
    <section
      data-keeps-panel
      className="flex h-full min-h-0 flex-col border-t border-line"
    >
      <h2 className="flex flex-none items-center gap-2 px-[0.8rem] py-1 text-[0.68rem] font-semibold tracking-wider text-muted uppercase">
        <span>Documents{root.count > 0 ? ` ${String(root.count)}` : ""}</span>
      </h2>
      <ScrollArea className="min-h-0 flex-1">
        <ul>
          {root.count === 0 && (
            <li className="px-[0.8rem] py-1 text-sm text-muted">
              Nothing written yet.
            </li>
          )}
          <Rows
            node={root}
            depth={0}
            open={open}
            onToggle={toggle}
            onOpen={onOpen}
          />
        </ul>
      </ScrollArea>
    </section>
  );
}
