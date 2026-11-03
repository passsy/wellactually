/**
 * The card's half of the handshake, against a frame standing in for the host.
 *
 * A host that validates ui/initialize, as Codex does, refuses a request of
 * the wrong shape and then sends nothing, so the card stays empty without an
 * error anywhere a user would see one. The shape is checked here instead.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Unanswered, connect } from "./bridge.ts";

interface Sent {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

function hostFrame(): { host: Window; sent: () => Sent[] } {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const host = frame.contentWindow;
  if (!host) throw new Error("the stand-in host has no window");
  const postMessage = vi.spyOn(host, "postMessage").mockImplementation(() => {
    // Swallowed: the test reads what was sent off the spy.
  });
  return {
    host,
    sent: () => postMessage.mock.calls.map(([message]) => message as Sent),
  };
}

function answer(host: Window, message: Omit<Sent, "jsonrpc">): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: host,
      data: { jsonrpc: "2.0", ...message },
    }),
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the handshake", () => {
  it("names the card as appInfo, as the MCP Apps schema requires", () => {
    const { host, sent } = hostFrame();

    connect(host, window);

    const hello = sent().find((message) => message.method === "ui/initialize");
    expect(hello?.params).toEqual({
      protocolVersion: "2026-01-26",
      appInfo: { name: "pascal-review-card", version: "1" },
      appCapabilities: { availableDisplayModes: ["inline"] },
    });
  });

  it("puts a message in the conversation as a list of content blocks", () => {
    const { host, sent } = hostFrame();

    connect(host, window).say("Fix the accepted findings of pr-7: T1");

    const message = sent().find((each) => each.method === "ui/message");
    expect(message?.params).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Fix the accepted findings of pr-7: T1" },
      ],
    });
  });

  it("gives up on a request the host never answers", async () => {
    vi.useFakeTimers();
    try {
      const { host } = hostFrame();
      const card = connect(host, window);
      const call = card.callTool("set_stage", { id: "T1", to: "accepted" });
      const landed = vi.fn();
      call.catch(landed);

      await vi.advanceTimersByTimeAsync(9000);
      expect(landed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2000);

      expect(landed).toHaveBeenCalledOnce();
      const error = landed.mock.calls[0]?.[0] as Error;
      expect(error).toBeInstanceOf(Unanswered);
      // Told apart from a refusal, which strands the card for good.
      expect(error.name).toBe("Unanswered");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an answered request settled on its answer", async () => {
    vi.useFakeTimers();
    try {
      const { host, sent } = hostFrame();
      const card = connect(host, window);
      const call = card.callTool("set_stage", { id: "T1", to: "accepted" });
      const message = sent().find((each) => each.method === "tools/call");
      if (message?.id === undefined) throw new Error("no tools/call was sent");
      answer(host, {
        id: message.id,
        result: { structuredContent: { ok: 1 } },
      });

      await expect(call).resolves.toEqual({ structuredContent: { ok: 1 } });
      // The timer that would have failed it must not fire afterwards.
      await vi.advanceTimersByTimeAsync(20000);
      await expect(call).resolves.toEqual({ structuredContent: { ok: 1 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("says initialized once the host has answered, and hands on the result", async () => {
    const { host, sent } = hostFrame();
    const card = connect(host, window);
    const results: unknown[] = [];
    card.onResult((result) => results.push(result));

    const hello = sent().find((message) => message.method === "ui/initialize");
    if (hello?.id === undefined) throw new Error("no ui/initialize was sent");
    answer(host, { id: hello.id, result: { hostContext: { theme: "dark" } } });
    await vi.waitFor(() => {
      expect(sent().map((message) => message.method)).toContain(
        "ui/notifications/initialized",
      );
    });
    answer(host, {
      method: "ui/notifications/tool-result",
      params: { structuredContent: { target: "pr-7" } },
    });

    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(results).toEqual([{ structuredContent: { target: "pr-7" } }]);
  });
});
