// packages/cli/src/agents/pi.ts
import fs2 from "node:fs";
import path2 from "node:path";

// packages/cli/src/agents/bridge.ts
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
var HOOK_TIMEOUT_MS = 1e4;
function pluginRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}
function command(root = pluginRoot()) {
  const bundled = path.join(root, "dist", "wellactually.mjs");
  return fs.existsSync(bundled) ? { file: "node", args: [bundled] } : { file: "wellactually", args: [] };
}
function callHook(payload, root = pluginRoot()) {
  const { file, args } = command(root);
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (text) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(text);
      }
    };
    let child;
    try {
      child = spawn(file, [...args, "hook"], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, CLAUDE_PLUGIN_ROOT: root } });
    } catch {
      resolve("");
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done("");
    }, HOOK_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => done(""));
    child.on("close", () => done(adviceOf(out)));
    child.stdin?.on("error", () => {
    });
    child.stdin?.end(JSON.stringify(payload));
  });
}
function adviceOf(printed) {
  const text = printed.trim();
  if (text === "") {
    return "";
  }
  try {
    const answer = JSON.parse(text);
    const advice = answer.hookSpecificOutput?.additionalContext;
    return typeof advice === "string" ? advice : "";
  } catch {
    return "";
  }
}
var Pending = class {
  advice = /* @__PURE__ */ new Map();
  add(callId, text) {
    if (text !== "") {
      const before = this.advice.get(callId);
      this.advice.set(callId, before ? `${before}

${text}` : text);
    }
  }
  take(callId) {
    const text = this.advice.get(callId) ?? "";
    this.advice.delete(callId);
    return text;
  }
};

// packages/cli/src/agents/mcp-client.ts
import { spawn as spawn2 } from "node:child_process";
import { createInterface } from "node:readline";
var TIMEOUT_MS = 3e4;
var McpClient = class {
  child = null;
  nextId = 1;
  waiting = /* @__PURE__ */ new Map();
  ready = null;
  file;
  args;
  client;
  cwd;
  constructor(file, args, client, cwd) {
    this.file = file;
    this.args = args;
    this.client = client;
    this.cwd = cwd;
  }
  /** Starts the server once, on first use, and introduces the client. */
  start() {
    this.ready ??= (async () => {
      const child = spawn2(this.file, this.args, { cwd: this.cwd, stdio: ["pipe", "pipe", "ignore"] });
      this.child = child;
      child.on("exit", () => {
        this.child = null;
        this.ready = null;
        for (const { reject } of this.waiting.values()) {
          reject(new Error("the wellactually MCP server stopped"));
        }
        this.waiting.clear();
      });
      child.on("error", (error) => {
        for (const { reject } of this.waiting.values()) {
          reject(error);
        }
        this.waiting.clear();
      });
      createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
      await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: this.client });
      this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    })();
    return this.ready;
  }
  async listTools() {
    await this.start();
    const result = await this.request("tools/list", {});
    return result.tools ?? [];
  }
  async callTool(name, args, meta) {
    await this.start();
    return await this.request("tools/call", { name, arguments: args ?? {}, _meta: meta });
  }
  close() {
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`the wellactually MCP server did not answer ${method}`));
      }, TIMEOUT_MS);
      this.waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  send(message) {
    this.child?.stdin?.write(`${JSON.stringify(message)}
`);
  }
  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const waiting = this.waiting.get(message.id);
    if (!waiting) {
      return;
    }
    this.waiting.delete(message.id);
    if (message.error) {
      waiting.reject(new Error(message.error.message ?? "the wellactually MCP server failed"));
    } else {
      waiting.resolve(message.result);
    }
  }
};

