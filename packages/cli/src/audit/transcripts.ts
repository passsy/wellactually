import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The agents whose conversations the audit reads. pi is only seen through the hook log. */
export type AuditAgent = "claude-code" | "codex" | "opencode" | "pi";

/** One call of rate_principle, as the conversation recorded it. */
export interface RatingCall {
  id: string | null;
  rating: string | null;
  /** True when the server answered that it recorded the rating, false when it said why not, null when no answer was recorded. */
  recorded: boolean | null;
  /** What the server answered, cut short. */
  reply: string | null;
}

/** What one session's conversation shows about Well Actually. */
export interface Conversation {
  agent: AuditAgent;
  session: string;
  /** The session a subagent's conversation belongs to, which its hooks report. Null for a session's own conversation. */
  parent: string | null;
  /** Where the conversation is: its file, or the OpenCode database. */
  source: string;
  cwd: string | null;
  started: string | null;
  updated: string;
  model: string | null;
  /** How many blocks of advice reached the agent. */
  advice: number;
  /** How often each principle was in those blocks, by its id. */
  principles: Record<string, number>;
  /** Blocks of advice that end before their closing tag, cut by the agent. */
  cut: number;
  /** Blocks of advice that ask the agent to rate it, as every whole one does. */
  asked: number;
  ratings: RatingCall[];
  /** Whether rate_principle was among the agent's tools, when the conversation tells. */
  rateTool: boolean | null;
  /** Whether the agent loaded the plugin in this session, when the conversation tells. Only Codex records it. */
  plugin: boolean | null;
  /** Hook runs of Well Actually the conversation recorded, and those that failed. Only Claude Code records them. */
  hookRuns: number | null;
  hookFailures: string[];
}

/** Advice opens with the tag on a line of its own. A tool description that names the tag does not. */
const OPEN = "<wellactually>\n";
const CLOSE = "</wellactually>";

function emptyConversation(agent: AuditAgent, session: string, source: string, updated: string): Conversation {
  return { agent, session, parent: null, source, cwd: null, started: null, updated, model: null, advice: 0, principles: {}, cut: 0, asked: 0, ratings: [], rateTool: null, plugin: null, hookRuns: null, hookFailures: [] };
}

/** Counts the advice in a text the agent was shown: its blocks, the principles in them, and the blocks that were cut. */
export function countAdvice(conversation: Conversation, text: string): void {
  let from = text.indexOf(OPEN);
  while (from !== -1) {
    const next = text.indexOf(OPEN, from + OPEN.length);
    const end = text.indexOf(CLOSE, from);
    const block = end !== -1 && (next === -1 || end < next) ? text.slice(from, end) : text.slice(from, next === -1 ? undefined : next);
    conversation.advice++;
    if (end === -1 || (next !== -1 && end > next)) {
      conversation.cut++;
    }
    if (block.includes("rate_principle")) {
      conversation.asked++;
    }
    for (const match of block.matchAll(/<principle id="([^"]+)"/g)) {
      const id = match[1] as string;
      conversation.principles[id] = (conversation.principles[id] ?? 0) + 1;
    }
    from = next;
  }
}

function short(text: string | null | undefined): string | null {
  if (!text) {
    return null;
  }
  const line = text.trim().replace(/\s+/g, " ");
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function recordedBy(reply: string | null): boolean | null {
  if (reply === null) {
    return null;
  }
  return reply.startsWith("Recorded ");
}

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "")).join("\n");
  }
  return "";
}

/** A rating made from inside a script, as Codex and OpenCode run them in code mode: `rate_principle({ id: "...", rating: "up" })`. */
function ratingsInCode(code: string): { id: string | null; rating: string | null }[] {
  const found: { id: string | null; rating: string | null }[] = [];
  for (const match of code.matchAll(/rate_principle\s*\(\s*(\{[^}]*\})/g)) {
    const args = match[1] as string;
    found.push({ id: /\bid\s*:\s*["'`]([^"'`]+)/.exec(args)?.[1] ?? null, rating: /\brating\s*:\s*["'`]([^"'`]+)/.exec(args)?.[1] ?? null });
  }
  return found;
}

/** Whether a record is from before the time the audit looks back to. A long session reaches further back than the hook log. */
function earlier(timestamp: unknown, since: number): boolean {
  return typeof timestamp === "string" && Date.parse(timestamp) < since;
}

