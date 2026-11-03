/**
 * The cases the old renderer had a comment about.
 *
 * A markdown renderer is easy to rewrite and easy to rewrite wrongly: the
 * ordinary paragraph works on the first try and the awkward ones — a rule id
 * inside a URL, a snake_case identifier that is not emphasis — are what
 * somebody hit in real output and fixed. Each of those is a test here, so the
 * fix survives the rewrite that deleted the code it was made in.
 */

import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { inline, parse, resolveDoc } from "./parse.ts";
import { Markdown, MarkdownSurface } from "./Markdown.tsx";

const kinds = (text: string) => inline(text).map((node) => node.kind);

describe("what a backticked span protects", () => {
  it("keeps markup written inside code as the characters it was", () => {
    expect(inline("the `**ptr` argument")).toEqual([
      { kind: "text", text: "the " },
      { kind: "code", text: "**ptr" },
      { kind: "text", text: " argument" },
    ]);
  });

  it("leaves a rule id somebody quoted deliberately as a quotation", () => {
    expect(kinds("see `PW-D001` there")).toEqual(["text", "code", "text"]);
  });
});

describe("emphasis, which has to hug what it emphasises", () => {
  it("does not italicise a snake_case identifier", () => {
    expect(kinds("the some_long_name value")).toEqual(["text"]);
  });

  it("does not italicise a multiplied pair of variables", () => {
    expect(kinds("a * b and c * d")).toEqual(["text"]);
  });

  it("still emphasises a word that is emphasised", () => {
    expect(inline("a *real* one")).toEqual([
      { kind: "text", text: "a " },
      { kind: "em", children: [{ kind: "text", text: "real" }] },
      { kind: "text", text: " one" },
    ]);
  });
});

describe("references the surface has to resolve", () => {
  it("finds a rule id in prose", () => {
    expect(inline("breaks PW-D001 here")).toContainEqual({
      kind: "rule",
      id: "PW-D001",
    });
  });

  it("leaves a rule id inside a URL inside the URL", () => {
    // The string version had to skip over the tags it had just written to
    // avoid linkifying out of the middle of an href.
    const nodes = inline("[the rule](https://x.test/PW-D001)");
    expect(nodes).toEqual([
      { kind: "link", href: "https://x.test/PW-D001", text: "the rule" },
    ]);
  });

  it("links a bare URL, which is how markdownlint makes them arrive", () => {
    expect(inline("see <https://x.test/a> now")).toContainEqual({
      kind: "link",
      href: "https://x.test/a",
      text: "https://x.test/a",
    });
  });

  it("treats a relative link as another document of the review", () => {
    expect(inline("[the argument](Level-1/solution.md)")).toEqual([
      { kind: "doc", path: "Level-1/solution.md", text: "the argument" },
    ]);
  });

  it("links one written inside a bullet, which is where a review puts them", () => {
    render(
      <MarkdownSurface surface={{}}>
        <Markdown
          body={"- Pull request: <https://example.com/p/1>\n- Base: e624ab0"}
        />
      </MarkdownSurface>,
    );

    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "https://example.com/p/1",
    );
    expect(screen.getByText(/Base: e624ab0/)).toBeInTheDocument();
  });

  it("refuses a scheme, an anchor and an absolute path", () => {
    for (const href of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "#top",
      "/x",
    ]) {
      expect(inline(`[go](${href})`)).toEqual([
        { kind: "text", text: `[go](${href})` },
      ]);
    }
  });
});

describe("how lines become paragraphs", () => {
  it("flows one sentence per line into one paragraph", () => {
    const blocks = parse("First sentence.\nSecond sentence.");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "paragraph" });
  });

  it("keeps a break that was asked for with two trailing spaces", () => {
    const [block] = parse("one  \ntwo");
    expect(block).toMatchObject({ kind: "paragraph" });
    expect(block?.kind === "paragraph" && block.children).toContainEqual({
      kind: "break",
    });
  });

  it("splits a label from the list under it", () => {
    const blocks = parse("What is wrong:\n- the first\n- the second");
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "list"]);
  });

  it("continues a bullet with the sentences indented under it", () => {
    const [block] = parse("- The first sentence.\n  The second one.");
    expect(block?.kind).toBe("list");
    if (block?.kind !== "list") return;
    expect(block.items).toHaveLength(1);
    expect(block.items[0]?.children).toEqual([
      { kind: "text", text: "The first sentence. The second one." },
    ]);
  });

  it("numbers a numbered list", () => {
    render(<Markdown body={"1. First\n2. Second"} />);

    const list = screen.getByRole("list");
    expect(list.tagName).toBe("OL");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  });

  it("nests an indented bullet inside the one above it", () => {
    render(<Markdown body={"- Outer\n  - Inner"} />);

    // Nested rather than a sibling: a review indents to say "this is part of
    // that", and flattening it says the opposite.
    const outer = screen.getAllByRole("listitem")[0];
    expect(within(outer as HTMLElement).getByText("Inner")).toBeInTheDocument();
  });

  it("keeps a fence's language without printing it", () => {
    expect(parse("```dart\nfinal a = 1;\n```")).toEqual([
      { kind: "fence", language: "dart", code: "final a = 1;" },
    ]);
  });
});

