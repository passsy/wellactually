/**
 * A finding body, rendered.
 *
 * The two references that have no destination of their own — a rule id and a
 * relative document link — are resolved by whichever surface is rendering.
 * The report is a file sitting in the target directory beside the documents
 * it links, with no server to ask about rules; the triage page is served from
 * a port with neither beside it and opens both in its own panel. So the
 * parser says what a reference is and this asks the surface what it opens.
 *
 * A reference the surface cannot resolve stays plain text. A link that goes
 * nowhere is worse than the words it was made from.
 *
 * A fenced diagram is the same arrangement one block up: this says a fence
 * claims to be mermaid and the surface says whether it can draw one.
 */

import { createContext, use, type MouseEvent, type ReactNode } from "react";
import { parse, type Block, type Inline } from "./parse.ts";
import { tokenLines } from "../code/highlight.ts";
import { Line } from "../code/Line.tsx";

export interface Destination {
  href: string;
  /** Set when the target is somewhere other than this page. */
  external?: boolean;
  /**
   * Handled here rather than by following the href.
   *
   * A rule cited inside the panel opens in the panel: the reader is already
   * reading a rule and does not want the file they came from replaced. The
   * href stays real so the link can still be copied or opened in a tab.
   */
  onPick?: (() => void) | undefined;
}

export interface Surface {
  rule?: (id: string) => Destination | null;
  doc?: (path: string) => Destination | null;
  /**
   * A fenced block this surface can draw instead of print.
   *
   * The parser says what language a fence claims and this decides whether
   * that means anything here. Nearly every Level 2 document is a `mermaid`
   * fence holding the system map, and the triage page has a renderer for it;
   * the report is a file somebody is emailed and carries no script, so there
   * the same fence stays the source it was written as.
   *
   * `source` is that printed fence, handed over rather than left to be built
   * a second time: a renderer that has not loaded yet, or that cannot read
   * the diagram, has the real thing to fall back to.
   */
  draw?: (
    language: string,
    code: string,
    source: ReactNode,
  ) => ReactNode | null;
}

const SurfaceContext = createContext<Surface>({});

export function MarkdownSurface({
  surface,
  children,
}: {
  surface: Surface;
  children: ReactNode;
}) {
  return <SurfaceContext value={surface}>{children}</SurfaceContext>;
}

function Away({ to, children }: { to: Destination; children: ReactNode }) {
  return (
    <a
      href={to.href}
      {...(to.external ? { target: "_blank", rel: "noopener" } : {})}
      {...(to.onPick
        ? {
            onClick: (event: MouseEvent<HTMLAnchorElement>) => {
              // A modified click still means "somewhere else, please".
              if (event.metaKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              to.onPick?.();
            },
          }
        : {})}
      className="text-todo underline underline-offset-2"
    >
      {children}
    </a>
  );
}

function Run({ nodes }: { nodes: Inline[] }) {
  const surface = use(SurfaceContext);
  return (
    <>
      {nodes.map((node, at) => {
        switch (node.kind) {
          case "text":
            return node.text;
          case "break":
            return <br key={at} />;
          case "code":
            return (
              <code
                key={at}
                className="rounded bg-fg/8 px-1 py-px font-mono text-[.9em]"
              >
                {node.text}
              </code>
            );
          case "strong":
            return (
              <strong key={at} className="font-semibold">
                <Run nodes={node.children} />
              </strong>
            );
          case "em":
            return (
              <em key={at}>
                <Run nodes={node.children} />
              </em>
            );
          case "link":
            return (
              <Away key={at} to={{ href: node.href, external: true }}>
                {node.text}
              </Away>
            );
          case "doc": {
            const to = surface.doc?.(node.path);
            if (!to) return node.text;
            return (
              <Away key={at} to={to}>
                {node.text}
              </Away>
            );
          }
          case "rule": {
            const to = surface.rule?.(node.id);
            if (!to) return node.id;
            return (
              <Away key={at} to={to}>
                {node.id}
              </Away>
            );
          }
        }
      })}
    </>
  );
}

const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

function One({ block }: { block: Block }) {
  const surface = use(SurfaceContext);
  switch (block.kind) {
    case "paragraph":
      return (
        <p className="my-2">
          <Run nodes={block.children} />
        </p>
      );
    case "heading": {
      const Tag = HEADINGS[Math.min(block.depth, 6) - 1] ?? "h6";
      return (
        <Tag className="mt-4 mb-1 font-semibold">
          <Run nodes={block.children} />
        </Tag>
      );
    }
    case "quote":
      return (
        <blockquote className="my-2 border-l-2 border-line pl-3 text-muted">
          <Run nodes={block.children} />
        </blockquote>
      );
    case "fence": {
      const source = (
        <pre className="my-2 overflow-x-auto rounded-md bg-fg/6 p-3">
          <code
            className={`block w-max min-w-full font-mono text-[.85em] ${block.language ? `lang-${block.language}` : ""}`}
          >
            {tokenLines(block.code, block.language || null).map(
              (toks, index) => (
                <span key={index} className="block">
                  <Line toks={toks} />
                </span>
              ),
            )}
          </code>
        </pre>
      );
      return surface.draw?.(block.language, block.code, source) ?? source;
    }
    case "table": {
      const align = (at: number) =>
        block.align[at] === "center"
          ? "text-center"
          : block.align[at] === "right"
            ? "text-right"
            : "text-left";
      return (
        <div className="my-2 overflow-x-auto">
          <table className="border-collapse text-[.95em]">
            <thead>
              <tr>
                {block.head.map((cell, at) => (
                  <th
                    key={at}
                    className={`border border-line bg-fg/6 px-2 py-1 font-semibold ${align(at)}`}
                  >
                    <Run nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, deeper) => (
                <tr key={deeper}>
                  {row.map((cell, at) => (
                    <td
                      key={at}
                      className={`border border-line px-2 py-1 align-top ${align(at)}`}
                    >
                      <Run nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          className={`my-2 pl-5 ${block.ordered ? "list-decimal" : "list-disc"}`}
        >
          {block.items.map((item, at) => (
            <li key={at} className="my-1">
              <Run nodes={item.children} />
              {item.nested.length > 0 && (
                <ul className="my-1 list-disc pl-5">
                  {item.nested.map((each, deeper) => (
                    <li key={deeper}>
                      <Run nodes={each} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </Tag>
      );
    }
  }
}

export function Markdown({ body }: { body: string }) {
  const blocks = parse(body);
  return (
    <>
      {blocks.map((block, at) => (
        <One key={at} block={block} />
      ))}
    </>
  );
}