function readLines(file: string): unknown[] {
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines: unknown[] = [];
  for (const line of source.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      lines.push(JSON.parse(line));
    } catch {
      // A line the agent was still writing.
    }
  }
  return lines;
}

/** The `.jsonl` files below `dir` changed since `since`, up to `depth` folders deep. */
function recentFiles(dir: string, since: number, depth: number, skip: (name: string) => boolean = () => false): string[] {
  const found: string[] = [];
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of names) {
    if (skip(entry.name)) {
      continue;
    }
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) {
      found.push(...recentFiles(file, since, depth - 1, skip));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try {
        if (fs.statSync(file).mtimeMs >= since) {
          found.push(file);
        }
      } catch {
        // Removed while we looked.
      }
    }
  }
  return found;
}

export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

export function opencodeDatabase(env: NodeJS.ProcessEnv = process.env): string {
  const data = env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(data, "opencode", "opencode.db");
}

/**
 * A Claude Code session: advice is a `hook_additional_context` attachment,
 * every hook it ran a `hook_success` or failure attachment with its command,
 * and a rating a `tool_use` of the plugin's MCP tool.
 */
export function readClaudeConversation(file: string, since = 0): Conversation {
  const updated = fs.statSync(file).mtime.toISOString();
  const conversation = emptyConversation("claude-code", path.basename(file, ".jsonl"), file, updated);
  conversation.hookRuns = 0;
  const calls = new Map<string, RatingCall>();
  for (const line of readLines(file) as any[]) {
    if (!line || typeof line !== "object") {
      continue;
    }
    conversation.started ??= typeof line.timestamp === "string" ? line.timestamp : null;
    conversation.cwd ??= typeof line.cwd === "string" ? line.cwd : null;
    if (earlier(line.timestamp, since)) {
      continue;
    }
    if (line.type === "attachment" && line.attachment) {
      const attachment = line.attachment;
      if (attachment.type === "hook_additional_context") {
        countAdvice(conversation, textOf(attachment.content));
      } else if (typeof attachment.type === "string" && attachment.type.startsWith("hook_") && typeof attachment.command === "string" && attachment.command.includes("wellactually")) {
        conversation.hookRuns++;
        if (attachment.type !== "hook_success" || (typeof attachment.exitCode === "number" && attachment.exitCode !== 0)) {
          conversation.hookFailures.push(short(`${attachment.hookName ?? attachment.hookEvent ?? "hook"}: ${attachment.stderr || attachment.content || attachment.type}`) ?? attachment.type);
        }
      } else if (JSON.stringify(attachment).includes("wellactually__rate_principle")) {
        conversation.rateTool = true;
      }
      continue;
    }
    const content = line.message?.content;
    if (line.type === "assistant") {
      conversation.model = typeof line.message?.model === "string" && line.message.model !== "<synthetic>" ? line.message.model : conversation.model;
      for (const part of Array.isArray(content) ? content : []) {
        if (part?.type === "tool_use" && typeof part.name === "string" && part.name.endsWith("rate_principle")) {
          conversation.rateTool = true;
          const call: RatingCall = { id: part.input?.id ?? null, rating: part.input?.rating ?? null, recorded: null, reply: null };
          calls.set(part.id, call);
          conversation.ratings.push(call);
        }
      }
    } else if (line.type === "user") {
      for (const part of Array.isArray(content) ? content : []) {
        const call = part?.type === "tool_result" ? calls.get(part.tool_use_id) : undefined;
        if (call) {
          call.reply = short(textOf(part.content));
          call.recorded = recordedBy(call.reply);
        }
      }
    }
  }
  return conversation;
}

/**
 * A Codex session: advice is a developer message that starts with
 * `<wellactually>`, and a rating an `McpToolCall` item, also when the agent
 * called the tool from a script. Codex does not record its hooks.
 */
