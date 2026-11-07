/**
 * What happens around mermaid, which is the part that can go wrong.
 *
 * mermaid itself is not under test here — it is three megabytes of somebody
 * else's layout engine and it draws what it draws. What this page owes the
 * reader is everything at the edges of it: that a fence which will not parse
 * comes back as the source it was rather than as a hole, that the document
 * says something in the moment before the drawing exists, and that a drawing
 * made in one theme does not stay in it after the page is switched.
 *
 * One thing here is not checked here. Whether a map opens fitted or at full
 * size is decided by measuring it against the panel, and jsdom lays nothing
 * out: every width in it is zero. That one is checked in a browser.
 */

import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Diagram } from "./Diagram.tsx";

const render_ = vi.fn();
const initialize = vi.fn();

vi.mock("mermaid", () => ({
  default: {
    initialize: (config: unknown) => {
      initialize(config);
    },
    render: (id: string, code: string) => render_(id, code) as unknown,
  },
}));

const MAP = "flowchart LR\n  a --> b";
const source = <pre>{MAP}</pre>;

beforeEach(() => {
  render_.mockReset();
  initialize.mockReset();
  render_.mockResolvedValue({ svg: "<svg><text>a</text></svg>" });
});

describe("a system map on the page", () => {
  test("draws what mermaid gives it", async () => {
    render(<Diagram code={MAP} source={source} />);

    await waitFor(() => {
      expect(document.querySelector("svg")).not.toBeNull();
    });
    expect(render_).toHaveBeenCalledWith(expect.any(String), MAP);
  });

  test("shows the fence until mermaid has answered", () => {
    render(<Diagram code={MAP} source={source} />);
    // Synchronously, before the import resolves: the document still says
    // something, and what it says is the diagram's own source.
    expect(screen.getByText(/flowchart LR/)).toBeInTheDocument();
  });

  test("keeps the source, and says why, when it will not parse", async () => {
    // What mermaid really says: which line, the text it choked on, a caret
    // under the character, and what it wanted instead. A real Level 2 map
    // hits this — mermaid reserves `call` as a node id — and the person
    // reading the review is often the one who can fix the diagram.
    render_.mockRejectedValue(
      new Error(
        "Parse error on line 7:\n...call --> logger\n----^\nExpecting 'SEMI', 'NEWLINE', 'SPACE', got 'CALLBACKNAME'",
      ),
    );
    render(<Diagram code={MAP} source={source} />);

    expect(await screen.findByText(/Not drawn/)).toBeVisible();
    expect(screen.getByText(/CALLBACKNAME/)).toBeInTheDocument();
    expect(screen.getByText(/flowchart LR/)).toBeInTheDocument();
    // Everything but the thirty token names mermaid would also have taken.
    expect(screen.queryByText(/'SEMI'/)).toBeNull();
  });

  test("draws it again when the theme is switched", async () => {
    render(<Diagram code={MAP} source={source} />);
    await waitFor(() => {
      expect(render_).toHaveBeenCalledTimes(1);
    });

    // The colours reached mermaid as values, so the drawing on screen is
    // still the light one until it is made again.
    document.documentElement.dataset["theme"] = "dark";
    await waitFor(() => {
      expect(render_).toHaveBeenCalledTimes(2);
    });
    delete document.documentElement.dataset["theme"];
  });

  test("hands mermaid the page's own palette, not a formula", async () => {
    render(<Diagram code={MAP} source={source} />);
    await waitFor(() => {
      expect(initialize).toHaveBeenCalled();
    });

    const config = initialize.mock.calls[0]?.[0] as {
      themeVariables: Record<string, string>;
      securityLevel: string;
    };
    // jsdom resolves no stylesheet, so the values are empty here; what this
    // checks is that every one of them is a value and not a `color-mix(...)`
    // that would reach an SVG attribute as text.
    for (const value of Object.values(config.themeVariables)) {
      expect(value).not.toMatch(/color-mix/);
    }
    expect(config.securityLevel).toBe("strict");
  });
});
