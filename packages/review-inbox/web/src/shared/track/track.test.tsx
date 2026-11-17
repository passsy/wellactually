/**
 * What the track promises, minus the dragging.
 *
 * A pointer drag cannot be tested here in any way worth trusting: the whole
 * control is measured off `offsetLeft` and `offsetWidth`, and jsdom reports
 * both as zero, so a passing drag test would only prove that zero is zero.
 * Dragging is checked in a browser against the running page; what is here is
 * everything that is a function of the props.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Track, type TrackStop } from "./Track.tsx";

const STOPS: TrackStop[] = [
  { to: "dismissed", mark: "✕", says: "Dismissed" },
  { to: "open", mark: "○", says: "Undecided" },
  { to: "accepted", mark: "⚑", says: "Accepted" },
  { to: "reported", mark: "↗", says: "Reported" },
  { to: "fixed", mark: "✔", says: "Fixed" },
];

const draw = (props: Partial<Parameters<typeof Track>[0]> = {}) =>
  render(<Track stops={STOPS} at={1} onPick={() => undefined} {...props} />);

describe("the board and what is on it", () => {
  it("bores one hole per stop, engraved with what it means", () => {
    draw();
    const holes = screen.getAllByRole("radio");
    expect(holes).toHaveLength(STOPS.length);
    expect(holes.map((hole) => hole.textContent)).toEqual([
      "✕",
      "○",
      "⚑",
      "↗",
      "✔",
    ]);
  });

  it("checks the hole the head is in, and only that one", () => {
    draw({ at: 2 });
    const checked = screen
      .getAllByRole("radio")
      .filter((hole) => hole.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveAttribute("aria-label", "Accepted");
  });

  it("engraves every hole alike, whichever side of the head it is on", () => {
    const { container } = draw({ at: 3 });
    // The pin says where you are. A hole lettered brighter for being behind it
    // says the same thing again, in a shade nobody can name, and leaves the
    // board wearing two greys with no rule between them.
    const marked = [...container.querySelectorAll(".hole")].filter(
      (hole) => hole.className !== "hole" && !hole.classList.contains("at"),
    );
    expect(marked).toHaveLength(0);
  });

  it("leaves a run of plain board where one is asked for", () => {
    const { container } = draw({ blankAfter: [0, 1] });
    expect(container.querySelectorAll(".blank")).toHaveLength(2);
  });
});

describe("the head", () => {
  it("carries the icon of the hole it is sitting in", () => {
    const { container } = draw({ at: 4 });
    expect(container.querySelector(".head")).toHaveTextContent("✔");
  });

  it("stays out of the accessibility tree, being the same fact twice", () => {
    const { container } = draw();
    expect(container.querySelector(".head")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});

describe("what a flag says that a position cannot", () => {
  it("replaces the mark on the hole it names", () => {
    draw({
      at: 1,
      flag: { index: 4, mark: "⚠", says: "Came back" },
    });
    expect(screen.getByLabelText("Came back")).toHaveTextContent("⚠");
  });

  it("marks the hole it names, and only that one", () => {
    const { container } = draw({
      at: 1,
      flag: { index: 4, mark: "⚠", says: "Came back" },
    });
    expect(container.querySelectorAll(".hole.flagged")).toHaveLength(1);
  });
});

describe("saying what is under the cursor", () => {
  it("names a hole while the pointer rests on it, and stops when it leaves", async () => {
    const { container } = draw({ at: 1 });
    const fixed = screen.getByLabelText("Fixed");

    expect(container.querySelector(".hint")).toBeNull();
    await userEvent.hover(fixed);
    expect(container.querySelector(".hint")).toHaveTextContent("Fixed");
    await userEvent.unhover(fixed);
    expect(container.querySelector(".hint")).toBeNull();
  });

  it("names the stop the head is in, which is the one it covers", async () => {
    // The pin sits over its own hole, so without this the one stop nobody
    // can get a word out of is the one they are on.
    const { container } = draw({ at: 2 });

    await userEvent.hover(container.querySelector(".head")!);

    expect(container.querySelector(".hint")).toHaveTextContent("Accepted");
  });

  it("says what a flagged hole means rather than what its stop means", async () => {
    const { container } = draw({
      at: 1,
      flag: { index: 4, mark: "⚠", says: "Came back" },
    });

    await userEvent.hover(screen.getByLabelText("Came back"));

    expect(container.querySelector(".hint")).toHaveTextContent("Came back");
  });
});

describe("pressing a hole", () => {
  it("sends the head there", async () => {
    const picked = vi.fn();
    draw({ at: 1, onPick: picked });
    await userEvent.click(screen.getByLabelText("Fixed"));
    expect(picked).toHaveBeenCalledWith("fixed");
  });

  it("does nothing when it is the hole the head is already in", async () => {
    const picked = vi.fn();
    draw({ at: 1, onPick: picked });
    await userEvent.click(screen.getByLabelText("Undecided"));
    expect(picked).not.toHaveBeenCalled();
  });
});
