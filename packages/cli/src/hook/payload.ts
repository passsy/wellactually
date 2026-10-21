import path from "node:path";
import { fileCtx, locateWritten, textCtx, type Change, type Ctx, type Where, type Written } from "@wellactually/sdk";
import { removedLines, type TurnDiff } from "./turn.ts";
import { projectRootOf, toPosix } from "../board/files.ts";

/** The fields of a Claude Code or Codex hook payload this host reads. */
export interface HookPayload {
  hook_event_name?: string;
  tool_name?: string;
  session_id?: string;
  /** Claude Code's id of the subagent a call comes from. Absent on the main thread. */
  agent_id?: string;
  /** Claude Code's record of the session, with the model of every message. */
  transcript_path?: string;
  /** Set by the plugins for agents without hooks of their own, which run the hook through a bridge. */
  agent?: "opencode" | "pi";
  /** Claude Code's id of the tool call, which an MCP server is told too. */
  tool_use_id?: string;
  cwd?: string;
  prompt?: string;
  tool_input?: {
    file_path?: string;
    content?: string;
    new_string?: string;
    edits?: { new_string?: string }[];
    /** A Claude shell command. Codex also carries the body of an apply_patch here. */
    command?: string;
    /** A Codex exec_command shell command. */
    cmd?: string;
    /** For hosts that name the patch body explicitly. */
    patch?: string;
    /** What the agent hands to a subagent. */
    prompt?: string;
  };
  /**
   * What the tool answered. Claude Code says here whether a Write created the
   * file, what a file was before a Write or an Edit, and what a shell command
   * printed. Some hosts answer a command with plain text.
   */
  tool_response?: { type?: string; originalFile?: string | null; stdout?: string; stderr?: string; output?: string } | string | null;
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit"]);
const SHELL_TOOLS = new Set(["Bash", "exec_command"]);
/** The tools that start a subagent. What they are given is a prompt like the user's. */
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);
/** What a command printed can be very long, and a detector reads all of what it is given. */
const MAX_OUTPUT_LENGTH = 200_000;

/** What a shell command printed, as one text: standard output, then errors. */
function printed(response: HookPayload["tool_response"]): string {
  if (typeof response === "string") {
    return response;
  }
  return [response?.stdout, response?.stderr, response?.output].filter((part): part is string => typeof part === "string" && part !== "").join("\n");
}

/**
 * Turns what an agent reports into the events detectors see.
 *
 * This is the one place that knows how Claude Code and Codex describe a
 * session. A detector, and a principle's tests, only ever deal with the
 * result. Most payloads are one event; a Codex patch is one per file it
 * changes; a shell command that ran is one per file it wrote, and one for
 * what it printed; a payload that is none of a detector's business is none.
 *
 * `readFile` gets an absolute path and returns the file as it is after the
 * tool ran, or null when it cannot be read as text. `readBefore` returns it
 * as it was before, when the agent did not say so itself, or null when that
 * is not known. What a file tool removed is the difference.
 *
 * Where an event happened is worked out for each file, from the file. The
 * session's working directory only stands in when there is no file: for a
 * prompt and for a command.
 *
 * `turn` is what changed in the session's git repositories while a shell
 * command ran. Each changed file is written like one from Write, whichever
 * program wrote it. What a command writes outside a git repository is not
 * seen. A file a shell command deleted there is a `delete` event.
 */
