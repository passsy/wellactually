/**
 * The document list as a tree.
 *
 * A review with hundreds of attachments cannot be a flat list of full paths,
 * so the list folds them into folders. What these check is the contract of
 * that fold: the root documents stay in the same glance, a closed folder
 * admits how much it holds, and opening one is the only way in — and hands
 * back the full path, because the server knows nothing about the fold.
 */

import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Documents } from "./Documents.tsx";
import type { DocumentEntry } from "./api.ts";

const WHERE = { repo: "/tmp/checkout", target: "pr-356" };

function doc(path: string): DocumentEntry {
  return { path, bytes: 2048, changed: "2026-08-01T00:00:00.000Z" };
}

function serves(docs: DocumentEntry[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(docs), {
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );
}

function paint(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("the document tree", () => {
  test("keeps root documents in the same glance, folders closed", async () => {
    serves([
      doc("README.md"),
      doc("level-2.md"),
      doc("evidence/trace-1.md"),
      doc("evidence/trace-2.md"),
      doc("evidence/har/session.har"),
    ]);
    paint(<Documents where={WHERE} onOpen={() => {}} />);

    expect(await screen.findByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("level-2.md")).toBeInTheDocument();
    // The folder is one row saying how much it holds; its files wait inside.
    expect(screen.getByText("evidence")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.queryByText("trace-1.md")).not.toBeInTheDocument();
    // The header counts files, not rows: five documents, however folded.
    expect(screen.getByText("Documents 5")).toBeInTheDocument();
  });

  test("opens and closes a folder on click", async () => {
    serves([doc("evidence/trace-1.md"), doc("evidence/har/session.har")]);
    paint(<Documents where={WHERE} onOpen={() => {}} />);
    const user = userEvent.setup();

    await user.click(await screen.findByText("evidence"));
    expect(screen.getByText("trace-1.md")).toBeInTheDocument();
    // A folder inside stays its own closed row rather than spilling.
    expect(screen.getByText("har")).toBeInTheDocument();
    expect(screen.queryByText("session.har")).not.toBeInTheDocument();

    await user.click(screen.getByText("evidence"));
    expect(screen.queryByText("trace-1.md")).not.toBeInTheDocument();
  });

  test("a file inside a folder opens by its full path", async () => {
    serves([doc("evidence/har/session.har")]);
    const onOpen = vi.fn();
    paint(<Documents where={WHERE} onOpen={onOpen} />);
    const user = userEvent.setup();

    await user.click(await screen.findByText("evidence"));
    await user.click(screen.getByText("har"));
    await user.click(screen.getByText("session.har"));
    expect(onOpen).toHaveBeenCalledWith("evidence/har/session.har");
  });

  test("says so when nothing is written yet", async () => {
    serves([]);
    paint(<Documents where={WHERE} onOpen={() => {}} />);
    expect(await screen.findByText("Nothing written yet.")).toBeInTheDocument();
  });
});
