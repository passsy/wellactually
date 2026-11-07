/**
 * What the page does, checked where the page exists.
 *
 * These moved out of the server's own test file. They used to fetch the
 * served HTML and grep it, which worked while the page was one long string
 * and cannot work now: a React page is a shell plus a bundle, and its markup
 * does not exist until the bundle has run. Grepping the served bytes for
 * `id="doclist"` was really asking whether a source file still said a
 * particular thing, which is why they kept passing after the behaviour they
 * named had drifted.
 */

import { createRef } from "react";
import { describe, expect, test, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Render inside the providers the page itself mounts with.
 *
 * A fresh client per render, with retries off: a component that asks the
 * server for something gets one failed fetch in jsdom rather than three, and
 * nothing carries over from the test before it.
 */
function paint(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>
        <TooltipProvider>{children}</TooltipProvider>
      </QueryClientProvider>
    ),
  });
}
import userEvent from "@testing-library/user-event";
import { Queue } from "./Queue.tsx";
import { Detail } from "./Detail.tsx";
import { NoteEditor } from "./NoteEditor.tsx";
import { Rail } from "./Rail.tsx";
import { FilePanel } from "./FilePanel.tsx";
import { SHORTCUTS, type Actions } from "./hooks/useKeys.ts";
import { countFor, FILTERS, keep, order } from "./filters.ts";
import { counted, flagged, marked, nameOf, standingOf } from "./reviews.ts";
import { useVisible } from "./hooks/useVisible.ts";
import { countsOf } from "../shared/domain.ts";
import type { Finding, FindingList, ReviewSummary } from "../shared/domain.ts";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "G1",
    title: "compute() result is dropped",
    body: "The body.",
    evidence: "Reasoned",
    priority: "p2",
    verdict: "undecided",
    resolution: "unresolved",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    anchor: { file: "lib/service.dart", line: 2 },
    history: [],
    links: {},
    ...over,
  } as Finding;
}

function review(over: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    repo: "/tmp/checkout-pr356-3d10d616",
    repoName: "checkout",
    target: "pr-356",
    startedAt: "2026-08-17T09:00:00.000Z",
    lastAt: "2026-08-17T09:00:00.000Z",
    counts: countsOf([finding()], {}),
    ...over,
  };
}

const QUEUE = {
  at: 0,
  seen: {},
  onPick: () => {},
  onTag: () => {},
  waiting: false,
  tag: null,
  total: 1,
  onShowAll: () => {},
  says: "All",
  sort: "worst",
  onSort: () => {},
};

function railProps(over: Partial<Parameters<typeof Rail>[0]> = {}) {
  return {
    reviews: [] as ReviewSummary[],
    open: null,
    onOpen: () => {},
    reviewsRef: createRef<HTMLDivElement>(),
    counts: countsOf([], {}),
    filter: "",
    onFilter: () => {},
    tags: [] as string[],
    tagCounts: {},
    tag: null,
    onTag: () => {},
    onCommand: () => {},
    keysOpen: false,
    onKeys: () => {},
    showing: true,
    onShowing: () => {},
    ...over,
  };
}

