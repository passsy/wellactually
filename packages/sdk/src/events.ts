/**
 * The events a test shows to a detector.
 *
 * They are the same in every runner: vitest on the author's machine,
 * `wellactually test`, the browser editor and the registry. A path is relative
 * to a made-up project root, and the detector sees it below that root.
 */
import { fileCtx, locateWritten, textCtx, type Ctx } from "./index.ts";

/** What `detect` takes besides the event. */
export interface DetectOptions {
  /**
   * A folder of the principle, e.g. "fixtures/flutter_app", that is the
   * project the event happens in. The detector reads its files with `node:fs`.
   * Without it the only file there is, anywhere, is the file of the event.
   */
  project?: string;
}

/**
 * The agent wrote this file in full. Every line counts as written.
 * Pass `{ isNew: true }` when the write created the file.
 */
export function write(path: string, content: string, options: { isNew?: boolean } = {}): Ctx {
  return fileCtx("write", path, content, {}, { isNew: options.isNew === true });
}

/** What `edit` takes besides the file after the edit. */
export interface EditChange {
  /** The text the agent put in, as one piece or several. */
  written?: string | readonly string[];
  /** The text the agent took out, as one piece or several. Needs `before`, where it is found. */
  removed?: string | readonly string[];
  /** The file as it was before the edit. A removed line has the line it had there. */
  before?: string;
}

/**
 * The agent edited a file. `content` is the file after the edit,
 * `change.written` is the text the agent put in, and `change.removed` the
 * text it took out of `change.before`.
 */
export function edit(path: string, content: string, change: EditChange): Ctx {
  const written = locateWritten(content, piecesOf(change.written));
  const removedPieces = piecesOf(change.removed);
  if (written.length === 0 && removedPieces.length === 0) {
    throw new Error(`edit("${path}"): pass the text the agent wrote as written, or the text it removed as removed.`);
  }
  if (change.written !== undefined && written.length === 0) {
    throw new Error(`edit("${path}"): the written text does not occur in the file. Pass the file as it is after the edit.`);
  }
  if (removedPieces.length === 0) {
    return fileCtx("write", path, content, { written });
  }
  if (change.before === undefined) {
    throw new Error(`edit("${path}"): pass the file as it was before the edit as before, so the removed lines have their line numbers.`);
  }
  const removed = locateWritten(change.before, removedPieces);
  if (removed.length === 0) {
    throw new Error(`edit("${path}"): the removed text does not occur in before. Pass the file as it was before the edit.`);
  }
  return fileCtx("write", path, content, { written, removed });
}

function piecesOf(text: string | readonly string[] | undefined): readonly string[] {
  if (text === undefined) {
    return [];
  }
  if (typeof text === "string") {
    return [text];
  }
  return text;
}

/** The agent deleted this file. `content` is what it held. Every line of it counts as removed. */
export function deleted(path: string, content: string): Ctx {
  return fileCtx("delete", path, content);
}

/** The agent read this file. It wrote none of it. */
export function read(path: string, content: string): Ctx {
  return fileCtx("read", path, content);
}

/** The user typed this, or the agent handed it to a subagent. */
export function prompt(text: string): Ctx {
  return textCtx("prompt", text);
}

/** The agent is about to run this shell command. */
export function command(text: string): Ctx {
  return textCtx("command", text);
}

/** `command` ran, and this is what it printed. */
export function output(command: string, text: string): Ctx {
  return textCtx("output", text, undefined, command);
}

/**
 * A multi-line string without the indentation of the test around it.
 *
 * `${` and a backtick inside it need a backslash, as in any template string.
 */
export function source(strings: TemplateStringsArray, ...values: unknown[]): string {
  const text = strings.raw.reduce((out, part, index) => out + part.replace(/\\([`$\\])/g, "$1") + (index < values.length ? String(values[index]) : ""), "");
  const lines = text.split("\n");
  if (lines[0]?.trim() === "") {
    lines.shift();
  }
  if (lines.at(-1)?.trim() === "") {
    lines.pop();
  }
  const indent = Math.min(...lines.filter((line) => line.trim() !== "").map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0));
  return lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join("\n");
}