// packages/cli/src/agents/pi.ts
function str(value) {
  return typeof value === "string" ? value : void 0;
}
function piText(content) {
  return Array.isArray(content) ? content.map((part) => part.type === "text" && typeof part.text === "string" ? part.text : "").join("\n") : "";
}
function piPayload(call, base, output, existed) {
  const { toolName: tool, input } = call;
  const common = { ...base, tool_use_id: call.toolCallId };
  if (output === void 0) {
    return tool === "bash" && str(input.command) ? { ...common, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: str(input.command) } } : null;
  }
  const post = { ...common, hook_event_name: "PostToolUse" };
  if (tool === "bash" && str(input.command)) {
    return { ...post, tool_name: "Bash", tool_input: { command: str(input.command) }, tool_response: { stdout: output } };
  }
  const file = str(input.path)?.replace(/^@/, "");
  if (!file) {
    return null;
  }
  if (tool === "read") {
    return { ...post, tool_name: "Read", tool_input: { file_path: file } };
  }
  if (tool === "write") {
    return { ...post, tool_name: "Write", tool_input: { file_path: file }, tool_response: { type: existed === false ? "create" : "update" } };
  }
  if (tool === "edit") {
    const edits = Array.isArray(input.edits) ? input.edits : [input];
    return { ...post, tool_name: "MultiEdit", tool_input: { file_path: file, edits: edits.map((edit) => ({ new_string: str(edit.newText) ?? "" })) } };
  }
  return null;
}
var VERSION = "1";
async function wellactually(pi) {
  const root = pluginRoot();
  process.env.CLAUDE_PLUGIN_ROOT = root;
  const base = (ctx) => ({
    session_id: ctx.sessionManager.getSessionId(),
    cwd: ctx.cwd,
    transcript_path: ctx.sessionManager.getSessionFile()
  });
  const pending = new Pending();
  const existed = /* @__PURE__ */ new Map();
  pi.on("session_start", (_event, ctx) => {
    void callHook({ ...base(ctx), hook_event_name: "SessionStart" });
  });
  pi.on("session_compact", (_event, ctx) => {
    void callHook({ ...base(ctx), hook_event_name: "PostCompact" });
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    await callHook({ ...base(ctx), hook_event_name: "SessionEnd" });
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const advice = await callHook({ ...base(ctx), hook_event_name: "UserPromptSubmit", prompt: event.prompt ?? "" });
    return advice === "" ? void 0 : { message: { customType: "wellactually", content: advice, display: false } };
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "write" && str(event.input.path)) {
      existed.set(event.toolCallId, fs2.existsSync(path2.resolve(ctx.cwd, event.input.path.replace(/^@/, ""))));
    }
    const payload = piPayload(event, base(ctx));
    if (payload) {
      pending.add(event.toolCallId, await callHook(payload));
    }
  });
  pi.on("tool_result", async (event, ctx) => {
    const held = pending.take(event.toolCallId);
    const wasThere = existed.get(event.toolCallId);
    existed.delete(event.toolCallId);
    const payload = event.isError ? null : piPayload(event, base(ctx), piText(event.content), wasThere);
    const advice = [held, payload ? await callHook(payload) : ""].filter((text) => text !== "").join("\n\n");
    if (advice === "") {
      return void 0;
    }
    const content = Array.isArray(event.content) ? event.content : [];
    return { content: [...content, { type: "text", text: advice }] };
  });
  await registerMcpTools(pi, root);
}
async function registerMcpTools(pi, root) {
  const { file, args } = command(root);
  const client = new McpClient(file, [...args, "mcp"], { name: "pi", version: VERSION }, process.cwd());
  let tools;
  try {
    tools = await client.listTools();
  } catch {
    client.close();
    return;
  }
  for (const tool of tools) {
    pi.registerTool({
      name: `wellactually_${tool.name}`,
      label: `Well Actually: ${tool.name.replaceAll("_", " ")}`,
      description: tool.description ?? tool.name,
      parameters: tool.inputSchema,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const meta = ctx?.model?.id ? { "wellactually/model": ctx.model.id } : {};
        try {
          const result = await client.callTool(tool.name, params, meta);
          return { content: [{ type: "text", text: piText(result.content) }], details: {}, isError: result.isError === true };
        } catch (error) {
          return { content: [{ type: "text", text: error.message }], details: {}, isError: true };
        }
      }
    });
  }
  pi.on("session_shutdown", () => client.close());
}
export {
  wellactually as default,
  piPayload,
  piText
};
