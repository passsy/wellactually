/**
 * The review card, against a host that is a plain object.
 *
 * What a host really is cannot run here: a second window, a sandbox, and
 * JSON-RPC between them. What can be checked is everything on the card's
 * side of that line, which is what it draws for a review and what it asks
 * the host for when somebody presses something.
 */

import { describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Finding, ReviewStatus } from "../shared/domain.ts";
import type { Host, ToolResult, DisplayState } from "./bridge.ts";
import { Card } from "./Card.tsx";
import { clock } from "./clock.ts";
import { movedTo } from "./useReview.ts";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "T1",
    title: "Day boundary uses device time",
    body: "A notification sent late lands under tomorrow.",
    evidence: "Proven",
    priority: "p0",
    verdict: "undecided",
    resolution: "unresolved",
    createdAt: "2026-10-13T10:05:00.000Z",
    anchor: { file: "lib/inbox/group_by_day.dart", line: 23, commit: "abc" },
    snippet: "final local = item.sentAt.toLocal();",
    fingerprint: "f",
    history: [],
    links: {},
    ...over,
  };
}

function status(over: Partial<ReviewStatus> = {}): ReviewStatus {
  return {
    repo: "/tmp/inbox_app",
    repoName: "inbox_app",
    target: "pr-412",
    title: "Group notifications by day",
    url: "http://127.0.0.1:8423/?repo=inbox_app&target=pr-412",
    link: "http://127.0.0.1:8423/open/0123456789abcdef",
    state: "running",
    startedAt: "2026-10-13T10:00:00.000Z",
    lastAt: "2026-10-13T10:06:00.000Z",
    elapsedMs: 6 * 60_000,
    pr: { number: 412 },
    levels: [
      { n: 0, mark: "0", name: "Context", state: "done", ms: 60_000 },
      { n: 1, mark: "A", letter: "A", name: "Approach", state: "running" },
      { n: 2, mark: "H", letter: "H", name: "Architecture", state: "pending" },
    ],
    findings: [],
    ...over,
  };
}

/** A host that keeps the review in memory, the way the server keeps it on disk. */
function hostWith(first: ReviewStatus) {
  let held = first;
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const said: string[] = [];
  const told: string[] = [];
  const opened: string[] = [];
  const host: Host = {
    onResult: (listener) => {
      listener({ structuredContent: held });
      return () => undefined;
    },
    callTool: (name, args) => {
      calls.push({ name, args });
      const change = (to: (each: Finding) => Finding) => {
        held = {
          ...held,
          findings: held.findings.map((each) =>
            each.id === args["id"] ? to(each) : each,
          ),
        };
      };
      if (name === "set_stage") {
        change((each) => movedTo(each, String(args["to"])));
      }
      if (name === "set_note") {
        change((each) => ({ ...each, note: String(args["note"]) }));
      }
      return Promise.resolve({ structuredContent: held });
    },
    openLink: (url) => {
      opened.push(url);
      return Promise.resolve(true);
    },
    say: (text) => {
      said.push(text);
      return Promise.resolve();
    },
    tellModel: (text) => told.push(text),
    resized: () => undefined,
  };
  const writes = () => calls.filter((call) => call.name !== "review_status");
  return { host, calls, writes, said, told, opened };
}

