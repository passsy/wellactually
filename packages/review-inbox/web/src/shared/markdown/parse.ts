/**
 * Enough markdown for a finding body.
 *
 * Findings are written by agents that reach for fences, bullets, inline code
 * and the occasional link, and level documents add headings on top of that.
 *
 * This produces a tree rather than a string of HTML. The version it replaces
 * escaped its input by hand before a single transform ran, which worked and
 * had to keep working forever: every regex added afterwards was one more
 * chance to reintroduce the hole. Nothing is escaped here, because nothing is
 * ever concatenated into markup — React puts text in as text.
 *
 * Two kinds of reference come out without a destination. A rule id and a
 * relative document link mean different things on the two surfaces that
 * render this: the report sits in the target directory beside the documents
 * it links and has no server to ask about rules, and the triage page is
 * served from a port with neither beside it. So the node says what it is and
 * the surface decides what it opens.
 *
 * Not supported, because no finding has yet wanted them: images, footnotes,
 * and a fenced block nested inside a list item.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "break" }
  /** An absolute link. Opens where it says, in a tab of its own. */
  | { kind: "link"; href: string; text: string }
  /** Another document of the same review. The surface resolves it. */
  | { kind: "doc"; path: string; text: string }
  /** A handbook rule id found in prose. The surface resolves it. */
  | { kind: "rule"; id: string };

export interface ListItem {
  children: Inline[];
  nested: Inline[][];
}

export type Block =
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "heading"; depth: number; children: Inline[] }
  | { kind: "quote"; children: Inline[] }
  | { kind: "list"; ordered: boolean; items: ListItem[] }
  | { kind: "fence"; language: string; code: string }
  | {
      kind: "table";
      align: Align[];
      head: Inline[][];
      rows: Inline[][][];
    };

export type Align = "left" | "center" | "right" | null;

/** A rule id as it appears in prose, e.g. PW-D001. */
const RULE = /\bPW-[A-Z]\d{3}\b/g;

/**
 * Splits the text nodes of a run on a pattern, leaving everything else alone.
 *
 * Inline parsing is a sequence of these, and each pass has to skip what the
 * passes before it produced — otherwise a rule id inside a URL gets linkified
 * out of the middle of an href, which is the bug the string version had to
 * dodge by matching tags it had just written.
 */
function split(
  run: Inline[],
  pattern: RegExp,
  make: (match: RegExpExecArray) => Inline | Inline[] | null,
): Inline[] {
  const out: Inline[] = [];
  for (const node of run) {
    if (node.kind !== "text") {
      out.push(node);
      continue;
    }
    const source = new RegExp(
      pattern.source,
      pattern.flags.replace("g", "") + "g",
    );
    let at = 0;
    let match: RegExpExecArray | null;
    while ((match = source.exec(node.text)) !== null) {
      const made = make(match);
      if (!made) continue;
      if (match.index > at) {
        out.push({ kind: "text", text: node.text.slice(at, match.index) });
      }
      out.push(...(Array.isArray(made) ? made : [made]));
      at = match.index + match[0].length;
    }
    if (at < node.text.length) {
      out.push({ kind: "text", text: node.text.slice(at) });
    }
  }
  return out;
}

