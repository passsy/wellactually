import path from "node:path";
import { type HookPayload } from "../hook/payload.ts";
import { Pending, callHook, command, contentBefore, fileResponse, pluginRoot, readSkills, updateNoticeFor, withAdvice } from "./bridge.ts";

/**
 * The Well Actually plugin for OpenCode.
 *
 * One default export serves both plugin APIs: OpenCode 2 reads `id` and
 * calls `setup`, OpenCode 1 calls `server` and uses the hooks it returns.
 * Both report the same tools, so both go through `opencodePayload`.
 */

/** A tool call as both versions describe it. */
export interface OpencodeCall {
  tool: string;
  sessionID: string;
  callID: string;
  input: Record<string, unknown>;
}

const SHELL_TOOLS = new Set(["shell", "bash"]);
const SUBAGENT_TOOLS = new Set(["task", "agent"]);

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The file a tool names: `path` in OpenCode 2, `filePath` in OpenCode 1. */
function fileOf(input: Record<string, unknown>): string | undefined {
  return str(input.path) ?? str(input.filePath);
}

/**
 * The Claude Code payload for an OpenCode tool call: before it runs when
 * `output` is undefined, after it ran otherwise. Null when no detector looks
 * at this tool.
 *
 * `before` is the file the call writes as it was before the call ran: null
 * when it was not there, undefined when that is not known.
 */
export function opencodePayload(call: OpencodeCall, cwd: string, output?: string, before?: string | null): HookPayload | null {
  const base = { session_id: call.sessionID, tool_use_id: call.callID, cwd };
  const { tool, input } = call;
  if (output === undefined) {
    if (SHELL_TOOLS.has(tool) && str(input.command)) {
      return { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: str(input.command) } };
    }
    if (SUBAGENT_TOOLS.has(tool) && str(input.prompt)) {
      return { ...base, hook_event_name: "PreToolUse", tool_name: "Task", tool_input: { prompt: str(input.prompt) } };
    }
    return null;
  }
  const post = { ...base, hook_event_name: "PostToolUse" };
  if (SHELL_TOOLS.has(tool) && str(input.command)) {
    return { ...post, tool_name: "Bash", tool_input: { command: str(input.command) }, tool_response: { stdout: output } };
  }
  if (tool === "apply_patch" || tool === "patch") {
    const patch = str(input.patchText) ?? str(input.patch) ?? str(input.input);
    return patch ? { ...post, tool_name: "apply_patch", tool_input: { patch } } : null;
  }
  const file = fileOf(input);
  if (!file) {
    return null;
  }
  if (tool === "read") {
    return { ...post, tool_name: "Read", tool_input: { file_path: file } };
  }
  if (tool === "write") {
    return { ...post, tool_name: "Write", tool_input: { file_path: file }, tool_response: fileResponse(before) };
  }
  if (tool === "edit") {
    return { ...post, tool_name: "Edit", tool_input: { file_path: file, new_string: str(input.newString) ?? str(input.new_string) ?? "" }, tool_response: fileResponse(before) };
  }
  if (tool === "multiedit" && Array.isArray(input.edits)) {
    const edits = (input.edits as Record<string, unknown>[]).map((edit) => ({ new_string: str(edit.newString) ?? str(edit.new_string) ?? "" }));
    return { ...post, tool_name: "MultiEdit", tool_input: { file_path: file, edits }, tool_response: fileResponse(before) };
  }
  return null;
}

const FILE_TOOLS = new Set(["write", "edit", "multiedit"]);

/** The file a write or an edit names as it is before the call runs. */
function before(call: OpencodeCall, cwd: string): string | null | undefined {
  const file = FILE_TOOLS.has(call.tool) ? fileOf(call.input) : undefined;
  if (file === undefined) {
    return undefined;
  }
  return contentBefore(path.resolve(cwd, file));
}

/** What the hook needs to remember between a tool call and its result. */
class Calls {
  readonly pending = new Pending();
  private readonly was = new Map<string, string | null | undefined>();

  async before(call: OpencodeCall, cwd: string): Promise<void> {
    this.was.set(call.callID, before(call, cwd));
    const payload = opencodePayload(call, cwd);
    if (payload) {
      this.pending.add(call.callID, await callHook(payload));
    }
  }