describe("what reaches the page", () => {
  it("renders markup in a body as the text it is", () => {
    render(<Markdown body="a <script>alert(1)</script> b" />);
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText(/alert\(1\)/)).toBeInTheDocument();
  });

  it("leaves a reference the surface cannot resolve as plain text", () => {
    render(<Markdown body="breaks PW-D001 here" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/PW-D001/)).toBeInTheDocument();
  });

  it("prints a fence the surface cannot draw", () => {
    render(
      <MarkdownSurface surface={{ draw: () => null }}>
        <Markdown body={"```mermaid\nflowchart LR\n  a --> b\n```"} />
      </MarkdownSurface>,
    );
    expect(screen.getByText(/flowchart LR/)).toBeInTheDocument();
  });

  it("hands a fence it can draw to the surface, source and all", () => {
    render(
      <MarkdownSurface
        surface={{
          draw: (language, code, source) =>
            language === "mermaid" ? (
              <figure>
                <span>drawn: {code.trim()}</span>
                {source}
              </figure>
            ) : null,
        }}
      >
        <Markdown body={"```mermaid\nflowchart LR\n  a --> b\n```"} />
      </MarkdownSurface>,
    );
    // The fallback comes with it, which is what lets a renderer that has not
    // loaded yet show the fence rather than a hole.
    expect(screen.getByText(/^drawn:/)).toBeInTheDocument();
    expect(screen.getByRole("figure").querySelector("pre")).not.toBeNull();
  });

  it("opens a reference the surface can resolve", () => {
    render(
      <MarkdownSurface
        surface={{ rule: (id) => ({ href: `/rule/${id}`, external: true }) }}
      >
        <Markdown body="breaks PW-D001 here" />
      </MarkdownSurface>,
    );
    expect(screen.getByRole("link", { name: "PW-D001" })).toHaveAttribute(
      "href",
      "/rule/PW-D001",
    );
  });
});

describe("tables, which level documents use for their summaries", () => {
  it("parses a header, its alignment and its rows", () => {
    expect(parse("| A | B |\n| :-- | --: |\n| 1 | `x` |")).toEqual([
      {
        kind: "table",
        align: ["left", "right"],
        head: [[{ kind: "text", text: "A" }], [{ kind: "text", text: "B" }]],
        rows: [[[{ kind: "text", text: "1" }], [{ kind: "code", text: "x" }]]],
      },
    ]);
  });

  it("splits a table off the lines around it", () => {
    const blocks = parse(
      "## Groups\nLead line.\n| A | B |\n| --- | --- |\n| 1 | 2 |",
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "table",
    ]);
  });

  it("keeps a pipe inside code or escaped as part of the cell", () => {
    const [table] = parse("| T | N |\n| --- | --- |\n| `a | b` | c \\| d |");
    expect(table).toMatchObject({
      rows: [
        [[{ kind: "code", text: "a | b" }], [{ kind: "text", text: "c | d" }]],
      ],
    });
  });

  it("pads a short row so the grid holds", () => {
    const [table] = parse("| A | B |\n| --- | --- |\n| 1 |");
    expect(table).toMatchObject({ rows: [[[{ text: "1" }], []]] });
  });

  it("leaves prose with a pipe in it as prose", () => {
    expect(parse("a | b\nand more").map((block) => block.kind)).toEqual([
      "paragraph",
    ]);
  });

  it("renders links inside cells", () => {
    render(
      <MarkdownSurface surface={{ doc: (path) => ({ href: path }) }}>
        <Markdown
          body={
            "| G | R |\n| --- | --- |\n| Dart | [Dart report](Level-5/dart.md) |"
          }
        />
      </MarkdownSurface>,
    );
    const table = screen.getByRole("table");
    expect(
      within(table).getByRole("link", { name: "Dart report" }),
    ).toHaveAttribute("href", "Level-5/dart.md");
  });
});

describe("a document link, read from the document it was written in", () => {
  it("goes down into a folder", () => {
    expect(resolveDoc("Level-5.md", "Level-5/dart.md")).toBe("Level-5/dart.md");
  });

  it("stays in the folder of a nested document", () => {
    expect(resolveDoc("Level-5/dart.md", "general.md")).toBe(
      "Level-5/general.md",
    );
  });

  it("climbs back up", () => {
    expect(resolveDoc("Level-5/dart.md", "../Level-5.md")).toBe("Level-5.md");
  });

  it("drops an anchor", () => {
    expect(resolveDoc("README.md", "./Level-1.md#summary")).toBe("Level-1.md");
  });

  it("refuses to leave the review", () => {
    expect(resolveDoc("Level-5.md", "../outside.md")).toBeNull();
  });
});
