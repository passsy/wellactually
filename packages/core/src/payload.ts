import path from "node:path";
import { fileCtx, locateWritten, textCtx, type Ctx, type Where, type WrittenLine } from "@wellactually/sdk";
import { projectRootOf, toPosix } from "./fs.ts";

/** The fields of a Claude Code or Codex hook payload this host reads. */
export interface HookPayload {
  hook_event_name?: string;
  tool_name?: string;
  session_id?: string;
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
  };
  /** What the tool answered. Claude Code says here whether a Write created the file. */
  tool_response?: { type?: string; originalFile?: string | null } | null;
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit"]);
const SHELL_TOOLS = new Set(["Bash", "exec_command"]);

/**
 * Turns what an agent reports into the events detectors see.
 *
 * This is the one place that knows how Claude Code and Codex describe a
 * session. A detector, and a principle's tests, only ever deal with the
 * result. Most payloads are one event; a Codex patch is one per file it
 * changes; a payload that is none of a detector's business is none.
 *
 * `readFile` gets an absolute path and returns the file as it is after the
 * tool ran, or null when it cannot be read as text.
 *
 * Where an event happened is worked out for each file, from the file. The
 * session's working directory only stands in when there is no file: for a
 * prompt and for a command.
 */
export function eventsOf(payload: HookPayload, readFile: (absolute: string) => string | null): Ctx[] {
  const event = payload.hook_event_name ?? "";
  const tool = payload.tool_name ?? "";
  const input = payload.tool_input ?? {};
  const cwd = payload.cwd ?? process.cwd();
  const sessionRoot = (): string | null => {
    const root = projectRootOf(cwd);
    return root === null ? null : toPosix(root);
  };
  const file = (kind: "write" | "read", absolute: string, content: string, written?: WrittenLine[], isNew = false): Ctx => {
    const { relativePath, where } = locate(absolute, cwd);
    return fileCtx(kind, relativePath, content, written, { ...where, isNew });
  };

  if (event === "UserPromptSubmit") {
    return payload.prompt ? [textCtx("prompt", payload.prompt, sessionRoot())] : [];
  }
  if (event === "PreToolUse" && SHELL_TOOLS.has(tool)) {
    const command = input.command ?? input.cmd;
    return command ? [textCtx("command", command, sessionRoot())] : [];
  }
  if (event !== "PostToolUse") {
    return [];
  }

  if (tool === "apply_patch") {
    return patchedFiles(input.command ?? input.patch ?? "").flatMap(({ file: patched, added, isNew }) => {
      const absolute = path.resolve(cwd, patched);
      // A new file that is not on disk is still fully described by its patch.
      const content = readFile(absolute) ?? (isNew ? added.join("\n") : null);
      return content === null || added.length === 0 ? [] : [file("write", absolute, content, locateWritten(content, added), isNew)];
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
    const response = payload.tool_response;
    const created = response?.type === "create" || (response !== null && response !== undefined && "originalFile" in response && response.originalFile === null);
    return [file("write", absolute, content, undefined, created)];
  }
  if (!EDIT_TOOLS.has(tool)) {
    return [];
  }
  const fragments = tool === "Edit" ? [input.new_string ?? ""] : (input.edits ?? []).map((edit) => edit.new_string ?? "");
  return [file("write", absolute, content, locateWritten(content, fragments))];
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
  /** Each run of consecutive `+` lines, as one piece of text. */
  added: string[];
  isNew: boolean;
}

/**
 * The files a Codex `apply_patch` body adds or updates, with the text it adds to each.
 *
 * Only the `+` lines are what the agent wrote. Context lines and removed
 * lines were there before, and a deleted file leaves nothing to judge.
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
      current = header[1] === "Delete" ? null : { file: (header[2] ?? "").trim(), added: [], isNew: header[1] === "Add" };
      if (current) {
        files.push(current);
      }
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
