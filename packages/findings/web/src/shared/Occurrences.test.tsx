import { expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Occurrences, FindingInformation } from "./Occurrences.tsx";
import type {
  OccurrenceRecord,
  FindingRecord,
} from "../../../model/records.mts";
function occurrence(i: number): OccurrenceRecord {
  return {
    schemaVersion: 2,
    id: `O${i}`,
    findingId: "F1",
    revision: 1,
    state: "open",
    description: `Class C${i}`,
    locations: [
      {
        file: "classes.ts",
        line: i + 1,
        commit: "abc",
        context: { start: i + 1, lines: [`class C${i} {}`] },
      },
    ],
    evidence: [
      {
        id: "E1",
        kind: "reasoning",
        polarity: "supports",
        description: "Discovery details",
        artifacts: [],
      },
    ],
    assessments: [
      {
        id: "A1",
        author: "reviewer",
        authorType: "agent",
        conclusion: "Confirmed",
        reason: "Investigation details",
        at: "2026-11-03T00:00:00Z",
      },
    ],
    links: [],
    history: [],
    createdAt: "2026-11-03T00:00:00Z",
    updatedAt: "2026-11-03T00:00:00Z",
  };
}
function code() {
  return document.querySelector("pre code")?.textContent;
}

test("shows first occurrence code immediately and navigates without exposing investigation details", async () => {
  const user = userEvent.setup();
  render(
    <Occurrences
      findingId="F1"
      refreshKey="1"
      load={async () => [occurrence(0), occurrence(1)]}
    />,
  );
  await waitFor(() => expect(code()).toContain("class C0 {}"));
  expect(screen.getByText("Occurrence 1 of 2")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Previous occurrence" }),
  ).toBeDisabled();
  expect(screen.queryByText("Discovery details")).not.toBeInTheDocument();
  expect(screen.queryByText("Investigation details")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Next occurrence" }));
  expect(code()).toContain("class C1 {}");
  expect(code()).not.toContain("class C0 {}");
  expect(screen.getByText("Occurrence 2 of 2")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Next occurrence" }),
  ).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Previous occurrence" }));
  expect(code()).toContain("class C0 {}");
});

test("resolves only the selected occurrence among 50 and retains its position", async () => {
  const user = userEvent.setup(),
    items = Array.from({ length: 50 }, (_, i) => occurrence(i));
  const load = vi.fn(async () => items.map((o) => ({ ...o })));
  const save = vi.fn(async (o: OccurrenceRecord) => {
    items[Number(o.id.slice(1))] = {
      ...o,
      state: "closed",
      closure: { reason: "resolved", explanation: "Documented" },
    };
  });
  render(
    <Occurrences
      findingId="F1"
      summary={{ total: 50, resolved: 0, open: 50, closed: 0 }}
      refreshKey="1"
      load={load}
      save={save}
    />,
  );
  await screen.findByText("Class C0");
  await user.click(screen.getByRole("button", { name: "Next occurrence" }));
  await user.click(
    screen.getByRole("button", { name: "Mark occurrence resolved" }),
  );
  await waitFor(() =>
    expect(screen.getByText("1 of 50 resolved")).toBeInTheDocument(),
  );
  expect(screen.getByText("Occurrence 2 of 50")).toBeInTheDocument();
  expect(code()).toContain("class C1 {}");
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ id: "O1", revision: 1 }),
  );
  expect(items.filter((o) => o.state === "open")).toHaveLength(49);
});

