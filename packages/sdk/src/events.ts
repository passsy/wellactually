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
  return fileCtx("write", path, content, undefined, { isNew: options.isNew === true });
}

/**
 * The agent edited a file. `content` is the file after the edit and
 * `change.written` is the text the agent put in, as one piece or several.
 */
export function edit(path: string, content: string, change: { written: string | readonly string[] }): Ctx {
  const fragments = typeof change.written === "string" ? [change.written] : change.written;
  const written = locateWritten(content, fragments);
  if (written.length === 0) {
    throw new Error(`edit("${path}"): the written text does not occur in the file. Pass the file as it is after the edit.`);
  }
  return fileCtx("write", path, content, written);
}

/** The agent read this file. It wrote none of it. */
export function read(path: string, content: string): Ctx {
  return fileCtx("read", path, content);
}

/** The user typed this. */
export function prompt(text: string): Ctx {
  return textCtx("prompt", text);
}

/** The agent is about to run this shell command. */
export function command(text: string): Ctx {
  return textCtx("command", text);
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
