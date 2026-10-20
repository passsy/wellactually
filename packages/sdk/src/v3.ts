/**
 * Detector API 3: what a detector written against it imports.
 *
 *     import { onPrompt, onWrite, mentioned } from "@wellactually/sdk/v3";
 *
 * The path is the declaration. A principle whose files import from here is
 * built against version 3 and is handed the events of version 3 for as long
 * as that version is run, also when it is uploaded again after the API has
 * moved on. Its tests import `@wellactually/sdk/v3/test`.
 *
 * In version 3 a detector registers a handler per event, with `onWrite`,
 * `onRead`, `onPrompt`, `onCommand` and `onOutput`. Each handler gets the
 * event of its kind and yields findings. It can read files through `node:fs`.
 *
 * The events of version 3 are frozen here as they were. Version 4 added
 * removed lines and deleted files, which a detector of version 3 never sees.
 */
import type { File, ReadEvent, TextFinding, WrittenLine } from "./index.ts";
import { onCommand as onCommandNow, onOutput as onOutputNow, onPrompt as onPromptNow, onRead as onReadNow, onWrite as onWriteNow, type FileOptions } from "./handlers.ts";

export type { CommandEvent, Depth, File, Findings, OutputEvent, PromptEvent, ReadEvent, TextFinding, WrittenLine } from "./index.ts";
export { findWord, lineAt, mentioned } from "./index.ts";
export { matchesGlob, matchesGlobs } from "./glob.ts";
export type { FileOptions } from "./handlers.ts";
export { findUp } from "./find.ts";

/** What happened in the session, as version 3 knows it. */
export type EventName = "write" | "read" | "prompt" | "command" | "output";

export const EVENTS: readonly EventName[] = ["write", "read", "prompt", "command", "output"];

/** The agent wrote or edited a file. */
export interface WriteEvent {
  event: "write";
  file: File;
  /** The file content. */
  text: string;
  /** `text` split into lines. A finding's `line` counts in here. */
  lines: string[];
  /** The root of the project, the nearest folder upwards with a `.git`, or null. */
  project: string | null;
  /** The lines the agent wrote. Code that was there before is not in here. */
  written: WrittenLine[];
}

/** An event that carries a file, for a helper that serves `onWrite` and `onRead` alike. */
export type FileEvent = WriteEvent | ReadEvent;

/** What a handler of `onWrite`, `onRead` or `onOutput` yields. Nothing in it is required. */
export interface Finding extends TextFinding {
  /** 1-based line of the event's text: of the file, or of what a command printed. */
  line?: number;
  /** The last line, when the finding spans several. Needs `line`. */
  endLine?: number;
}

/** Runs when the agent wrote or edited a file. `event.written` holds the lines it wrote. */
export const onWrite: <F extends Finding>(options: FileOptions<WriteEvent, F>) => void = onWriteNow as never;

/** Runs when the agent read a file. It did not write this code, so judge the place, not the author. */
export const onRead: <F extends Finding>(options: FileOptions<ReadEvent, F>) => void = onReadNow;

/** Runs when the user typed a message, and when the agent briefed a subagent. */
export const onPrompt: typeof onPromptNow = onPromptNow;

/** Runs before the agent runs a shell command. */
export const onCommand: typeof onCommandNow = onCommandNow;

/** Runs after a shell command, on what it printed. */
export const onOutput: typeof onOutputNow = onOutputNow;