export function readCodexConversation(file: string, since = 0): Conversation {
  const updated = fs.statSync(file).mtime.toISOString();
  const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(file)?.[1] ?? path.basename(file, ".jsonl");
  const conversation = emptyConversation("codex", id, file, updated);
  const items: RatingCall[] = [];
  const functionCalls = new Map<string, RatingCall>();
  let listed = false;
  let unlisted = false;
  let disabled = false;
  for (const line of readLines(file) as any[]) {
    const payload = line?.payload;
    if (!payload) {
      continue;
    }
    if (line.type === "session_meta") {
      conversation.session = typeof payload.id === "string" ? payload.id : conversation.session;
      // A subagent has a conversation of its own, and Codex reports its hooks under the session that started it.
      conversation.parent = typeof payload.session_id === "string" && payload.session_id !== conversation.session ? payload.session_id : null;
      conversation.cwd = typeof payload.cwd === "string" ? payload.cwd : conversation.cwd;
      conversation.started = typeof payload.timestamp === "string" ? payload.timestamp : conversation.started;
    } else if (line.type === "turn_context") {
      conversation.model = typeof payload.model === "string" ? payload.model : conversation.model;
      conversation.cwd ??= typeof payload.cwd === "string" ? payload.cwd : null;
      if (Array.isArray(payload.disabled_plugin_ids) && payload.disabled_plugin_ids.some((id: unknown) => typeof id === "string" && id.startsWith("wellactually@"))) {
        disabled = true;
      }
    } else if (line.type === "world_state" && payload.state) {
      conversation.model = typeof payload.state.model === "string" ? payload.state.model : conversation.model;
      // The skills of every plugin Codex loaded are listed with the folder they come from.
      const skills = JSON.stringify(payload.state.host_skills ?? "");
      if (/[\\/]wellactually[\\/][^\\/"]+[\\/]skills\b/.test(skills)) {
        listed = true;
      } else if (skills.includes("Skill roots")) {
        unlisted = true;
      }
    } else if (earlier(line.timestamp, since)) {
      continue;
    } else if (line.type === "response_item" && payload.type === "message" && payload.role === "developer") {
      const text = textOf(payload.content);
      if (text.trimStart().startsWith(OPEN.trim())) {
        countAdvice(conversation, text);
      }
    } else if (line.type === "response_item" && payload.type === "function_call" && typeof payload.name === "string" && payload.name.endsWith("rate_principle")) {
      let args: { id?: string; rating?: string } = {};
      try {
        args = JSON.parse(payload.arguments);
      } catch {
        // Arguments the model got wrong.
      }
      const call: RatingCall = { id: args.id ?? null, rating: args.rating ?? null, recorded: null, reply: null };
      functionCalls.set(payload.call_id, call);
    } else if (line.type === "response_item" && payload.type === "function_call_output" && functionCalls.has(payload.call_id)) {
      const call = functionCalls.get(payload.call_id) as RatingCall;
      call.reply = short(typeof payload.output === "string" ? payload.output : textOf(payload.output?.content ?? payload.output));
      call.recorded = recordedBy(call.reply);
    } else if (line.type === "event_msg" && payload.type === "item_completed" && payload.item?.type === "McpToolCall" && payload.item.tool === "rate_principle") {
      const item = payload.item;
      const reply = short(textOf(item.result?.content) || item.error?.message || (typeof item.error === "string" ? item.error : null));
      items.push({ id: item.arguments?.id ?? null, rating: item.arguments?.rating ?? null, recorded: recordedBy(reply), reply });
    }
  }
  if (listed && !disabled) {
    conversation.plugin = true;
  } else if (disabled || unlisted) {
    conversation.plugin = false;
  }
  // Newer versions record every MCP call as an item, older ones only as a function call.
  conversation.ratings = items.length > 0 ? items : [...functionCalls.values()];
  if (conversation.ratings.length > 0) {
    conversation.rateTool = true;
  }
  return conversation;
}

export function recentClaudeConversations(since: number, env: NodeJS.ProcessEnv = process.env): Conversation[] {
  // Subagents keep conversations of their own, next to the session's. Their advice is counted where they ran.
  return recentFiles(path.join(claudeHome(env), "projects"), since, 1).map((file) => readClaudeConversation(file, since));
}

export function recentCodexConversations(since: number, env: NodeJS.ProcessEnv = process.env): Conversation[] {
  return recentFiles(path.join(codexHome(env), "sessions"), since, 3).map((file) => readCodexConversation(file, since));
}

interface Row {
  [key: string]: unknown;
}

/**
 * OpenCode sessions changed since `since`, from its database, which it keeps
 * instead of files. OpenCode 2 has `session_v2` and `session_message`,
 * OpenCode 1 `session` and `part`. Only those tables are read, never the
 * others, which hold the user's credentials.
 *
 * Null when this Node has no SQLite, which came with Node 22.5.
 */
export async function recentOpencodeConversations(since: number, env: NodeJS.ProcessEnv = process.env): Promise<Conversation[] | null> {
  const file = opencodeDatabase(env);
  if (!fs.existsSync(file)) {
    return [];
  }
  let sqlite: typeof import("node:sqlite");
  try {
    // Node prints a warning on its first use of SQLite. It says nothing the user needs.
    const emit = process.emitWarning;
    process.emitWarning = () => {};
    try {
      sqlite = await import("node:sqlite");
    } finally {
      process.emitWarning = emit;
    }
  } catch {
    return null;
  }
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((row) => row.name));
    const found: Conversation[] = [];
    if (tables.has("session_v2") && tables.has("session_message")) {
      for (const session of db.prepare("SELECT id, directory, time_created, time_updated FROM session_v2 WHERE time_updated >= ?").all(since) as Row[]) {
        const messages = db.prepare("SELECT type, data FROM session_message WHERE session_id = ? AND time_created >= ? ORDER BY seq").all(session.id as string, since) as Row[];
        found.push(readOpencodeV2(session, messages, file));
      }
    }
    if (tables.has("session") && tables.has("part")) {
      for (const session of db.prepare("SELECT id, directory, time_created, time_updated FROM session WHERE time_updated >= ?").all(since) as Row[]) {
        const parts = db.prepare("SELECT data FROM part WHERE session_id = ? AND time_created >= ? ORDER BY time_created").all(session.id as string, since) as Row[];
        found.push(readOpencodeV1(session, parts, file));
      }
    }
    return found;
  } finally {
    db.close();
  }
}

