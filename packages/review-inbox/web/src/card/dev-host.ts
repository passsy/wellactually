/**
 * A host for the review card, for working on it.
 *
 * `npm run web:dev`, then /card-host.html?repo=<path>&target=<name>. It is
 * the host's half of MCP Apps and nothing more: it answers ui/initialize,
 * pushes the first review_status, and forwards every tools/call the card
 * makes to the findings server's own tool routes. So the card runs against
 * real reviews with a reload loop, and no MCP host has to be restarted to
 * look at a change.
 *
 * `&host=code-tab` plays Claude's Code tab instead: every tools/call the card
 * makes is refused, and ui/open-link opens only https, which is what that
 * host does for a server its session's CLI runs.
 *
 * Never built and never shipped: build.mjs lists what it bundles, and this
 * is not on the list.
 */

interface Message {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

const asked = new URLSearchParams(location.search);
const codeTab = asked.get("host") === "code-tab";
const where = {
  repo: asked.get("repo") ?? "",
  target: asked.get("target") ?? "",
};

function need<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`no #${id} on the page`);
  return found as T;
}

const frame = need<HTMLIFrameElement>("card");
const log = need("log");
const root = document.documentElement;

need("what").textContent = where.target
  ? `${where.target} in ${where.repo}`
  : "Add ?repo=<path>&target=<name> to the address.";

const said: string[] = [];
function note(line: string): void {
  said.unshift(line);
  log.textContent = said.slice(0, 12).join("\n");
}

async function callTool(
  name: string,
  args: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  if (!response.ok) {
    return { isError: true, content: [{ type: "text", text }] };
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: JSON.parse(text) as unknown,
  };
}

function send(message: Omit<Message, "jsonrpc"> & { result?: unknown }): void {
  frame.contentWindow?.postMessage({ jsonrpc: "2.0", ...message }, "*");
}

window.addEventListener("message", (event: MessageEvent<Message>) => {
  if (event.source !== frame.contentWindow) return;
  const { id, method, params } = event.data;
  if (method === undefined) return;

  const answer = (result: unknown): void => {
    if (id !== undefined) send({ id, result });
  };

  if (method === "ui/initialize" && params?.["appInfo"] === undefined) {
    // Refused the way a host that validates the request refuses it, so a
    // card that stops sending appInfo is empty here too.
    note(`ui/initialize refused: no appInfo in ${JSON.stringify(params)}`);
    if (id !== undefined) {
      frame.contentWindow?.postMessage(
        { jsonrpc: "2.0", id, error: { code: -32602, message: "no appInfo" } },
        "*",
      );
    }
  } else if (method === "ui/initialize") {
    answer({
      protocolVersion: "2026-01-26",
      hostInfo: { name: "card-dev-host", version: "0" },
      hostCapabilities: { openLinks: {}, serverTools: {} },
      hostContext: { theme: root.dataset["theme"], displayMode: "inline" },
    });
  } else if (method === "ui/notifications/initialized") {
    send({
      method: "ui/notifications/tool-input",
      params: { arguments: where },
    });
    void callTool("review_status", where).then((result) => {
      send({ method: "ui/notifications/tool-result", params: result });
    });
  } else if (method === "ui/notifications/size-changed") {
    frame.style.height = `${String(params?.["height"])}px`;
  } else if (method === "tools/call" && codeTab) {
    note(
      `tools/call ${String(params?.["name"])} refused, as the Code tab does`,
    );
    if (id !== undefined) {
      frame.contentWindow?.postMessage(
        {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: "IPC not available for MCP tool call",
          },
        },
        "*",
      );
    }
  } else if (method === "ui/open-link" && codeTab) {
    const url = String(params?.["url"]);
    const https = url.startsWith("https:");
    note(`ui/open-link ${https ? "opened" : "refused, not https"}: ${url}`);
    answer(https ? {} : { isError: true });
  } else if (method === "tools/call") {
    const name = String(params?.["name"]);
    if (name !== "review_status") note(`tools/call ${name}`);
    void callTool(name, params?.["arguments"]).then(answer);
  } else {
    note(`${method} ${JSON.stringify(params)}`);
    answer({});
  }
});

need("theme").addEventListener("click", () => {
  const next = root.dataset["theme"] === "dark" ? "light" : "dark";
  root.dataset["theme"] = next;
  send({
    method: "ui/notifications/host-context-changed",
    params: { theme: next },
  });
});

need("width").addEventListener("click", () => {
  const narrow = root.style.getPropertyValue("--width") === "520px";
  root.style.setProperty("--width", narrow ? "720px" : "520px");
});

// Loaded last, so the listener above is there before the card says hello.
frame.src = "/card.html";