test("the resolution toggle precedes code and can resolve and reopen one occurrence", async () => {
  const user = userEvent.setup();
  let item = occurrence(0);
  const save = vi.fn(async (current: OccurrenceRecord) => {
    item =
      current.state === "open"
        ? {
            ...current,
            state: "closed",
            closure: { reason: "resolved", explanation: "Fixed" },
          }
        : { ...current, state: "open" };
    if (item.state === "open") delete item.closure;
  });
  const { container } = render(
    <Occurrences
      findingId="F1"
      refreshKey="1"
      load={async () => [item, occurrence(1)]}
      save={save}
    />,
  );
  const toggle = await screen.findByRole("button", {
    name: "Mark occurrence resolved",
  });
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(
    toggle.compareDocumentPosition(container.querySelector("pre")!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await user.click(toggle);
  const resolved = await screen.findByRole("button", {
    name: "Reopen occurrence",
  });
  expect(resolved).toHaveAttribute("aria-pressed", "true");
  expect(resolved).toHaveAttribute("title", "Reopen this occurrence");
  await user.click(resolved);
  expect(
    await screen.findByRole("button", { name: "Mark occurrence resolved" }),
  ).toHaveAttribute("aria-pressed", "false");
  expect(save).toHaveBeenCalledTimes(2);
});

test("reports failed saves without changing progress", async () => {
  const user = userEvent.setup();
  render(
    <Occurrences
      findingId="F1"
      refreshKey="1"
      load={async () => [occurrence(0), occurrence(1)]}
      save={async () => {
        throw new Error("Revision conflict");
      }}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "Mark occurrence resolved" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Revision conflict",
  );
  expect(screen.queryByText(/1 of 2 resolved/)).not.toBeInTheDocument();
  expect(code()).toContain("class C0 {}");
});

test("retries failed loads and displays code without another expansion", async () => {
  const user = userEvent.setup(),
    load = vi
      .fn<() => Promise<OccurrenceRecord[]>>()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue([occurrence(0)]);
  render(<Occurrences findingId="F1" refreshKey="1" load={load} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(code()).toContain("class C0 {}"));
});

test("switching findings never leaves the previous finding's source on screen", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <Occurrences
      findingId="F1"
      refreshKey="1"
      load={async () => [occurrence(0), occurrence(1)]}
    />,
  );
  await screen.findByText("Class C0");
  await user.click(screen.getByRole("button", { name: "Next occurrence" }));
  let complete!: (items: OccurrenceRecord[]) => void;
  const next = new Promise<OccurrenceRecord[]>((resolve) => {
    complete = resolve;
  });
  rerender(<Occurrences findingId="F2" refreshKey="1" load={() => next} />);
  expect(code()).toBeUndefined();
  expect(screen.getByRole("status")).toHaveTextContent("Loading code");
  complete([{ ...occurrence(2), findingId: "F2" }]);
  await waitFor(() => expect(code()).toContain("class C2 {}"));
  expect(screen.queryByText(/Occurrence 1 of 1/)).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Previous occurrence" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Next occurrence" }),
  ).not.toBeInTheDocument();
});

test("missing source has a visible explanation and file action instead of a blank panel", async () => {
  const user = userEvent.setup(),
    open = vi.fn(),
    item = occurrence(0);
  delete item.locations[0]!.context;
  render(
    <Occurrences
      findingId="F1"
      refreshKey="1"
      load={async () => [item, occurrence(1)]}
      onOpen={open}
    />,
  );
  expect(await screen.findByRole("note")).toHaveTextContent(
    "Source code was not captured",
  );
  await user.click(screen.getByRole("button", { name: "classes.ts:1" }));
  expect(open).toHaveBeenCalledWith(item.locations[0]);
});

test("finding information keeps work links and hides evidence and assessments", () => {
  const record = {
    ...occurrence(0),
    verdict: "undecided",
    title: "A claim",
    description: "Shared argument",
    rules: [],
    priority: "p2",
    tags: [],
    origins: [],
    metadata: {},
    links: [
      { id: "L1", kind: "commit", commit: "abc" },
      { id: "L2", kind: "pr", url: "https://github.com/a/b/pull/1" },
    ],
  } as FindingRecord;
  render(<FindingInformation record={record} />);
  expect(
    screen.queryByText(
      /Evidence|Assessments|Discovery details|Investigation details/,
    ),
  ).not.toBeInTheDocument();
  expect(screen.getByText("abc")).toBeInTheDocument();
  expect(screen.getByRole("link")).toHaveAttribute(
    "href",
    "https://github.com/a/b/pull/1",
  );
});


test("one occurrence shows its code without a duplicate resolution button", async () => {
  const save = vi.fn();
  render(<Occurrences findingId="F1" refreshKey="1" load={async () => [occurrence(0)]} save={save} />);
  await waitFor(() => expect(code()).toContain("class C0 {}"));
  expect(screen.queryByRole("button", {name:"Mark occurrence resolved"})).not.toBeInTheDocument();
  expect(screen.queryByRole("button", {name:"Reopen occurrence"})).not.toBeInTheDocument();
  expect(save).not.toHaveBeenCalled();
});