function opencodeConversation(session: Row, source: string): Conversation {
  const conversation = emptyConversation("opencode", session.id as string, source, new Date(Number(session.time_updated)).toISOString());
  conversation.cwd = typeof session.directory === "string" ? session.directory : null;
  conversation.started = new Date(Number(session.time_created)).toISOString();
  return conversation;
}

function parse(data: unknown): any {
  try {
    return JSON.parse(String(data));
  } catch {
    return null;
  }
}

/** A tool call in OpenCode, which both versions describe by its name, its input and what it answered. */
function opencodeTool(conversation: Conversation, name: string, state: any): void {
  const answer = textOf(state?.content ?? state?.output ?? state?.error);
  // Advice for a tool call comes at the end of what the tool answered.
  countAdvice(conversation, answer);
  const reply = short(answer);
  if (name.endsWith("rate_principle")) {
    conversation.rateTool = true;
    const args = (state?.input ?? {}) as { id?: string; rating?: string };
    conversation.ratings.push({ id: args.id ?? null, rating: args.rating ?? null, recorded: recordedBy(reply), reply });
    return;
  }
  // In code mode the agent calls tools from a script, and OpenCode lists the calls the script made.
  const nested = Array.isArray(state?.metadata?.toolCalls) ? state.metadata.toolCalls : null;
  const calls = nested
    ? nested
        .filter((call: any) => typeof call?.tool === "string" && call.tool.endsWith("rate_principle"))
        .map((call: any) => ({ id: call.input?.id ?? null, rating: call.input?.rating ?? null }))
    : ratingsInCode(typeof state?.input?.code === "string" ? state.input.code : "");
  for (const call of calls as { id: string | null; rating: string | null }[]) {
    conversation.rateTool = true;
    const recorded = answer.includes(`Recorded ${call.rating} for ${call.id}`);
    conversation.ratings.push({ ...call, recorded, reply });
  }
}

function readOpencodeV2(session: Row, messages: Row[], source: string): Conversation {
  const conversation = opencodeConversation(session, source);
  for (const message of messages) {
    const data = parse(message.data);
    if (!data) {
      continue;
    }
    if (message.type === "synthetic" || message.type === "system") {
      countAdvice(conversation, textOf(data.text ?? data.content));
    } else if (message.type === "assistant") {
      conversation.model = typeof data.model?.id === "string" ? data.model.id : conversation.model;
      for (const part of Array.isArray(data.content) ? data.content : []) {
        if (part?.type === "tool" && typeof part.name === "string") {
          opencodeTool(conversation, part.name, part.state);
        }
      }
    }
  }
  return conversation;
}

function readOpencodeV1(session: Row, parts: Row[], source: string): Conversation {
  const conversation = opencodeConversation(session, source);
  for (const row of parts) {
    const part = parse(row.data);
    if (part?.type === "text" && part.synthetic) {
      countAdvice(conversation, textOf(part.text));
    } else if (part?.type === "tool" && typeof part.tool === "string") {
      opencodeTool(conversation, part.tool, part.state);
    }
  }
  return conversation;
}