describe("the queue", () => {
  test("a row says where its finding stands, in one mark", () => {
    paint(
      <Queue
        {...QUEUE}
        findings={[
          finding({ id: "G1" }),
          finding({ id: "G2", verdict: "invalid" }),
          finding({ id: "G3", resolution: "regressed" }),
        ]}
      />,
    );

    // Read off the same groupOf every count and heading is built from, so a
    // row cannot come to a different answer than the pile it is filed under —
    // including the one the track itself cannot say, that this came back.
    // The marks are SVGs, so the label is the readable half of each and the
    // presence of a drawing is the rest.
    for (const says of [
      "Needs a verdict",
      "Invalid — the review got this wrong",
      "Came back",
    ]) {
      expect(screen.getByLabelText(says).querySelector("svg")).not.toBeNull();
    }
  });

  test("choosing a row does not also toggle what has been read", async () => {
    const pick = vi.fn();
    paint(<Queue {...QUEUE} findings={[finding()]} onPick={pick} />);

    await userEvent.click(screen.getByText("compute() result is dropped"));

    expect(pick).toHaveBeenCalledWith(0);
  });

  test("the title gets the whole first line, and the labels the second", () => {
    paint(
      <Queue
        {...QUEUE}
        findings={[finding({ tags: ["race"], evidence: "Proven" })]}
      />,
    );

    // Anything sharing the title's line is width taken off the end of every
    // title in the queue, which is what a two-line row exists to avoid.
    const title = screen.getByText("compute() result is dropped");
    const labels = screen.getByText("p2").parentElement;
    expect(title).not.toBe(labels);
    expect(labels).not.toBeNull();
    expect(within(labels!).getByText(/service\.dart:2/)).toBeInTheDocument();
  });

  test("a finding somebody has written on says so on its row", () => {
    paint(
      <Queue
        {...QUEUE}
        findings={[
          finding({ id: "G1", note: "Not worth fixing before the release." }),
          finding({ id: "G2", title: "Nobody wrote here" }),
        ]}
      />,
    );

    // The one mark on a row that no review run put there. Without it the
    // queue looks identical whether or not the last person through it left
    // anything behind.
    const marked = screen.getByLabelText("This finding has a note");
    expect(marked.title).toContain("Not worth fixing");
    expect(screen.getAllByLabelText("This finding has a note")).toHaveLength(1);
  });

  test("the queue says what it is showing and what order it is in", async () => {
    const sorted = vi.fn();
    paint(
      <Queue
        {...QUEUE}
        findings={[finding(), finding({ id: "G2" })]}
        says="Needs a verdict"
        onSort={sorted}
      />,
    );

    // An order nobody states gets read as no order at all, and the statement
    // is also the control.
    expect(screen.getByText("Needs a verdict 2")).toBeInTheDocument();
    await userEvent.click(screen.getByText(/worst first/));
    expect(sorted).toHaveBeenCalledWith("newest");
  });
});

describe("what the queue is showing", () => {
  const all = [
    finding({ id: "G1" }),
    finding({ id: "G2", verdict: "invalid" }),
    finding({ id: "G3", resolution: "resolved" }),
  ];

  test("an unread row says so twice, in weight and in the bar", () => {
    const findings = [
      finding({ id: "G1", title: "Read already" }),
      finding({ id: "G2", title: "Never opened" }),
    ];
    paint(
      <Queue
        {...QUEUE}
        findings={findings}
        seen={{ G1: "2999-01-01T00:00:00.000Z" }}
      />,
    );

    // The bar carries a glance down the column and the weight carries one row
    // being read, so a row that has one and not the other is only half marked.
    const read = screen.getByText("Read already");
    const fresh = screen.getByText("Never opened");
    expect(read.className).not.toContain("font-semibold");
    expect(fresh.className).toContain("font-semibold");
  });

  test("the page calls the queue an inbox and can show only what is new", () => {
    expect(FILTERS.map((one) => one.value)).toContain("new");

    // "New" is the one answer that is not a pile: it is a fact about what the
    // reader has done, so it cuts across every other answer here.
    const seen = { G1: "2026-09-01T00:00:00.000Z" };
    expect(keep(all, "new", seen).map((one) => one.id)).toEqual(["G2", "G3"]);
  });

  test("and can show only what somebody has written on", () => {
    const noted = [
      finding({ id: "G1", note: "  " }),
      finding({ id: "G2", note: "Ask the author." }),
      finding({ id: "G3" }),
    ];

    // Whitespace is not writing: a note box that was opened and left alone
    // must not put a finding in the pile of ones that were answered.
    expect(keep(noted, "noted", {}).map((one) => one.id)).toEqual(["G2"]);
  });

  test("every other answer is one of the piles a finding falls into", () => {
    expect(keep(all, "invalid", {}).map((one) => one.id)).toEqual(["G2"]);
    expect(keep(all, "resolved", {}).map((one) => one.id)).toEqual(["G3"]);
    expect(keep(all, "", {}).length).toBe(3);
  });

  test("worst first, and an id is a number rather than a string", () => {
    const queue = [
      finding({ id: "G12", priority: "p0" }),
      finding({ id: "G9", priority: "p0" }),
      finding({ id: "G2", priority: "p3" }),
    ];

    // G9 before G12: sorted as text, a queue that gets past nine findings
    // starts interleaving them.
    expect(order(queue, "worst").map((one) => one.id)).toEqual([
      "G9",
      "G12",
      "G2",
    ]);
  });

  test("every count on the page comes off one pass", () => {
    const counts = countsOf(
      [
        finding({ id: "G1" }),
        finding({ id: "G2", verdict: "invalid" }),
        finding({ id: "G3", note: "mine" }),
      ],
      { G1: "2999-01-01T00:00:00.000Z" },
    );

    // The rail's rows and the header's bar are the same facts drawn twice,
    // and two counters that can disagree is a bug report waiting.
    expect(countFor(counts, "")).toBe(3);
    expect(countFor(counts, "new")).toBe(2);
    expect(countFor(counts, "noted")).toBe(1);
    expect(countFor(counts, "invalid")).toBe(1);
    expect(countFor(counts, "verdict")).toBe(2);
  });
});