/** Everything that happens inside one line of prose. */
export function inline(text: string): Inline[] {
  // Inline code comes off first and nothing else touches it. A backticked
  // span is a quotation, so `**ptr` out of some C, or a rule id somebody
  // quoted deliberately, has to come out as the characters that were written.
  let run: Inline[] = [];
  for (const [at, part] of text.split(/(`[^`]+`)/).entries()) {
    if (part === "") continue;
    run.push(
      at % 2 === 1
        ? { kind: "code", text: part.slice(1, -1) }
        : { kind: "text", text: part },
    );
  }

  // An absolute link goes where it says.
  run = split(run, /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (match) => ({
    kind: "link",
    href: match[2] ?? "",
    text: match[1] ?? "",
  }));

  // The same link written as itself. Not a rare form to be tolerated:
  // markdownlint refuses a bare URL in prose, so every URL nobody gave a
  // label to arrives wrapped in angle brackets.
  run = split(run, /<(https?:\/\/[^\s>]+)>/g, (match) => ({
    kind: "link",
    href: match[1] ?? "",
    text: match[1] ?? "",
  }));

  // A relative one points at another document of the same review. Anything
  // with a scheme, an anchor or a leading slash is left as the text it was
  // written as: those are not documents, and a document an agent wrote is not
  // a place to follow a `file:` or a `javascript:` from.
  run = split(run, /\[([^\]]+)\]\(([^\s)]+)\)/g, (match) => {
    const href = match[2] ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
    if (href.startsWith("#") || href.startsWith("/")) return null;
    return { kind: "doc", path: href, text: match[1] ?? "" };
  });

  run = split(run, /\*\*([^*]+)\*\*/g, (match) => ({
    kind: "strong",
    children: [{ kind: "text", text: match[1] ?? "" }],
  }));

  // Emphasis needs the delimiter to hug its text, or a multiplied pair of
  // variables and a snake_case identifier become italics. That leading
  // character is part of the match and is not part of the emphasis, so it is
  // handed back as its own text node rather than swallowed.
  for (const mark of [
    /(^|[\s(])\*([^\s*][^*]*)\*(?=$|[\s).,;:!?])/g,
    /(^|[\s(])_([^\s_][^_]*)_(?=$|[\s).,;:!?])/g,
  ]) {
    run = split(run, mark, (match) => {
      const em: Inline = {
        kind: "em",
        children: [{ kind: "text", text: match[2] ?? "" }],
      };
      return match[1] ? [{ kind: "text", text: match[1] }, em] : em;
    });
  }

  return merge(split(run, RULE, (match) => ({ kind: "rule", id: match[0] })));
}

/**
 * Adjacent text, as one node.
 *
 * The passes above cut text apart wherever they matched and hand back the
 * pieces they did not want, so a plain sentence can arrive in four fragments.
 * Nothing renders differently either way; this is so that what comes out is a
 * function of the markdown rather than of how many passes happened to touch
 * it, which is the difference between a readable test and a brittle one.
 */
function merge(run: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const node of run) {
    const last = out[out.length - 1];
    if (node.kind === "text" && last?.kind === "text") {
      out[out.length - 1] = { kind: "text", text: last.text + node.text };
      continue;
    }
    if (node.kind === "text" && node.text === "") continue;
    out.push(node);
  }
  return out;
}

const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const isBullet = (line: string): boolean =>
  /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line);

/**
 * One list, from the lines that make it up.
 *
 * A line that is not a bullet continues the bullet above it, which is how
 * this project writes markdown: one sentence per line, the second and later
 * sentences of a bullet indented under the first.
 */
function list(lines: string[]): Block {
  const ordered = /^\s*\d+[.)]\s/.test(lines[0] ?? "");
  const items: { text: string[]; nested: string[] }[] = [];
  for (const line of lines) {
    const bullet = BULLET.exec(line);
    const last = items[items.length - 1];
    if (!bullet) {
      if (last) last.text.push(line.trim());
      continue;
    }
    // Two spaces is the shallowest indent that can only be deliberate.
    if ((bullet[1] ?? "").length >= 2 && last) {
      last.nested.push(bullet[2] ?? "");
      continue;
    }
    items.push({ text: [bullet[2] ?? ""], nested: [] });
  }
  return {
    kind: "list",
    ordered,
    items: items.map((item) => ({
      children: inline(item.text.join(" ")),
      nested: item.nested.map((each) => inline(each)),
    })),
  };
}

/**
 * The lines of one paragraph, flowed into it.
 *
 * A newline inside a paragraph is a wrap, not a break. This project writes
 * one sentence per line so that a review comment lands on the sentence that
 * changed, and an agent soft-wraps wherever its output happened to wrap;
 * neither means the reader should see a ragged column. A break that was meant
 * is written the way markdown writes it, with two trailing spaces.
 */
function flow(lines: string[]): Inline[] {
  const out: Inline[] = [];
  for (const [at, line] of lines.entries()) {
    out.push(...inline(line.trim()));
    if (at === lines.length - 1) continue;
    out.push(
      /\s\s$/.test(line) ? { kind: "break" } : { kind: "text", text: " " },
    );
  }
  return out;
}

/**
 * The cells of one table row.
 *
 * A pipe inside inline code or escaped with a backslash is part of the cell,
 * which is how a `a | b` union type survives being put in a table.
 */
function cells(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let code = false;
  const row = line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "");
  for (let at = 0; at < row.length; at++) {
    const char = row[at];
    if (char === "\\" && row[at + 1] === "|") {
      cell += "|";
      at++;
      continue;
    }
    if (char === "`") code = !code;
    if (char === "|" && !code) {
      out.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
  }
  out.push(cell.trim());
  return out;
}

const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const isRow = (line: string): boolean => line.includes("|");

/** Where a table starts in these lines: its header, above a delimiter row. */
function tableAt(lines: string[]): number {
  for (let at = 0; at + 1 < lines.length; at++) {
    const header = lines[at] ?? "";
    const delimiter = lines[at + 1] ?? "";
    if (!isRow(header) || !DELIMITER.test(delimiter)) continue;
    if (!delimiter.includes("|") && cells(header).length < 2) continue;
    if (cells(header).length !== cells(delimiter).length) continue;
    return at;
  }
  return -1;
}

function table(lines: string[]): Block {
  const align = cells(lines[1] ?? "").map((spec): Align => {
    const left = spec.startsWith(":");
    const right = spec.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
  const width = align.length;
  // A row with too few cells is padded and one with too many is cut, the
  // way GitHub draws it, so a ragged row does not tear the grid.
  const fit = (line: string) =>
    Array.from({ length: width }, (_, at) => inline(cells(line)[at] ?? ""));
  return {
    kind: "table",
    align,
    head: fit(lines[0] ?? ""),
    rows: lines.slice(2).map(fit),
  };
}

/** The blocks of one blank-line-separated chunk of prose. */
function blocks(lines: string[]): Block[] {
  if (lines.length === 0) return [];

  // A table is often introduced by a line of its own with no blank line in
  // between, so it is looked for anywhere in the chunk rather than only at
  // its start.
  const starts = tableAt(lines);
  if (starts >= 0) {
    let ends = starts + 2;
    while (ends < lines.length && isRow(lines[ends] ?? "")) ends++;
    return [
      ...blocks(lines.slice(0, starts)),
      table(lines.slice(starts, ends)),
      ...blocks(lines.slice(ends)),
    ];
  }

  // A level document is mostly headings, so a body that starts with one
  // gets it rather than a paragraph beginning with a hash.
  const heading = /^(#{1,6})\s+(.*)$/.exec(lines[0] ?? "");
  if (heading) {
    return [
      {
        kind: "heading",
        depth: heading[1]?.length ?? 1,
        children: inline(heading[2] ?? ""),
      },
      ...blocks(lines.slice(1)),
    ];
  }

  if (lines.every((line) => /^\s*>\s?/.test(line))) {
    return [
      {
        kind: "quote",
        children: flow(lines.map((line) => line.replace(/^\s*>\s?/, ""))),
      },
    ];
  }

  // A label and its list are one block as often as they are two, so the
  // lead is split off rather than dragged into the first bullet.
  const bullet = lines.findIndex(isBullet);
  if (bullet === 0) return [list(lines)];
  if (bullet > 0) {
    return [
      { kind: "paragraph", children: flow(lines.slice(0, bullet)) },
      list(lines.slice(bullet)),
    ];
  }
  return [{ kind: "paragraph", children: flow(lines) }];
}

export function parse(body: string): Block[] {
  const out: Block[] = [];
  for (const [at, chunk] of body.split(/```/).entries()) {
    // A fence opens with its language, which is a hint for a highlighter this
    // page does not have, so it would render as a stray first line. It is
    // kept, so one can be added without changing this.
    if (at % 2 === 1) {
      out.push({
        kind: "fence",
        language: /^([a-zA-Z0-9_+-]*)\n/.exec(chunk)?.[1] ?? "",
        code: chunk.replace(/^[a-zA-Z0-9_+-]*\n/, "").replace(/\s+$/, ""),
      });
      continue;
    }
    for (const raw of chunk.split(/\n{2,}/)) {
      const paragraph = raw.replace(/^\n+|\s+$/g, "");
      if (paragraph === "") continue;
      out.push(...blocks(paragraph.split("\n")));
    }
  }
  return out;
}

/**
 * A relative document link, as a path from the review's root.
 *
 * A level document links its own sub-reports as `Level-5/dart.md`, and a
 * sub-report links back up as `../Level-5.md`, so the link is read from the
 * folder of the document it was written in. A link that climbs out of the
 * review is not a document of it and comes back null. An anchor or a query on
 * the end names a place in the document, which the panel cannot scroll to,
 * so it is dropped rather than sent as part of the file name.
 */
export function resolveDoc(from: string, href: string): string | null {
  const target = href.replace(/[?#].*$/, "");
  if (target === "") return null;
  const parts = from.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : null;
}
