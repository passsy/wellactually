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
  error?: { code?: number; message: string };
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

async function initialize(host: Window, sent: () => Sent[]) {
  const hello=sent().find(m=>m.method==="ui/initialize")!;
  answer(host,{id:hello.id!,result:{protocolVersion:"2026-01-26",hostCapabilities:{serverTools:{}},hostContext:{}}});
  await Promise.resolve();
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the handshake", () => {
  it("preserves the host's exact tool-call rejection code and message", async () => {
    const {host,sent}=hostFrame(); const card=connect(host,window);
    await initialize(host,sent);
    const call=card.callTool("review_status",{});
    const request=sent().find(m=>m.method==="tools/call")!;
    answer(host,{id:request.id!,error:{code:-32601,message:"Tool calls are unavailable"}});
    await expect(call).rejects.toMatchObject({method:"tools/call",code:-32601,message:"tools/call: [-32601] Tool calls are unavailable"});
  });

  it("waits for a completed handshake before any tool call", async () => {
    const {host,sent}=hostFrame();const card=connect(host,window);
    const call=card.callTool("review_status",{});
    expect(sent().some(m=>m.method==="tools/call")).toBe(false);
    await initialize(host,sent);await Promise.resolve();
    const tool=sent().find(m=>m.method==="tools/call")!;
    expect(tool).toBeDefined();
    expect(card.connectionDetails!()).toMatchObject({handshake:"complete",handshakeAtToolCall:"complete"});
    answer(host,{id:tool.id!,result:{}});await call;
  });

  it("names the card as appInfo, as the MCP Apps schema requires", () => {
    const { host, sent } = hostFrame();

    connect(host, window);

    const hello = sent().find((message) => message.method === "ui/initialize");
    expect(hello?.params).toEqual({
      protocolVersion: "2026-01-26",
      appInfo: { name: "wellactually-review-card", version: "1" },
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    });
  });

  it("requests fullscreen and follows the host's actual mode and restore notifications", async () => {
    const { host, sent } = hostFrame();
    const bridge = connect(host, window);
    const states: string[] = [];
    const unsubscribe = bridge.onDisplayState!((state) =>
      states.push(state.mode),
    );
    const hello = sent().find((message) => message.method === "ui/initialize")!;
    answer(host, {
      id: hello.id!,
      result: {
        hostContext: {
          displayMode: "inline",
          availableDisplayModes: ["inline", "fullscreen"],
        },
      },
    });
    await vi.waitFor(() =>
      expect(
        sent().some(
          (message) => message.method === "ui/notifications/initialized",
        ),
      ).toBe(true),
    );
    const change = bridge.requestDisplayMode!("fullscreen");
    const request = sent().find(
      (message) => message.method === "ui/request-display-mode",
    )!;
    expect(request.params).toEqual({ mode: "fullscreen" });
    answer(host, { id: request.id!, result: { mode: "fullscreen" } });
    await expect(change).resolves.toBe("fullscreen");
    expect(document.documentElement.dataset["displayMode"]).toBe("fullscreen");
    const count = sent().length;
    bridge.resized(900);
    expect(sent()).toHaveLength(count);
    answer(host, {
      method: "ui/notifications/host-context-changed",
      params: { displayMode: "inline" },
    });
    expect(states).toContain("fullscreen");
    expect(states.at(-1)).toBe("inline");
    bridge.resized(300);
    expect(sent().at(-1)?.method).toBe("ui/notifications/size-changed");
    unsubscribe();
  });

  it("does not request an unsupported mode or claim fullscreen when the host stays inline", async () => {
    const { host, sent } = hostFrame(),
      bridge = connect(host, window);
    const hello = sent().find((message) => message.method === "ui/initialize")!;
    answer(host, {
      id: hello.id!,
      result: {
        hostContext: {
          displayMode: "inline",
          availableDisplayModes: ["inline"],
        },
      },
    });
    await vi.waitFor(() =>
      expect(
        sent().some(
          (message) => message.method === "ui/notifications/initialized",
        ),
      ).toBe(true),
    );
    await expect(bridge.requestDisplayMode!("fullscreen")).rejects.toThrow(
      "does not support",
    );
    expect(
      sent().some((message) => message.method === "ui/request-display-mode"),
    ).toBe(false);
    answer(host, {
      method: "ui/notifications/host-context-changed",
      params: { availableDisplayModes: ["inline", "fullscreen"] },
    });
    const change = bridge.requestDisplayMode!("fullscreen");
    const request = sent().find(
      (message) => message.method === "ui/request-display-mode",
    )!;
    answer(host, { id: request.id!, result: { mode: "inline" } });
    await expect(change).resolves.toBe("inline");
    expect(document.documentElement.dataset["displayMode"]).toBe("inline");
  });

  it("puts a message in the conversation as a list of content blocks", async () => {
    const { host, sent } = hostFrame();

    const sending = connect(host, window).say(
      "Fix the accepted findings of pr-7: T1",
    );

    const message = sent().find((each) => each.method === "ui/message");
    expect(message?.params).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Fix the accepted findings of pr-7: T1" },
      ],
    });
    answer(host, { id: message!.id!, result: {} });
    await expect(sending).resolves.toBeUndefined();
  });

  it("reports a message the host rejects", async () => {
    const { host, sent } = hostFrame();
    const sending = connect(host, window).say("Post T1");
    const message = sent().find((each) => each.method === "ui/message");
    answer(host, { id: message!.id!, result: { isError: true } });
    await expect(sending).rejects.toThrow("declined");
  });

  it("gives up on a request the host never answers", async () => {
    vi.useFakeTimers();
    try {
      const { host, sent } = hostFrame();
      const card = connect(host, window);
      await initialize(host,sent);
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
      await initialize(host,sent);
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