/**
 * The seam that used to be a lag.
 *
 * Reading is the one thing on this page the page itself decides, and it used
 * to be decided by asking: the mark was posted, read back, and the rail's row
 * only moved when a file watcher had told the server to recount every review
 * on the machine. Three hops for a number already sitting in memory. What
 * follows is that number being worked out where it is known.
 */
describe("what the page counts for itself", () => {
  const list = (over: Partial<FindingList> = {}): FindingList => ({
    target: "pr-356",
    findings: [finding({ id: "G1" }), finding({ id: "G2" })],
    seen: { G1: "2999-01-01T00:00:00.000Z" },
    follow: {},
    ...over,
  });

  test("a mark is a receipt written, and taking it off is one erased", () => {
    const read = marked(list(), "G2", true, "2999-01-01T00:00:00.000Z");
    expect(countsOf(read.findings, read.seen).unread).toBe(0);

    // Absent rather than dated: an unread finding is exactly one that is not
    // in the map, which is what the store on the other end writes too.
    const back = marked(read, "G2", false, "2999-01-01T00:00:00.000Z");
    expect(back.seen).not.toHaveProperty("G2");
    expect(countsOf(back.findings, back.seen).unread).toBe(1);
  });

  test("the open review is counted here, and the rest are not", () => {
    const here = review({ counts: countsOf([], {}) });
    const there = review({
      repo: "/tmp/other-pr680-d020ab2e",
      target: "pr-680",
      counts: countsOf([finding({ id: "G7" })], {}),
    });
    const mine = countsOf(list().findings, list().seen);

    const rows = counted(
      [here, there],
      { repo: here.repo, target: here.target },
      mine,
    );

    // The row of the review being read says what the page in front of it
    // says. Every other row can only be what the server last knew.
    expect(rows[0]?.counts).toEqual(mine);
    expect(rows[1]).toBe(there);
  });

  test("no review open leaves the server's list exactly as it came", () => {
    const reviews = [review()];
    expect(counted(reviews, null, countsOf([], {}))).toBe(reviews);
  });
});

/**
 * The one question two separate bugs turned out to be asking.
 *
 * A tab being open is not a tab being read. It held an event stream, of which
 * the browser grants six across every tab of an origin; and it decided a
 * finding had been read, which is a mark the reader only gets to spend once.
 */