  /** The advice for a call that ran, including what was held from before it ran. */
  async after(call: OpencodeCall, cwd: string, output: string): Promise<string> {
    const was = this.was.get(call.callID);
    this.was.delete(call.callID);
    const held = this.pending.take(call.callID);
    const payload = opencodePayload(call, cwd, output, was);
    const advice = payload ? await callHook(payload) : "";
    return [held, advice].filter((text) => text !== "").join("\n\n");
  }
}

function sessionStart(sessionID: string, cwd: string): void {
  void callHook({ hook_event_name: "SessionStart", session_id: sessionID, cwd });
}

function compacted(sessionID: string, cwd: string): void {
  void callHook({ hook_event_name: "PostCompact", session_id: sessionID, cwd });
}

/** The MCP server, started by OpenCode the way the other agents start it. */
function mcpCommand(root: string): string[] {
  const { file, args } = command(root);
  return [file, ...args, "mcp"];
}

/** The text of a tool result in OpenCode 2, which is a string or a list of parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part: { type?: string; text?: string }) => (part.type === "text" && typeof part.text === "string" ? part.text : "")).join("\n");
  }
  return "";
}

/** The part of OpenCode 2's plugin context this plugin uses. */
interface V2Context {
  location: { directory: string };
  tool: { hook(name: string, callback: (event: any) => Promise<void> | void): Promise<unknown> };
  session: {
    hook(name: string, callback: (event: any) => Promise<void> | void): Promise<unknown>;
    synthetic(input: { sessionID: string; text: string }): Promise<unknown>;
  };
  shell: { hook(name: string, callback: (event: { env: Record<string, string | undefined> }) => void): Promise<unknown> };
  mcp: { transform(callback: (editor: { set(name: string, config: unknown): void }) => void): Promise<unknown> };
  skill: { transform(callback: (editor: { add(skill: unknown): void; get(id: string): unknown }) => void): Promise<unknown> };
  event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<{ type: string; data?: { sessionID?: string }; durable?: { aggregateID?: string } }> };
}

async function setup(ctx: V2Context): Promise<() => void> {
  const root = pluginRoot();
  const cwd = ctx.location.directory;
  const calls = new Calls();
  const callOf = (event: { tool: string; sessionID: string; id: string; input: unknown }): OpencodeCall => ({
    tool: event.tool,
    sessionID: event.sessionID,
    callID: event.id,
    input: (event.input ?? {}) as Record<string, unknown>,
  });

  await ctx.mcp.transform((editor) => {
    editor.set("wellactually", { type: "local", command: mcpCommand(root) });
  });
  const skills = readSkills(root);
  await ctx.skill.transform((editor) => {
    for (const skill of skills) {
      if (!editor.get(skill.name)) {
        editor.add({ id: skill.name, name: skill.name, description: skill.description, autoinvoke: true, path: skill.path, content: skill.content });
      }
    }
  });
  // The skills run the command by the plugin's path, so the agent's shell knows where that is.
  await ctx.shell.hook("create.before", (event) => {
    event.env.CLAUDE_PLUGIN_ROOT = root;
  });

  await ctx.tool.hook("execute.before", async (event) => {
    await calls.before(callOf(event), cwd);
  });
  await ctx.tool.hook("execute.after", async (event) => {
    if (event.status !== "completed") {
      return;
    }
    const advice = await calls.after(callOf(event), cwd, textOf(event.result?.content));
    if (advice === "") {
      return;
    }
    const content = event.result.content;
    event.result = {
      ...event.result,
      content: Array.isArray(content) ? [...content, { type: "text", text: advice }] : withAdvice(typeof content === "string" ? content : "", advice),
    };
  });

  await ctx.session.hook("prompt", async (event) => {
    const advice = await callHook({ hook_event_name: "UserPromptSubmit", session_id: event.sessionID, prompt: event.prompt?.text ?? "", cwd });
    if (advice !== "") {
      // A synthetic message reaches the model with the prompt and stays in the session, like Claude Code's added context.
      await ctx.session.synthetic({ sessionID: event.sessionID, text: advice });
    }
  });

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const sessionID = event.data?.sessionID ?? event.durable?.aggregateID;
        if (!sessionID) {
          continue;
        }
        if (event.type === "session.created") {
          sessionStart(sessionID, cwd);
        } else if (event.type === "session.compaction.ended" || event.type === "session.compacted") {
          compacted(sessionID, cwd);
        }
      }
    } catch {
      // The stream ends when the plugin unloads.
    }
  })();
  return () => controller.abort();
}

