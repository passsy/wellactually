import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boardHome } from "@wellactually/core/node";

/** Which agent sent a rating, and which model was answering when it did. */
export interface Rater {
  /** `claude-code`, `codex`, or the MCP client's own name for anything else. */
  agent: string | null;
  /** The model id as the agent reports it, such as claude-opus-5-5 or gpt-6.1-sol. */
  model: string | null;
}

/** What the registry accepts as an agent or a model id. Anything else is left out of the rating. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,79}$/;

/** How much of a transcript is searched for the tool call, from its end. */
const TRANSCRIPT_TAIL = 8 * 1024 * 1024;

/**
 * Works out who is rating from what the agent itself tells the MCP server,
 * never from what the model says about itself.
 *
 * Codex puts the model of the turn into every tool call. Claude Code only
 * names the tool call, and the model that made it is in the session's
 * transcript: the hook notes where that is before the call reaches the server.
 */
export function raterOf(clientName: string | undefined, meta: Record<string, unknown> | undefined): Rater {
  const agent = agentOf(clientName);
  let model: string | null = null;
  const turn = meta?.["x-codex-turn-metadata"];
  if (turn && typeof turn === "object" && typeof (turn as { model?: unknown }).model === "string") {
    model = (turn as { model: string }).model;
  }
  const toolUseId = meta?.["claudecode/toolUseId"];
  if (!model && typeof toolUseId === "string") {
    model = claudeModel(toolUseId);
  }
  return { agent: agent && NAME.test(agent) ? agent : null, model: model && NAME.test(model) ? model : null };
}

function agentOf(clientName: string | undefined): string | null {
  if (!clientName) {
    return null;
  }
  if (clientName === "claude-code") {
    return "claude-code";
  }
  if (clientName.startsWith("codex")) {
    return "codex";
  }
  return clientName;
}

/**
 * Notes, from the hook that runs right before a rating, which transcript the
 * tool call is in. The MCP server is not told, and a session can change its
 * transcript after the server started.
 */
export function noteToolUse(toolUseId: string, transcript: string): void {
  const dir = path.join(boardHome(), "tool-uses");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${safe(toolUseId)}.json`), JSON.stringify({ transcript }), { mode: 0o600 });
  // Each note is read once, within seconds. Older ones are only clutter.
  const stale = Date.now() - 86_400_000;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < stale) {
        fs.rmSync(file, { force: true });
      }
    } catch {
      // Another hook removed it first.
    }
  }
}

/** The model of the Claude Code message that made the tool call `toolUseId`. */
function claudeModel(toolUseId: string): string | null {
  const note = path.join(boardHome(), "tool-uses", `${safe(toolUseId)}.json`);
  const transcripts: string[] = [];
  try {
    const { transcript } = JSON.parse(fs.readFileSync(note, "utf8")) as { transcript?: unknown };
    if (typeof transcript === "string") {
      transcripts.push(transcript);
    }
    fs.rmSync(note, { force: true });
  } catch {
    // No note: the hook did not run, or is older than this server.
  }
  const session = process.env.CLAUDE_CODE_SESSION_ID;
  if (transcripts.length === 0 && session) {
    const projects = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects");
    for (const project of safeList(projects)) {
      transcripts.push(path.join(projects, project, `${safe(session)}.jsonl`));
    }
  }
  for (const transcript of transcripts) {
    // A subagent's tool calls are in transcripts of their own, next to the session's.
    const subagents = path.join(transcript.replace(/\.jsonl$/, ""), "subagents");
    for (const file of [transcript, ...safeList(subagents).map((name) => path.join(subagents, name))]) {
      const model = modelInTranscript(file, toolUseId);
      if (model) {
        return model;
      }
    }
  }
  return null;
}

/** Finds the assistant message that holds the tool call and returns its model. */
export function modelInTranscript(file: string, toolUseId: string): string | null {
  let text: string;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - TRANSCRIPT_TAIL);
    const handle = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(handle, buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null;
  }
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index] as string;
    if (!line.includes(toolUseId)) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as { type?: string; message?: { model?: unknown; content?: unknown } };
      const content = Array.isArray(entry.message?.content) ? (entry.message.content as { type?: string; id?: string }[]) : [];
      const model = entry.message?.model;
      if (entry.type === "assistant" && content.some((part) => part.type === "tool_use" && part.id === toolUseId) && typeof model === "string" && !model.startsWith("<")) {
        return model;
      }
    } catch {
      // The first line of the tail can be cut in half.
    }
  }
  return null;
}

function safe(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