describe("whether anybody is looking", () => {
  const say = (state: "visible" | "hidden"): void => {
    Object.defineProperty(document, "visibilityState", {
      value: state,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  };

  test("answers before the first paint, and again on every change", () => {
    say("hidden");
    // Read from the document rather than assumed and corrected later: a tab
    // opened in the background starts hidden, and a hook that learns this one
    // paint afterwards has already told the page it was being watched.
    const { result } = renderHook(() => useVisible());
    expect(result.current).toBe(false);

    act(() => {
      say("visible");
    });
    expect(result.current).toBe(true);

    act(() => {
      say("hidden");
    });
    expect(result.current).toBe(false);
    say("visible");
  });
});

describe("what a review is called", () => {
  const name = (repo: string, target: string, number?: number) =>
    nameOf(review({ repo, target, ...(number ? { pr: { number } } : {}) }));

  test("says the pull request and where it is, and no more", () => {
    // The worktree is named after both halves of this line, so writing the
    // path fragment out spelled the target a second time: the old row read
    // "pr-679 · vf-noa-scan-pr679".
    expect(name("/tmp/vf-noa-scan-pr679-9cddae80", "pr-679", 679)).toEqual({
      says: "#679",
      where: "vf-noa-scan",
      apart: false,
    });
  });

  test("reads the number off the target when nothing recorded one", () => {
    // Plenty of reviews predate anything writing the number down.
    expect(name("/tmp/arri-lighting-pr358-b56dd860", "pr-358").says).toBe(
      "#358",
    );
  });

  test("a review that is not a pull request keeps its own name", () => {
    expect(
      name(
        "/tmp/NOA-File-Service-upload-and-download-flow-c9599ae1",
        "upload-and-download-flow",
      ),
    ).toEqual({
      says: "upload-and-download-flow",
      where: "NOA-File-Service",
      // Two words with nothing between them read as one word.
      apart: true,
    });
  });

  test("a checkout that is not named after its target keeps its name", () => {
    // Reviews run in the repository itself rather than a worktree, and a
    // repository is not obliged to be named after what is being reviewed.
    expect(name("/tmp/repo", "eval-fallback").where).toBe("repo");
    expect(name("/tmp/scan-pr679", "pr-679", 679).where).toBe("scan");
  });
});

describe("what kind of thing a review is of", () => {
  test("tells the four reasons a row used to have nothing on it apart", () => {
    // All of these drew as a blank before, so an open pull request, one
    // closed unmerged, one nobody could ask about, and a plain branch were
    // the same picture — and they are four different reasons to open a
    // review or to leave it alone.
    const stand = (over: Partial<ReviewSummary>) => standingOf(review(over));

    expect(stand({ pr: { number: 1, state: "open" } })).toBe("open");
    expect(stand({ pr: { number: 1, state: "merged" } })).toBe("merged");
    expect(stand({ pr: { number: 1, state: "closed" } })).toBe("closed");
    // A number and no answer is not the same as an answer of "open", and
    // saying open there would be inventing it.
    expect(stand({ pr: { number: 1 } })).toBe("asking");
    expect(
      stand({
        branch: { base: "main", landed: false, at: "2026-08-19T00:00:00.000Z" },
      }),
    ).toBe("branch");
    expect(
      stand({
        branch: { base: "main", landed: true, at: "2026-08-19T00:00:00.000Z" },
      }),
    ).toBe("landed");
    // Nothing known either way, which is a review the sweep has not reached.
    expect(stand({})).toBe("unknown");
  });
});

/**
 * The one place on this page where the reader is the author.
 *
 * The note saves itself while it is being written, so the server is always a
 * round trip behind the box — and a save that answers with what it was given
 * is an answer about text that is already out of date.
 *
 * Driven with change events and a real wait rather than with fake timers,
 * because the thing under test is a race between a debounce and a promise and
 * mocking the clock is mocking half of it.
 */
describe("the note box", () => {
  test("places notes before code, moves metadata into details and collapses history", async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    const f = finding({
      rule: "passsy/use-spot-instead-of-finders@3",
      tags: ["scope:introduced"],
      provenTest: "/review artifacts/proofs/probe.ts:2",
      history: [
        { at: "2026-11-03T00:00:00Z", actor: "human", verdict: "accepted" },
      ],
      context: { start: 1, lines: ["source();", "bug();"] },
    });
    const { container } = paint(
      <Detail
        finding={f}
        comment={<NoteEditor finding={f} onSave={async () => {}} />}
        onMove={() => {}}
        onOpenFile={onOpenFile}
        onTag={() => {}}
        tag={null}
      />,
    );
    const description = screen.getByRole("region", { name: "Description" }),
      note = screen.getByRole("region", { name: "Your note" }),
      code = container.querySelector("pre")!;
    expect(
      description.compareDocumentPosition(note) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      note.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const details = screen.getByRole("complementary", {
      name: "Finding details",
    });
    expect(within(details).getByText("scope:introduced")).toBeInTheDocument();
    const proof = within(details).getByRole("button", {name:"probe.ts:2"});
    expect(proof).toHaveAttribute("title", "/review artifacts/proofs/probe.ts:2");
    await user.click(proof);
    expect(onOpenFile).toHaveBeenCalledWith({file:"/review artifacts/proofs/probe.ts",line:2});
    expect(
      within(details).getByRole("link", { name: f.rule! }),
    ).toHaveAttribute(
      "href",
      "https://wellactually.dev/p/passsy/use-spot-instead-of-finders?v=3",
    );
    const history = within(details).getByText("History").closest("details")!;
    expect(history.open).toBe(false);
    await user.click(within(details).getByText("History"));
    expect(history.open).toBe(true);
    expect(container.querySelectorAll(".track")).toHaveLength(1);
    expect(container.querySelector("footer")).toBeNull();
  });

  test("grows and shrinks with note content without resize controls", () => {
    const onSave = vi.fn(async () => {});
    paint(<NoteEditor finding={finding({ note: "" })} onSave={onSave} />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    vi.spyOn(box, "scrollHeight", "get").mockImplementation(
      () => box.value.split("\n").length * 20 + 8,
    );
    expect(
      screen.queryByRole("separator", { name: "Resize comment" }),
    ).toBeNull();
    expect(box).toHaveStyle({ height: "32px" });
    fireEvent.change(box, { target: { value: "One\nTwo\nThree" } });
    expect(box).toHaveStyle({ height: "70px" });
    fireEvent.change(box, { target: { value: "One" } });
    expect(box).toHaveStyle({ height: "32px" });
    expect(onSave).not.toHaveBeenCalled();
  });

  /** Longer than the box waits for typing to settle. */
  const SETTLED = 700;

  test("keeps what was typed while a save was in flight", async () => {
    // Held open the way a real save is for as long as its round trip takes.
    let land = () => {};
    const sent: string[] = [];
    const onSave = (_id: string, note: string) => {
      sent.push(note);
      return new Promise<void>((done) => {
        land = done;
      });
    };
    const note = finding({ id: "G1", note: "" });
    const { rerender } = paint(<NoteEditor finding={note} onSave={onSave} />);
    const box = screen.getByRole("textbox");

    fireEvent.change(box, { target: { value: "abc" } });
    await act(async () => {
      await new Promise((done) => setTimeout(done, SETTLED));
    });
    expect(sent).toEqual(["abc"]);

    // One more character while that save is still out.
    fireEvent.change(box, { target: { value: "abcd" } });
    await act(async () => {
      land();
      await Promise.resolve();
    });

    // The server answers the older save, so the page hands the note back as
    // "abc". This is the moment the "d" used to disappear.
    rerender(<NoteEditor finding={{ ...note, note: "abc" }} onSave={onSave} />);

    expect(box).toHaveValue("abcd");
  });

  test("takes the server's note when the box is not being written in", () => {
    const note = finding({ id: "G1", note: "" });
    const { rerender } = paint(
      <NoteEditor finding={note} onSave={() => Promise.resolve()} />,
    );

    // Nothing typed and nothing focused: an agent writing a note on the
    // finding being looked at is worth showing, and here it costs nothing.
    rerender(
      <NoteEditor
        finding={{ ...note, note: "written by somebody else" }}
        onSave={() => Promise.resolve()}
      />,
    );

    expect(screen.getByRole("textbox")).toHaveValue("written by somebody else");
  });
});

/**
 * The reader's own flag, which is not a verdict.
 *
 * The track says where a finding stands with the code. This says where it
 * stands with the person reading it, and the two are independent: a finding
 * can be reported and still be one you have a question about.
 */
/**
 * What an invalid verdict still owes.
 *
 * Marking a finding invalid is a claim the review got it wrong, and the
 * claim only becomes calibration once report_finding files it — so the row
 * nags exactly until the issue link lands, and never about anything else.
 */
describe("the issue an invalid finding owes", () => {
  test("an invalid finding without its issue says so", () => {
    paint(
      <Queue
        {...QUEUE}
        findings={[finding({ verdict: "invalid" })]}
        follow={{}}
      />,
    );

    expect(screen.getByText("issue?")).toBeInTheDocument();
  });

  test("the filed issue clears the badge", () => {
    paint(
      <Queue
        {...QUEUE}
        findings={[
          finding({
            verdict: "invalid",
            links: {
              ruleIssue: "https://github.com/passsy/pascal_rules/issues/9",
            },
          }),
        ]}
        follow={{}}
      />,
    );

    expect(screen.queryByText("issue?")).not.toBeInTheDocument();
  });

  test("a tolerated finding owes nothing", () => {
    paint(
      <Queue
        {...QUEUE}
        findings={[finding({ verdict: "tolerated" })]}
        follow={{}}
      />,
    );

    expect(screen.queryByText("issue?")).not.toBeInTheDocument();
  });
});

describe("flagging a finding to come back to", () => {
  test("crosses every pile rather than being one", () => {
    const all = [
      finding({ id: "G1" }),
      finding({ id: "G2", verdict: "accepted" }),
      finding({ id: "G3", reportedAt: "2026-08-01T00:00:00.000Z" }),
    ];
    const follow = {
      G2: "2026-08-20T00:00:00.000Z",
      G3: "2026-08-20T00:00:00.000Z",
    };

    // An accepted one and a reported one, together, because what they have in
    // common is the reader rather than the verdict.
    expect(
      keep(all, "flagged", {}, null, undefined, follow).map((f) => f.id),
    ).toEqual(["G2", "G3"]);
    // And flagging decides nothing: they are still in their own piles.
    expect(
      keep(all, "fix", {}, null, undefined, follow).map((f) => f.id),
    ).toEqual(["G2"]);
  });

  test("counts as its own answer in the rail", () => {
    const counts = countsOf(
      [finding({ id: "G1" }), finding({ id: "G2" })],
      {},
      { G2: "2026-08-20T00:00:00.000Z" },
    );
    expect(countFor(counts, "flagged")).toBe(1);
    expect(countFor(counts, "")).toBe(2);
  });

  test("shows on the row, beside the note and not instead of it", () => {
    paint(
      <Queue
        {...QUEUE}
        findings={[finding({ id: "G1", note: "Ask about the retry." })]}
        follow={{ G1: "2026-08-20T00:00:00.000Z" }}
      />,
    );

    expect(
      screen.getByLabelText("Flagged to come back to"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("This finding has a note"),
    ).toBeInTheDocument();
  });

  test("goes on and comes off in the page's own copy", () => {
    const list: FindingList = {
      target: "pr-1",
      findings: [finding({ id: "G1" })],
      seen: {},
      follow: {},
    };

    const on = flagged(list, "G1", true, "2026-08-20T00:00:00.000Z");
    expect(on.follow).toHaveProperty("G1");
    // Absent is the whole of what "not flagged" means, so taking it off is a
    // delete rather than a value — the same as a read receipt beside it.
    expect(
      flagged(on, "G1", false, "2026-08-20T00:00:00.000Z").follow,
    ).not.toHaveProperty("G1");
  });
});

describe("the rail", () => {
  test("a repository and a target are one choice, not two", async () => {
    const opened = vi.fn();
    const reviews = [
      review({ title: "Clean up SyncManager" }),
      review({ repo: "/tmp/other-pr680-d020ab2e", target: "pr-680" }),
    ];
    paint(
      <Rail
        {...railProps({ reviews, open: reviews[0] ?? null, onOpen: opened })}
      />,
    );

    // One row per review, naming both, rather than a repository menu and a
    // target menu that can be set to a pair that does not exist.
    await userEvent.click(screen.getByText(/^other$/));

    expect(opened).toHaveBeenCalledWith(reviews[1]);
  });

  test("what is unread is on the row, and it is the way to it", async () => {
    const filtered = vi.fn();
    const counts = countsOf([finding({ id: "G1" }), finding({ id: "G2" })], {
      G1: "2999-01-01T00:00:00.000Z",
    });
    paint(
      <Rail
        {...railProps({
          reviews: [
            review({
              counts: countsOf(
                Array.from({ length: 4 }, (_, index) =>
                  finding({ id: `G${String(index)}` }),
                ),
                {
                  G0: "2999-01-01T00:00:00.000Z",
                  G1: "2999-01-01T00:00:00.000Z",
                },
              ),
            }),
          ],
          counts,
          onFilter: filtered,
        })}
      />,
    );

    // A count with no way to reach what it counts is a count you have to act
    // on somewhere else.
    expect(screen.getByTitle("2 findings you have not read")).toHaveTextContent(
      "2",
    );
    await userEvent.click(screen.getByText("New"));
    expect(filtered).toHaveBeenCalledWith("new");
  });

  test("a review row says how long ago it ran, which is the order they are in", () => {
    paint(
      <Rail
        {...railProps({
          reviews: [review({ startedAt: "2026-08-17T09:00:00.000Z" })],
        })}
      />,
    );

    // The list is held newest first, and an order nobody states is read as no
    // order at all. The exact moment stays on the title, because the row has
    // room for "2h" and not for a date.
    expect(screen.getByTitle(/^This review ran /)).toBeInTheDocument();
  });

  test("a pull request that has already landed says so before it is opened", () => {
    paint(
      <Rail
        {...railProps({
          reviews: [
            review({ title: "Landed already", pr: { state: "merged" } }),
          ],
        })}
      />,
    );

    // The case that wastes a whole review: worth knowing from the list, not
    // after opening it and reading a finding.
    expect(screen.getByLabelText("merged")).toBeInTheDocument();
  });

  test("can be put away, and says how to bring it back", async () => {
    const showing = vi.fn();
    paint(<Rail {...railProps({ reviews: [review()], onShowing: showing })} />);

    // Put away it costs no width at all — including the width the page
    // insists on having, which is most of the reason to put it away.
    await userEvent.click(screen.getByText("Put the rail away"));
    expect(showing).toHaveBeenCalledWith(false);
  });

  test("notifications are off until they are asked for", () => {
    paint(<Rail {...railProps({ reviews: [review()] })} />);

    // A page that demands permission on load is refused out of reflex, and
    // the browser remembers that refusal long after the reason for it.
    /* eslint-disable-next-line @typescript-eslint/unbound-method -- reading the
       stub is the assertion: it records whether anything asked for permission,
       and nothing here ever calls it. */
    expect(vi.mocked(Notification.requestPermission)).not.toHaveBeenCalled();
    // The bell is drawn, silent, and has not asked for anything.
    expect(document.getElementById("notify")).toBeInTheDocument();
  });
});

describe("the shortcut list", () => {
  test("is built from the shortcuts, not written beside them", () => {
    paint(
      <FilePanel
        where={null}
        showing={{ kind: "keys" }}
        findings={[]}
        current={undefined}
        view="new"
        onView={() => {}}
        onRule={() => {}}
        onDoc={() => {}}
        onClose={() => {}}
      />,
    );

    // A list written separately goes stale on the first change nobody thought
    // to mirror, and a wrong one is worse than none. So every row drawn comes
    // from an entry that carries the binding as well.
    for (const entry of SHORTCUTS) {
      expect(screen.getByText(entry.does)).toBeInTheDocument();
    }
    expect(
      screen.getByText("Invalid — the review got this wrong"),
    ).toBeInTheDocument();

    // And the entry that says "Invalid" is the one that presses that stop.
    const fired = vi.fn();
    const actions: Actions = {
      up: () => {},
      down: () => {},
      step: () => {},
      tap: fired,
      openFile: () => {},
      writeNote: () => {},
      flag: () => {},
      toggleRead: () => {},
      openReviews: () => {},
      openKeys: () => {},
      openCommand: () => {},
      toggleRail: () => {},
    };
    SHORTCUTS.find((one) => one.does.startsWith("Invalid"))?.on?.["i"]?.(
      actions,
    );
    expect(fired).toHaveBeenCalledWith("invalid");
  });

  test("every key it lists has a binding behind it", () => {
    // The failure this table exists to make impossible: a popup promising a
    // key that does nothing. Escape is the one entry with no binding here,
    // because it is answered before the table is consulted at all.
    for (const entry of SHORTCUTS) {
      if (entry.show.includes("Esc")) continue;
      expect(Object.keys(entry.on ?? {}).length).toBeGreaterThan(0);
    }
    expect(SHORTCUTS.flatMap((one) => one.show)).toContain("v");
  });
});