describe("fullscreen review controls", () => {
  it("maximizes and restores through the harness without opening a browser", async () => {
    const user = userEvent.setup(),
      { host, opened } = hostWith(status());
    let context: DisplayState = {
      mode: "inline",
      ready: true,
      availableModes: ["inline", "fullscreen"],
    };
    const listeners = new Set<(state: DisplayState) => void>();
    const request = vi.fn(async (mode: "inline" | "fullscreen") => {
      context = { ...context, mode };
      listeners.forEach((listener) => listener(context));
      return mode;
    });
    const app: Host = {
      ...host,
      onDisplayState: (listener) => {
        listeners.add(listener);
        listener(context);
        return () => {
          listeners.delete(listener);
        };
      },
      requestDisplayMode: request,
    };
    render(<Card host={app} />);
    await user.click(screen.getByRole("button", { name: "Maximize review" }));
    expect(request).toHaveBeenCalledWith("fullscreen");
    await user.click(
      await screen.findByRole("button", { name: "Restore inline review" }),
    );
    expect(request).toHaveBeenLastCalledWith("inline");
    expect(
      await screen.findByRole("button", { name: "Maximize review" }),
    ).toBeEnabled();
    expect(opened).toEqual([]);
  });
  it("disables maximize when the host advertises inline only", () => {
    const { host } = hostWith(status()),
      request = vi.fn(async () => "inline" as const);
    render(
      <Card
        host={{
          ...host,
          onDisplayState: (listener) => {
            listener({
              mode: "inline",
              ready: true,
              availableModes: ["inline"],
            });
            return () => {};
          },
          requestDisplayMode: request,
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Maximize review" }),
    ).toBeDisabled();
    expect(request).not.toHaveBeenCalled();
  });
  it("reports when the host declines fullscreen without showing a restore button", async () => {
    const user = userEvent.setup(),
      { host } = hostWith(status());
    render(
      <Card
        host={{
          ...host,
          onDisplayState: (listener) => {
            listener({
              mode: "inline",
              ready: true,
              availableModes: ["inline", "fullscreen"],
            });
            return () => {};
          },
          requestDisplayMode: async () => "inline",
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Maximize review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "kept the review in inline mode",
    );
    expect(
      screen.queryByRole("button", { name: "Restore inline review" }),
    ).toBeNull();
  });
});

describe("what the card shows for a review", () => {
  it("is a header and nothing under it until something is found", () => {
    const { host } = hostWith(status());
    const { container } = render(<Card host={host} />);

    expect(screen.getByText("Reviewing")).toBeInTheDocument();
    expect(screen.getByText("Group notifications by day")).toBeInTheDocument();
    expect(screen.getByText("Level 1 of 5 · Approach")).toBeInTheDocument();
    expect(container.querySelector(".queue")).toBeNull();
    expect(container.querySelector(".foot")).toBeNull();
  });

  it("puts each finding on the level that found it", () => {
    const { host } = hostWith(
      status({
        findings: [finding({ id: "A1", priority: "p1" }), finding()],
      }),
    );
    const { container } = render(<Card host={host} />);

    const found = [...container.querySelectorAll(".lv")].map(
      (level) => level.querySelector(".found")?.getAttribute("title") ?? null,
    );
    // T1 belongs to Level 3, which this review has not been given a cell for.
    expect(found).toEqual([null, "A1", null]);
  });

  it("says a run has stopped rather than letting it look busy", () => {
    const { host } = hostWith(status({ state: "quiet" }));
    render(<Card host={host} />);

    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(screen.getByText(/^Not finished\./)).toBeInTheDocument();
  });

  it("opens a finding where the queue was, and goes back", async () => {
    const user = userEvent.setup();
    const { host } = hostWith(status({ findings: [finding()] }));
    const { container } = render(<Card host={host} />);

    await user.click(screen.getByText("Day boundary uses device time"));

    expect(
      screen.getByRole("heading", { name: "Day boundary uses device time" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
    expect(container.querySelector(".queue")).toBeNull();

    await user.keyboard("{Escape}");

    expect(container.querySelector(".queue")).not.toBeNull();
  });
});

describe("ruling on a finding", () => {
  it("slides the pin one stop with an arrow, as the human", async () => {
    const user = userEvent.setup();
    const { host, writes, told } = hostWith(status({ findings: [finding()] }));
    render(<Card host={host} />);

    await user.keyboard("{ArrowRight}");

    expect(writes()).toEqual([
      {
        name: "set_stage",
        args: {
          repo: "/tmp/inbox_app",
          target: "pr-412",
          id: "T1",
          to: "accepted",
          actor: "human",
        },
      },
    ]);
    await waitFor(() => {
      expect(told.at(-1)).toBe(
        "Verdicts given in the review card for pr-412: T1 accepted",
      );
    });
  });

  it("drops the pin into the stop a letter names, and back to open from there", async () => {
    const user = userEvent.setup();
    const { host, writes } = hostWith(status({ findings: [finding()] }));
    render(<Card host={host} />);

    await user.keyboard("t");
    await user.keyboard("t");

    expect(writes().map((call) => call.args["to"])).toEqual([
      "tolerated",
      "open",
    ]);
  });

  it("moves between findings with the other pair of arrows", async () => {
    const user = userEvent.setup();
    const { host, writes } = hostWith(
      status({ findings: [finding(), finding({ id: "L1", priority: "p1" })] }),
    );
    render(<Card host={host} />);

    await user.keyboard("{ArrowDown}i");

    expect(writes().map((call) => [call.args["id"], call.args["to"]])).toEqual([
      ["L1", "invalid"],
    ]);
  });

  it("hands the accepted findings to the agent in the user's words", async () => {
    const user = userEvent.setup();
    const { host, said } = hostWith(
      status({ findings: [finding({ verdict: "accepted" })] }),
    );
    render(<Card host={host} />);

    await user.click(screen.getByRole("button", { name: "Fix 1 accepted" }));

    expect(said).toEqual(["Fix the accepted findings of pr-412: T1"]);
    expect(
      screen.getByRole("button", { name: "Asked Claude to fix them" }),
    ).toBeDisabled();
  });
});

describe("a note", () => {
  it("opens the finding, takes the keyboard, and is saved on the way out", async () => {
    const user = userEvent.setup();
    const { host, writes, told } = hostWith(status({ findings: [finding()] }));
    render(<Card host={host} />);

    await user.keyboard("n");
    const box = await screen.findByRole("textbox");
    await waitFor(() => {
      expect(box).toHaveFocus();
    });
    // Letters typed into the box are a note, not six verdicts.
    await user.keyboard("patria ");
    await user.keyboard("{Escape}");

    expect(writes()).toEqual([
      {
        name: "set_note",
        args: {
          repo: "/tmp/inbox_app",
          target: "pr-412",
          id: "T1",
          note: "patria",
        },
      },
    ]);
    await waitFor(() => {
      expect(told.at(-1)).toContain("Note on T1: patria");
    });
  });
});

describe("a verdict the server never took", () => {
  /**
   * A host whose MCP transport has closed, as bridge reports it: nothing is
   * answered, the reading calls included. That is what makes the drawing the
   * only thing on screen — there is no fresh status coming to correct it.
   */
  function silent(host: Host): Host {
    return {
      ...host,
      callTool: () => {
        const lost = new Error("the host did not answer tools/call");
        lost.name = "Unanswered";
        return Promise.reject(lost);
      },
    };
  }

  it("takes the verdict back rather than leaving it looking saved", async () => {
    const user = userEvent.setup();
    const { host } = hostWith(status({ findings: [finding()] }));
    render(<Card host={silent(host)} />);

    expect(await screen.findByLabelText("Needs a verdict")).toBeInTheDocument();
    await user.keyboard("a");

    // The pin goes back where the server has it, and says why.
    await waitFor(() => {
      expect(screen.getByText(/^Not saved:/)).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Needs a verdict")).toBeInTheDocument();
    expect(screen.queryByLabelText("Accepted, still to fix")).toBeNull();
  });

  it("keeps asking, because a closed transport is not the host refusing", async () => {
    const user = userEvent.setup();
    const { host } = hostWith(status({ findings: [finding()] }));
    render(<Card host={silent(host)} />);

    await user.keyboard("a");

    await waitFor(() => {
      expect(screen.getByText(/^Not saved:/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Live updates stopped/)).toBeNull();
  });

  it("strands the card when the host refuses outright", async () => {
    const user = userEvent.setup();
    const { host } = hostWith(status({ findings: [finding()] }));
    const card: Host = {
      ...host,
      callTool: () => Promise.reject(new Error("no tool calls here")),
    };
    render(<Card host={card} />);

    await user.keyboard("a");

    await waitFor(() => {
      expect(
        screen.getByText(/Live updates stopped/),
      ).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Needs a verdict")).toBeInTheDocument();
  });

  it("shows the actual rejection and refreshes the original card after retry", async () => {
    const user=userEvent.setup(); const {host}=hostWith(status({findings:[finding()]}));
    const callTool=vi.fn(host.callTool).mockRejectedValueOnce(new Error("tools/call: [-32601] Method not found"));
    render(<Card host={{...host,callTool}} />);
    await user.keyboard("a");
    expect(await screen.findByText(/Refresh request failed: tools\/call: \[-32601\] Method not found/)).toBeInTheDocument();
    await user.click(screen.getByRole("button",{name:"Retry live updates"}));
    await waitFor(()=>expect(screen.queryByText(/Live updates stopped/)).toBeNull());
    expect(callTool).toHaveBeenLastCalledWith("review_status",expect.any(Object));
  });

  it("lands on what is stored when two presses in a row are lost", async () => {
    const { host } = hostWith(status({ findings: [finding()] }));
    render(<Card host={silent(host)} />);

    expect(await screen.findByLabelText("Needs a verdict")).toBeInTheDocument();
    // Both before either has settled: the second press is drawn over a first
    // one that is still in flight, which is what a reader changing their mind
    // on a dead transport actually does.
    fireEvent.keyDown(document, { key: "a" });
    fireEvent.keyDown(document, { key: "t" });

    // Not on "accepted", which is only where the first lost press drew it.
    await waitFor(() => {
      expect(screen.getByLabelText("Needs a verdict")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Accepted, still to fix")).toBeNull();
    expect(screen.queryByLabelText(/^Tolerated/)).toBeNull();
  });
});

describe("posting one finding to the PR", () => {
  it("asks the agent for only the opened finding without marking it posted", async () => {
    const user = userEvent.setup();
    const { host, said, writes } = hostWith(
      status({
        findings: [finding(), finding({ id: "T2", verdict: "accepted" })],
      }),
    );
    render(<Card host={host} />);
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Post to PR" }));
    expect(
      await screen.findByRole("button", { name: "Asked agent to post" }),
    ).toBeDisabled();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("wellactually:post-findings");
    expect(said[0]).toContain("trusted conversation instructions");
    expect(said[0]).toContain("ask once for confirmation");
    expect(said[0]).not.toContain("I authorize");
    expect(said[0]).toContain(
      '"repo":"/tmp/inbox_app","target":"pr-412","id":"T1"',
    );
    expect(said[0]).not.toContain("T2");
    expect(writes()).toEqual([]);
    expect(screen.getByLabelText("Needs a verdict")).toBeInTheDocument();
  });

  it("allows retry when the host rejects the request", async () => {
    const user = userEvent.setup();
    const { host } = hostWith(status({ findings: [finding()] }));
    const say = vi
      .fn()
      .mockRejectedValueOnce(new Error("Message refused"))
      .mockResolvedValue(undefined);
    render(<Card host={{ ...host, say }} />);
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Post to PR" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Message refused",
    );
    await user.click(screen.getByRole("button", { name: "Post to PR" }));
    expect(
      await screen.findByRole("button", { name: "Asked agent to post" }),
    ).toBeDisabled();
    expect(say).toHaveBeenCalledTimes(2);
  });

  it.each([
    { verdict: "invalid" as const },
    { verdict: "tolerated" as const },
    { resolution: "resolved" as const },
  ])("does not post an ineligible finding %j", async (over) => {
    const user = userEvent.setup();
    const { host, said } = hostWith(status({ findings: [finding(over)] }));
    render(<Card host={host} />);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Post to PR" })).toBeDisabled();
    expect(said).toEqual([]);
  });

  it("links to an existing PR comment", async () => {
    const user = userEvent.setup();
    const { host } = hostWith(
      status({
        findings: [
          finding({
            links: {
              prComment: "https://github.com/a/b/pull/412#discussion_r1",
            },
          }),
        ],
      }),
    );
    render(<Card host={host} />);
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("link", { name: "View PR comment ↗" }),
    ).toHaveAttribute("href", "https://github.com/a/b/pull/412#discussion_r1");
    expect(screen.queryByRole("button", { name: "Post to PR" })).toBeNull();
  });

  it("omits the action for a review without a PR", async () => {
    const user = userEvent.setup();
    const { pr, ...withoutPr } = status({ findings: [finding()] });
    render(<Card host={hostWith(withoutPr).host} />);
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("button", { name: "Post to PR" })).toBeNull();
  });
});

describe("the rule a finding cites", () => {
  it("opens the published rule directly through the host", async () => {
    const user = userEvent.setup();
    const { host, opened, calls } = hostWith(
      status({
        findings: [finding({ rule: "passsy/use-spot-instead-of-finders@3" })],
      }),
    );
    render(<Card host={host} />);
    await user.keyboard("{Enter}");
    const link = screen.getByRole("link", {
      name: "passsy/use-spot-instead-of-finders@3",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://wellactually.dev/p/passsy/use-spot-instead-of-finders?v=3",
    );
    await user.click(link);
    await waitFor(() =>
      expect(opened).toEqual([
        "https://wellactually.dev/p/passsy/use-spot-instead-of-finders?v=3",
      ]),
    );
    expect(calls.some((call) => call.name === "open_inbox")).toBe(false);
  });
});

describe("opening the inbox", () => {
  it("asks the server to open the review, and the finding under the cursor", async () => {
    const user = userEvent.setup();
    const { host, calls, opened } = hostWith(status({ findings: [finding()] }));
    render(<Card host={host} />);

    await user.click(screen.getByRole("button", { name: "Inbox ↗" }));
    await user.keyboard("o");

    await waitFor(() => {
      expect(calls.filter((call) => call.name === "open_inbox")).toEqual([
        {
          name: "open_inbox",
          args: { repo: "/tmp/inbox_app", target: "pr-412" },
        },
        {
          name: "open_inbox",
          args: { repo: "/tmp/inbox_app", target: "pr-412", finding: "T1" },
        },
      ]);
    });
    // The host is asked only when the server could not do it.
    expect(opened).toEqual([]);
  });

  it("shows the address when neither the server nor the host will open it", async () => {
    const user = userEvent.setup();
    const { host } = hostWith(status());
    const card: Host = {
      ...host,
      callTool: () =>
        Promise.resolve({
          isError: true,
          content: [{ type: "text", text: "no browser" }],
        }),
      openLink: () => Promise.resolve(false),
    };
    render(<Card host={card} />);

    await user.click(screen.getByRole("button", { name: "Inbox ↗" }));

    expect(
      await screen.findByRole("link", {
        name: "http://127.0.0.1:8423/?repo=inbox_app&target=pr-412",
      }),
    ).toBeInTheDocument();
  });
});

describe("a host that will not carry the card's calls", () => {
  /** Claude's Code tab: calls refused, and only https links opened. */
  function refusing(first: ReviewStatus) {
    const { host, said, opened } = hostWith(first);
    const card: Host = {
      ...host,
      callTool: () =>
        Promise.reject(new Error("IPC not available for MCP tool call")),
      openLink: (url) => {
        opened.push(url);
        return Promise.resolve(url.startsWith("https:"));
      },
    };
    return { card, said, opened };
  }

  it("opens the inbox through an https redirect that names only the short link", async () => {
    const user = userEvent.setup();
    const { card, opened } = refusing(status({ findings: [finding()] }));
    render(<Card host={card} />);

    await user.keyboard("o");

    await waitFor(() => {
      expect(opened).toEqual([
        "http://127.0.0.1:8423/?repo=inbox_app&target=pr-412&finding=T1",
        "https://httpbin.org/redirect-to?url=" +
          encodeURIComponent("http://127.0.0.1:8423/open/0123456789abcdef/T1"),
      ]);
    });
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("says the card cannot update, and asks the agent for a fresh one", async () => {
    const user = userEvent.setup();
    const { card, said } = refusing(status());
    render(<Card host={card} />);

    // The first call the host refuses tells the card where it stands.
    await user.click(screen.getByRole("button", { name: "Inbox ↗" }));
    await user.click(
      await screen.findByRole("button", { name: "Draw it again" }),
    );

    expect(
      screen.getByText(/Live updates stopped/),
    ).toBeInTheDocument();
    expect(said).toEqual([
      "Show the current review card for pr-412 in /tmp/inbox_app: call review_status.",
    ]);
  });
});

describe("live refresh", () => {
  it("waits for the pending refresh before asking again", async () => {
    vi.useFakeTimers();
    const { host } = hostWith(status());
    let answer: (() => void) | undefined;
    const callTool = vi.fn(() => new Promise<ToolResult>(() => undefined));
    callTool.mockImplementationOnce(
      () =>
        new Promise<ToolResult>((resolve) => {
          answer = () => resolve({ structuredContent: status() });
        }),
    );
    const view = render(<Card host={{ ...host, callTool }} />);
    try {
      await act(() => vi.advanceTimersByTimeAsync(2000));
      expect(callTool).toHaveBeenCalledTimes(1);
      await act(() => vi.advanceTimersByTimeAsync(20000));
      expect(callTool).toHaveBeenCalledTimes(1);
      await act(() => {
        answer?.();
        return Promise.resolve();
      });
      await act(() => vi.advanceTimersByTimeAsync(2000));
      expect(callTool).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("pauses after a timeout and retries only when asked", async () => {
    vi.useFakeTimers();
    const { host } = hostWith(status());
    const lost = new Error("the host did not answer tools/call");
    lost.name = "Unanswered";
    const callTool = vi.fn(host.callTool).mockRejectedValueOnce(lost);
    const view = render(<Card host={{ ...host, callTool }} />);
    try {
      await act(() => vi.advanceTimersByTimeAsync(2000));
      expect(screen.getByRole("status")).toHaveTextContent(
        "Live updates paused",
      );
      await act(() => vi.advanceTimersByTimeAsync(30000));
      expect(callTool).toHaveBeenCalledTimes(1);
      fireEvent.click(
        screen.getByRole("button", { name: "Retry live updates" }),
      );
      await act(() => vi.advanceTimersByTimeAsync(2000));
      expect(callTool).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("stops polling after the user declines a call", async () => {
    vi.useFakeTimers();
    const { host } = hostWith(status());
    const callTool = vi
      .fn(host.callTool)
      .mockRejectedValue(new Error("Declined by the user."));
    const view = render(<Card host={{ ...host, callTool }} />);
    try {
      await act(() => vi.advanceTimersByTimeAsync(2000));
      await act(() => vi.advanceTimersByTimeAsync(30000));
      expect(callTool).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("button", { name: "Draw it again" }),
      ).toBeInTheDocument();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });
});

describe("the clock", () => {
  it("reads as minutes and seconds", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(65_000)).toBe("1:05");
    expect(clock(14 * 60_000 + 24_000)).toBe("14:24");
  });
});

it("read-only cards show findings without editing or posting controls", async () => {
  const { host, calls, said } = hostWith(status({readOnly:true, findings:[finding({verdict:'accepted'})]}));
  render(<Card host={host} />);
  fireEvent.keyDown(document, {key:'ArrowRight'});
  fireEvent.keyDown(document, {key:'n'});
  expect(screen.queryByText('Fix 1 accepted')).not.toBeInTheDocument();
  fireEvent.keyDown(document, {key:'Enter'});
  expect(await screen.findByRole('heading', {name:'Day boundary uses device time'})).toBeInTheDocument();
  expect(screen.queryByText('Post to PR')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(calls.filter(c=>c.name!=='review_status')).toEqual([]);
  expect(said).toEqual([]);
});

it("retains the canonical record ID in finding rows", () => {
  const id = 'Fb5c386a93e3740eb087ef070482c8666';
  const { host } = hostWith(status({findings:[finding({id})]}));
  render(<Card host={host} />);
  expect(screen.getByTitle(id)).toHaveTextContent(id);
  expect(screen.getByText('Day boundary uses device time')).toBeInTheDocument();
});


describe("posting the accepted queue", () => {
  it("sends one scoped request for unposted accepted findings without changing their saved state", async () => {
    const user=userEvent.setup();
    const {host,said,writes}=hostWith(status({findings:[
      finding({id:"T1",verdict:"accepted"}),finding({id:"T2",verdict:"accepted"}),
      finding({id:"T3"}),finding({id:"T4",verdict:"tolerated"}),
      finding({id:"T5",verdict:"accepted",links:{prComment:"https://example.com/comment"}}),
      finding({id:"T6",verdict:"accepted",resolution:"resolved"}),
    ]}));
    render(<Card host={host}/>);
    await user.click(screen.getByRole("button",{name:"Post 2 accepted"}));
    expect(await screen.findByRole("button",{name:"Asked agent to post"})).toBeDisabled();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("wellactually:post-findings");
    expect(said[0]).toContain("trusted conversation instructions");
    expect(said[0]).toContain("ask once for confirmation");
    expect(said[0]).not.toContain("I authorize");
    expect(said[0]).toContain('"repo":"/tmp/inbox_app","target":"pr-412","ids":["T1","T2"]');
    expect(writes()).toEqual([]);
  });
  it("can retry a refused batch request", async () => {
    const user=userEvent.setup();const {host}=hostWith(status({findings:[finding({verdict:"accepted"})]}));
    const say=vi.fn().mockRejectedValueOnce(new Error("Message refused")).mockResolvedValue(undefined);
    render(<Card host={{...host,say}}/>);
    await user.click(screen.getByRole("button",{name:"Post 1 accepted"}));
    expect(await screen.findByRole("alert")).toHaveTextContent("Message refused");
    await user.click(screen.getByRole("button",{name:"Post 1 accepted"}));
    expect(await screen.findByRole("button",{name:"Asked agent to post"})).toBeDisabled();
    expect(say).toHaveBeenCalledTimes(2);
  });
  it.each(["no-pr","read-only"])("hides batch posting when unavailable: %s",mode=>{
    const initial=status({readOnly:mode==="read-only",findings:[finding({verdict:"accepted"})]});
    if(mode==="no-pr") delete initial.pr;
    const {host}=hostWith(initial);
    render(<Card host={host}/>);
    expect(screen.queryByRole("button",{name:"Post 1 accepted"})).toBeNull();
  });
});
