/**
 * The card's side of MCP Apps, without the SDK.
 *
 * JSON-RPC 2.0 over postMessage, as the 2026-01-26 specification describes
 * it: the card says ui/initialize, then ui/notifications/initialized, and the
 * host pushes the result of the tool call that opened it. After that the
 * card is on its own, and everything it wants it asks for with tools/call.
 *
 * Written by hand because it is eighty lines and the alternative is a
 * dependency whose whole job is these eighty lines. The specification says
 * the SDK is a convenience, and names this as the other way.
 */

const PROTOCOL = "2026-01-26";

/**
 * How long a request waits for the host before it is treated as lost.
 *
 * A host that has lost its MCP transport does not answer and does not refuse
 * — it says nothing at all. Nothing in JSON-RPC ends that wait, so a card
 * that only settles on a reply waits for ever, and a vote it drew while
 * waiting sits there looking saved. Long enough that a slow tool is not cut
 * off, short enough that nobody rates a second finding believing the first
 * one landed.
 */
const ANSWER_WITHIN_MS = 10000;

/** A request the host never answered, as opposed to one it refused. */
export class Unanswered extends Error {
  override readonly name = "Unanswered";

  constructor(method: string) {
    super(`the host did not answer ${method}`);
  }
}

export interface ToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** Everything the card asks of whatever is hosting it. */
export interface Host {
  /**
   * The result of the tool call that opened the card. A listener added after
   * it arrived is handed it at once, so mounting late loses nothing.
   */
  onResult: (listener: (result: ToolResult) => void) => () => void;
  callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<ToolResult>;
  /** Whether the host opened it. Claude's opens nothing that is not https. */
  openLink: (url: string) => Promise<boolean>;
  /** Puts a message in the conversation as though the user had typed it. */
  say: (text: string) => void;
  /** Replaces what the model knows about what was done in the card. */
  tellModel: (text: string) => void;
  /** The host sizes the frame from what the card says it needs. */
  resized: (height: number) => void;
}

interface Message {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
}

interface HostContext {
  theme?: string;
  styles?: { variables?: Record<string, string | undefined> };
}

/** The two things a host says about itself that the card wears. */
function wear(context: HostContext | undefined): void {
  const root = document.documentElement;
  if (context?.theme === "light" || context?.theme === "dark") {
    root.dataset["theme"] = context.theme;
  }
  // Only the typefaces. The card keeps the inbox's own colours, because a p0
  // has to be the same red here as there; the letters it is set in are the
  // host's to choose.
  for (const name of ["--font-sans", "--font-mono"]) {
    const value = context?.styles?.variables?.[name];
    if (value) root.style.setProperty(name, value);
  }
}

export function connect(
  target: Window = window.parent,
  source: Window = window,
): Host {
  let sequence = 0;
  const waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const listeners = new Set<(result: ToolResult) => void>();
  let first: ToolResult | undefined;
  let told = 0;

  const post = (message: Message): void => {
    target.postMessage({ jsonrpc: "2.0", ...message }, "*");
  };

  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      sequence += 1;
      const id = sequence;
      // Dropped when the answer arrives, so a request that is answered
      // leaves no timer behind to fire into an empty map.
      const lost = setTimeout(() => {
        if (!waiting.delete(id)) return;
        reject(new Unanswered(method));
      }, ANSWER_WITHIN_MS);
      waiting.set(id, {
        resolve: (value) => {
          clearTimeout(lost);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(lost);
          reject(error);
        },
      });
      post({ id, method, params });
    });

  /** A request whose answer changes nothing, and whose refusal is the host's right. */
  const ask = (method: string, params: unknown): void => {
    request(method, params).catch(() => {
      // A host may decline to open a link or to add a message. There is
      // nothing for the card to do about either.
    });
  };

  source.addEventListener("message", (event: MessageEvent<Message>) => {
    if (event.source !== target) return;
    const message = event.data;
    if (message.jsonrpc !== "2.0") return;

    if (message.method === undefined) {
      const call =
        message.id === undefined ? undefined : waiting.get(message.id);
      if (!call || message.id === undefined) return;
      waiting.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
      return;
    }

    if (message.method === "ui/notifications/tool-result") {
      first = message.params as ToolResult;
      for (const listener of listeners) listener(first);
    }
    if (message.method === "ui/notifications/host-context-changed") {
      wear(message.params as HostContext);
    }
    // ui/resource-teardown is a request, and the host waits for the reply.
    if (message.id !== undefined) post({ id: message.id, result: {} });
  });

  // appInfo, not MCP's clientInfo: a host that validates the request, as
  // Codex does, refuses it otherwise and holds the tool result back for good.
  request("ui/initialize", {
    protocolVersion: PROTOCOL,
    appInfo: { name: "pascal-review-card", version: "1" },
    appCapabilities: { availableDisplayModes: ["inline"] },
  }).then(
    (hello) => {
      wear((hello as { hostContext?: HostContext }).hostContext);
      post({ method: "ui/notifications/initialized", params: {} });
    },
    (error: unknown) => {
      // Nothing will arrive after a refusal, so the card stays empty. Say
      // why where somebody debugging the frame will look.
      console.error("The host refused ui/initialize:", error);
    },
  );

  return {
    onResult: (listener) => {
      listeners.add(listener);
      if (first) listener(first);
      return () => {
        listeners.delete(listener);
      };
    },
    callTool: (name, args) =>
      request("tools/call", { name, arguments: args }) as Promise<ToolResult>,
    openLink: (url) =>
      request("ui/open-link", { url }).then(
        (answer) => (answer as { isError?: boolean } | null)?.isError !== true,
        () => false,
      ),
    say: (text) => {
      // A list of blocks, as the specification has it. A single block is
      // dropped by both Claude's host and Codex's.
      ask("ui/message", { role: "user", content: [{ type: "text", text }] });
    },
    tellModel: (text) => {
      ask("ui/update-model-context", { content: [{ type: "text", text }] });
    },
    resized: (height) => {
      if (height === told) return;
      told = height;
      post({
        method: "ui/notifications/size-changed",
        params: { width: document.documentElement.scrollWidth, height },
      });
    },
  };
}
