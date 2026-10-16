import fs from "node:fs";
import path from "node:path";
import type { HookPayload } from "@wellactually/core/node";
import { Pending, callHook, command, pluginRoot } from "./bridge.ts";
import { McpClient } from "./mcp-client.ts";

/**
 * The Well Actually extension for pi.
 *
 * pi has neither hooks that run a command nor MCP, so this extension does
 * both: it turns pi's events into the payloads Claude Code would send to
 * `wellactually hook`, and offers the tools of `wellactually mcp` as pi tools.
 * The skills come with the package, from its skills/ folder.
 */

/** What pi reports about a tool call. */
export interface PiCall {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The text of a tool result, which pi keeps as a list of parts. */
export function piText(content: unknown): string {
  return Array.isArray(content)
    ? content.map((part: { type?: string; text?: string }) => (part.type === "text" && typeof part.text === "string" ? part.text : "")).join("\n")
    : "";
}

/**
 * The Claude Code payload for a pi tool call: before it runs when `output` is
 * undefined, after it ran otherwise. Null when no detector looks at this tool.
 */
export function piPayload(call: PiCall, base: { session_id: string; cwd: string; transcript_path?: string }, output?: string, existed?: boolean): HookPayload | null {
  const { toolName: tool, input } = call;
  const common = { ...base, tool_use_id: call.toolCallId };
  if (output === undefined) {
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
    const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [input];
    return { ...post, tool_name: "MultiEdit", tool_input: { file_path: file, edits: edits.map((edit) => ({ new_string: str(edit.newText) ?? "" })) } };
  }
  return null;
}

/** The parts of pi's extension API this extension uses. */
interface PiContext {
  cwd: string;
  model?: { id?: string; provider?: string };
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
}
interface PiApi {
  on(event: string, handler: (event: any, ctx: PiContext) => unknown): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: PiContext): Promise<{ content: { type: "text"; text: string }[]; details: unknown; isError?: boolean }>;
  }): void;
}

const VERSION = "1";

export default async function wellactually(pi: PiApi): Promise<void> {
  const root = pluginRoot();
  // The skills run the command by the plugin's path; pi's shell inherits this process's environment.
  process.env.CLAUDE_PLUGIN_ROOT = root;
  const base = (ctx: PiContext): { session_id: string; cwd: string; transcript_path?: string } => ({
    session_id: ctx.sessionManager.getSessionId(),
    cwd: ctx.cwd,
    transcript_path: ctx.sessionManager.getSessionFile(),
  });
  const pending = new Pending();
  const existed = new Map<string, boolean>();

  pi.on("session_start", (_event, ctx) => {
    void callHook({ ...base(ctx), hook_event_name: "SessionStart" });
  });
  pi.on("session_compact", (_event, ctx) => {
    void callHook({ ...base(ctx), hook_event_name: "PostCompact" });
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    await callHook({ ...base(ctx), hook_event_name: "SessionEnd" });
  });

  pi.on("before_agent_start", async (event: { prompt?: string }, ctx) => {
    const advice = await callHook({ ...base(ctx), hook_event_name: "UserPromptSubmit", prompt: event.prompt ?? "" });
    // A message the model reads with the prompt that stays in the session, like Claude Code's added context.
    return advice === "" ? undefined : { message: { customType: "wellactually", content: advice, display: false } };
  });

  pi.on("tool_call", async (event: PiCall, ctx) => {
    if (event.toolName === "write" && str(event.input.path)) {
      existed.set(event.toolCallId, fs.existsSync(path.resolve(ctx.cwd, (event.input.path as string).replace(/^@/, ""))));
    }
    const payload = piPayload(event, base(ctx));
    if (payload) {
      pending.add(event.toolCallId, await callHook(payload));
    }
  });

  pi.on("tool_result", async (event: PiCall & { content: unknown; isError?: boolean }, ctx) => {
    const held = pending.take(event.toolCallId);
    const wasThere = existed.get(event.toolCallId);
    existed.delete(event.toolCallId);
    const payload = event.isError ? null : piPayload(event, base(ctx), piText(event.content), wasThere);
    const advice = [held, payload ? await callHook(payload) : ""].filter((text) => text !== "").join("\n\n");
    if (advice === "") {
      return undefined;
    }
    const content = Array.isArray(event.content) ? event.content : [];
    return { content: [...content, { type: "text", text: advice }] };
  });

  await registerMcpTools(pi, root);
}

/**
 * Offers each tool of the wellactually MCP server as a pi tool, named
 * `wellactually_<tool>`. The server starts when the session does and serves
 * every call of it.
 */
async function registerMcpTools(pi: PiApi, root: string): Promise<void> {
  const { file, args } = command(root);
  const client = new McpClient(file, [...args, "mcp"], { name: "pi", version: VERSION }, process.cwd());
  let tools;
  try {
    tools = await client.listTools();
  } catch {
    // Without its tools pi still runs the advisory board; the hook does not need the server.
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
        // The model that made the call, which a rating names. pi knows it, the server cannot.
        const meta = ctx?.model?.id ? { "wellactually/model": ctx.model.id } : {};
        try {
          const result = await client.callTool(tool.name, params, meta);
          return { content: [{ type: "text", text: piText(result.content) }], details: {}, isError: result.isError === true };
        } catch (error) {
          return { content: [{ type: "text", text: (error as Error).message }], details: {}, isError: true };
        }
      },
    });
  }
  pi.on("session_shutdown", () => client.close());
}
