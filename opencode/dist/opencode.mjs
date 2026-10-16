// packages/cli/src/agents/opencode.ts
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
function withAdvice(result, advice) {
  return advice === "" ? result : `${result}

${advice}`;
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
function readSkills(root = pluginRoot()) {
  const dir = path.join(root, "skills");
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = path.join(dir, name, "SKILL.md");
    let content;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const field = (key) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(content)?.[1]?.trim().replace(/^["']|["']$/g, "");
    const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    return [{ name: field("name") ?? name, description: field("description") ?? "", path: file, content: body.replaceAll("${CLAUDE_PLUGIN_ROOT}", root) }];
  });
}

// packages/cli/src/agents/opencode.ts
var SHELL_TOOLS = /* @__PURE__ */ new Set(["shell", "bash"]);
var SUBAGENT_TOOLS = /* @__PURE__ */ new Set(["task", "agent"]);
function str(value) {
  return typeof value === "string" ? value : void 0;
}
function fileOf(input) {
  return str(input.path) ?? str(input.filePath);
}
function opencodePayload(call, cwd, output, existed) {
  const base = { session_id: call.sessionID, tool_use_id: call.callID, cwd };
  const { tool, input } = call;
  if (output === void 0) {
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
    return { ...post, tool_name: "Write", tool_input: { file_path: file }, tool_response: { type: existed === false ? "create" : "update" } };
  }
  if (tool === "edit") {
    return { ...post, tool_name: "Edit", tool_input: { file_path: file, new_string: str(input.newString) ?? str(input.new_string) ?? "" } };
  }
  if (tool === "multiedit" && Array.isArray(input.edits)) {
    const edits = input.edits.map((edit) => ({ new_string: str(edit.newString) ?? str(edit.new_string) ?? "" }));
    return { ...post, tool_name: "MultiEdit", tool_input: { file_path: file, edits } };
  }
  return null;
}
function exists(call, cwd) {
  const file = call.tool === "write" ? fileOf(call.input) : void 0;
  return file === void 0 ? void 0 : fs2.existsSync(path2.resolve(cwd, file));
}
var Calls = class {
  pending = new Pending();
  existed = /* @__PURE__ */ new Map();
  async before(call, cwd) {
    this.existed.set(call.callID, exists(call, cwd));
    const payload = opencodePayload(call, cwd);
    if (payload) {
      this.pending.add(call.callID, await callHook(payload));
    }
  }
  /** The advice for a call that ran, including what was held from before it ran. */
  async after(call, cwd, output) {
    const existed = this.existed.get(call.callID);
    this.existed.delete(call.callID);
    const held = this.pending.take(call.callID);
    const payload = opencodePayload(call, cwd, output, existed);
    const advice = payload ? await callHook(payload) : "";
    return [held, advice].filter((text) => text !== "").join("\n\n");
  }
};
function sessionStart(sessionID, cwd) {
  void callHook({ hook_event_name: "SessionStart", session_id: sessionID, cwd });
}
function compacted(sessionID, cwd) {
  void callHook({ hook_event_name: "PostCompact", session_id: sessionID, cwd });
}
function mcpCommand(root) {
  const { file, args } = command(root);
  return [file, ...args, "mcp"];
}
function textOf(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => part.type === "text" && typeof part.text === "string" ? part.text : "").join("\n");
  }
  return "";
}
async function setup(ctx) {
  const root = pluginRoot();
  const cwd = ctx.location.directory;
  const calls = new Calls();
  const callOf = (event) => ({
    tool: event.tool,
    sessionID: event.sessionID,
    callID: event.id,
    input: event.input ?? {}
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
      content: Array.isArray(content) ? [...content, { type: "text", text: advice }] : withAdvice(typeof content === "string" ? content : "", advice)
    };
  });
  await ctx.session.hook("prompt", async (event) => {
    const advice = await callHook({ hook_event_name: "UserPromptSubmit", session_id: event.sessionID, prompt: event.prompt?.text ?? "", cwd });
    if (advice !== "") {
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
    }
  })();
  return () => controller.abort();
}
async function server(input) {
  const root = pluginRoot();
  const cwd = input.directory;
  const calls = new Calls();
  const callOf = (hook, args) => ({
    tool: hook.tool,
    sessionID: hook.sessionID,
    callID: hook.callID,
    input: args ?? {}
  });
  return {
    config: async (config) => {
      config.mcp = { ...config.mcp, wellactually: { type: "local", command: mcpCommand(root), enabled: true } };
      const skills = path2.join(root, "skills");
      config.skills = Array.isArray(config.skills) ? [...config.skills, skills] : { ...config.skills, paths: [...config.skills?.paths ?? [], skills] };
    },
    event: async ({ event }) => {
      if (event.type === "session.created" && event.properties?.info?.id) {
        sessionStart(event.properties.info.id, cwd);
      } else if (event.type === "session.compacted" && event.properties?.sessionID) {
        compacted(event.properties.sessionID, cwd);
      }
    },
    "shell.env": async (_input, output) => {
      output.env.CLAUDE_PLUGIN_ROOT = root;
    },
    "tool.execute.before": async (hook, output) => {
      await calls.before(callOf(hook, output.args), cwd);
    },
    "tool.execute.after": async (hook, output) => {
      const advice = await calls.after(callOf(hook, hook.args), cwd, typeof output.output === "string" ? output.output : "");
      output.output = withAdvice(typeof output.output === "string" ? output.output : "", advice);
    },
    "chat.message": async (hook, output) => {
      const prompt = output.parts.map((part) => part.type === "text" && typeof part.text === "string" && !part.synthetic ? part.text : "").join("\n");
      const advice = await callHook({ hook_event_name: "UserPromptSubmit", session_id: hook.sessionID, prompt, cwd });
      if (advice !== "") {
        output.parts.push({
          id: `prt_wellactually${Date.now().toString(36)}`,
          sessionID: hook.sessionID,
          messageID: output.message.id,
          type: "text",
          text: advice,
          synthetic: true
        });
      }
    }
  };
}
var opencode_default = { id: "wellactually", setup, server };
export {
  opencode_default as default,
  opencodePayload
};