/** OpenCode 1's plugin input and hooks, as far as this plugin uses them. */
interface V1Input {
  directory: string;
  client?: { tui?: { showToast(input: { body: { title?: string; message: string; variant: "info" | "success" | "warning" | "error"; duration?: number } }): Promise<unknown> } };
}

/** A toast about a newer release. OpenCode 2 shows it from the CLI plugin in tui.ts, which this server plugin cannot reach. */
async function announceUpdate(input: V1Input, root: string): Promise<void> {
  // OpenCode 1 runs the plugin from a git clone and has no command that updates it.
  const text = await updateNoticeFor("opencode-1", root);
  if (text !== "") {
    await input.client?.tui?.showToast({ body: { title: "Well Actually", message: text, variant: "info", duration: 10_000 } }).catch(() => {});
  }
}

async function server(input: V1Input): Promise<Record<string, unknown>> {
  const root = pluginRoot();
  const cwd = input.directory;
  const calls = new Calls();
  const callOf = (hook: { tool: string; sessionID: string; callID: string }, args: unknown): OpencodeCall => ({
    tool: hook.tool,
    sessionID: hook.sessionID,
    callID: hook.callID,
    input: (args ?? {}) as Record<string, unknown>,
  });
  return {
    config: async (config: { mcp?: Record<string, unknown>; skills?: string[] | { paths?: string[] } }) => {
      config.mcp = { ...config.mcp, wellactually: { type: "local", command: mcpCommand(root), enabled: true } };
      // OpenCode 1 reads skills from folders. Its skills keep the command as ${CLAUDE_PLUGIN_ROOT}, which the shell knows.
      const skills = path.join(root, "skills");
      config.skills = Array.isArray(config.skills) ? [...config.skills, skills] : { ...config.skills, paths: [...(config.skills?.paths ?? []), skills] };
    },
    event: async ({ event }: { event: { type: string; properties?: { sessionID?: string; info?: { id?: string } } } }) => {
      if (event.type === "session.created" && event.properties?.info?.id) {
        sessionStart(event.properties.info.id, cwd);
        void announceUpdate(input, root);
      } else if (event.type === "session.compacted" && event.properties?.sessionID) {
        compacted(event.properties.sessionID, cwd);
      }
    },
    "shell.env": async (_input: unknown, output: { env: Record<string, string> }) => {
      output.env.CLAUDE_PLUGIN_ROOT = root;
    },
    "tool.execute.before": async (hook: { tool: string; sessionID: string; callID: string }, output: { args: unknown }) => {
      await calls.before(callOf(hook, output.args), cwd);
    },
    "tool.execute.after": async (hook: { tool: string; sessionID: string; callID: string; args: unknown }, output: { output: string }) => {
      const advice = await calls.after(callOf(hook, hook.args), cwd, typeof output.output === "string" ? output.output : "");
      output.output = withAdvice(typeof output.output === "string" ? output.output : "", advice);
    },
    "chat.message": async (hook: { sessionID: string; messageID?: string }, output: { message: { id: string }; parts: Record<string, unknown>[] }) => {
      const prompt = output.parts.map((part) => (part.type === "text" && typeof part.text === "string" && !part.synthetic ? part.text : "")).join("\n");
      const advice = await callHook({ hook_event_name: "UserPromptSubmit", session_id: hook.sessionID, prompt, cwd });
      if (advice !== "") {
        // A synthetic part goes to the model but is not shown as the user's text.
        output.parts.push({
          id: `prt_wellactually${Date.now().toString(36)}`,
          sessionID: hook.sessionID,
          messageID: output.message.id,
          type: "text",
          text: advice,
          synthetic: true,
        });
      }
    },
  };
}

export default { id: "wellactually", setup, server };