export function eventsOf(payload: HookPayload, readFile: (absolute: string) => string | null, turn?: TurnDiff, readBefore: (absolute: string) => string | null = () => null): Ctx[] {
  const event = payload.hook_event_name ?? "";
  const tool = payload.tool_name ?? "";
  const input = payload.tool_input ?? {};
  const cwd = payload.cwd ?? process.cwd();
  const sessionRoot = (): string | null => {
    const root = projectRootOf(cwd);
    return root === null ? null : toPosix(root);
  };
  const file = (kind: "write" | "read" | "delete", absolute: string, content: string, change: Change = {}, isNew = false): Ctx => {
    const { relativePath, where } = locate(absolute, cwd);
    return fileCtx(kind, relativePath, content, change, { ...where, isNew });
  };
  const response = typeof payload.tool_response === "string" ? null : payload.tool_response;
  // What the file was before this tool ran: as the agent reports it, or as the last look at its repository saw it.
  const before = (absolute: string): string | null => {
    if (typeof response?.originalFile === "string") {
      return response.originalFile;
    }
    return readBefore(absolute);
  };
  const removedFrom = (absolute: string, content: string): Written[] => {
    const was = before(absolute);
    if (was === null) {
      return [];
    }
    return removedLines(was, content);
  };

  if (event === "UserPromptSubmit") {
    return payload.prompt ? [textCtx("prompt", payload.prompt, sessionRoot(), "", toPosix(cwd))] : [];
  }
  if (event === "PreToolUse" && SHELL_TOOLS.has(tool)) {
    const command = input.command ?? input.cmd;
    return command ? [textCtx("command", command, sessionRoot(), "", toPosix(cwd))] : [];
  }
  if (event === "PreToolUse" && SUBAGENT_TOOLS.has(tool)) {
    return input.prompt ? [textCtx("prompt", input.prompt, sessionRoot(), "", toPosix(cwd))] : [];
  }
  if (event !== "PostToolUse") {
    return [];
  }

  if (SHELL_TOOLS.has(tool)) {
    const command = input.command ?? input.cmd ?? "";
    // A file the command changed, like `dart run build_runner build` does, is written like one from Write.
    const writes = (turn?.writes ?? []).flatMap(({ file: absolute, written, removed, isNew }) => {
      const content = readFile(absolute);
      return content === null ? [] : [file("write", absolute, content, { written, removed }, isNew)];
    });
    const deletes = (turn?.deletes ?? []).map(({ file: absolute, content }) => file("delete", absolute, content));
    const text = printed(payload.tool_response).slice(0, MAX_OUTPUT_LENGTH);
    return text.trim() === "" ? [...writes, ...deletes] : [...writes, ...deletes, textCtx("output", text, sessionRoot(), command, toPosix(cwd))];
  }

  if (tool === "apply_patch") {
    return patchedFiles(input.command ?? input.patch ?? "").flatMap(({ file: patched, from, added, isNew, isDeleted }) => {
      const absolute = path.resolve(cwd, patched);
      if (isDeleted) {
        // The patch does not say what the file held. The last look at its repository may.
        const was = readBefore(absolute);
        return was === null ? [] : [file("delete", absolute, was)];
      }
      // A new file that is not on disk is still fully described by its patch.
      const content = readFile(absolute) ?? (isNew ? added.join("\n") : null);
      if (content === null) {
        return [];
      }
      const was = isNew ? null : readBefore(path.resolve(cwd, from));
      const removed = was === null ? [] : removedLines(was, content);
      if (added.length === 0 && removed.length === 0) {
        return [];
      }
      return [file("write", absolute, content, { written: locateWritten(content, added), removed }, isNew)];
    });
  }

  if (!input.file_path) {
    return [];
  }
  const absolute = path.resolve(cwd, input.file_path);
  const content = readFile(absolute);
  if (content === null) {
    return [];
  }
  if (tool === "Read") {
    return [file("read", absolute, content)];
  }
  if (tool === "Write") {
    const created = response?.type === "create" || (response !== null && response !== undefined && "originalFile" in response && response.originalFile === null);
    if (created) {
      return [file("write", absolute, content, {}, true)];
    }
    return [file("write", absolute, content, { removed: removedFrom(absolute, content) })];
  }
  if (!EDIT_TOOLS.has(tool)) {
    return [];
  }
  const fragments = tool === "Edit" ? [input.new_string ?? ""] : (input.edits ?? []).map((edit) => edit.new_string ?? "");
  return [file("write", absolute, content, { written: locateWritten(content, fragments), removed: removedFrom(absolute, content) })];
}

/**
 * Where a file is: its project root and its path from there.
 *
 * Outside any repository there is no root. The path a principle's globs are
 * matched against is then the one from the session's directory, or just the
 * file's name when the file is not below it either.
 */
function locate(absolute: string, cwd: string): { relativePath: string; where: Where } {
  const root = projectRootOf(path.dirname(absolute));
  if (root !== null) {
    return { relativePath: toPosix(path.relative(root, absolute)), where: { root: toPosix(root), absolute: toPosix(absolute) } };
  }
  const fromSession = path.relative(cwd, absolute);
  const outside = fromSession.startsWith("..") || path.isAbsolute(fromSession);
  return { relativePath: outside ? path.basename(absolute) : toPosix(fromSession), where: { root: null, absolute: toPosix(absolute) } };
}

interface PatchedFile {
  /** Where the file is after the patch. */
  file: string;
  /** Where the file was before the patch, which differs when it moved. */
  from: string;
  /** Each run of consecutive `+` lines, as one piece of text. */
  added: string[];
  isNew: boolean;
  isDeleted: boolean;
}

/**
 * The files a Codex `apply_patch` body adds, updates or deletes, with the text it adds to each.
 *
 * Only the `+` lines are what the agent wrote. Context lines and removed
 * lines were there before. What was removed is found by comparing the file
 * with what it was, because a patch does not say where its lines were.
 */
function patchedFiles(patch: string): PatchedFile[] {
  const files: PatchedFile[] = [];
  let current: PatchedFile | null = null;
  let run: string[] = [];
  const endRun = (): void => {
    if (current && run.length > 0) {
      current.added.push(run.join("\n"));
    }
    run = [];
  };

  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      endRun();
      const named = (header[2] ?? "").trim();
      current = { file: named, from: named, added: [], isNew: header[1] === "Add", isDeleted: header[1] === "Delete" };
      files.push(current);
      continue;
    }
    const moved = /^\*\*\* Move to: (.+)$/.exec(line);
    if (moved && current) {
      current.file = (moved[1] ?? "").trim();
      continue;
    }
    if (current && line.startsWith("+")) {
      run.push(line.slice(1));
      continue;
    }
    endRun();
  }
  endRun();
  return files;
}

