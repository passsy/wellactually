/**
 * Detector API 4: what a detector written against it imports.
 *
 *     import { onDelete, onPrompt, onWrite, mentioned } from "@wellactually/sdk/v4";
 *
 * The path is the declaration. A principle whose files import from here is
 * built against version 4 and is handed the events of version 4 for as long
 * as that version is run, also when it is uploaded again after the API has
 * moved on. Its tests import `@wellactually/sdk/v4/test`.
 *
 * In version 4 a detector registers a handler per event, with `onWrite`,
 * `onRead`, `onDelete`, `onPrompt`, `onCommand` and `onOutput`. Each handler
 * gets the event of its kind and yields findings. A write knows the lines
 * the agent removed as well as the ones it wrote. It can read files through
 * `node:fs`.
 */
export type { CommandEvent, DeleteEvent, Depth, EventName, File, FileEvent, Finding, Findings, OutputEvent, PromptEvent, ReadEvent, RemovedLine, TextFinding, WriteEvent, WrittenLine } from "./index.js";
export { EVENTS, findWord, lineAt, mentioned } from "./index.js";
export { matchesGlob, matchesGlobs } from "./glob.js";
export type { FileOptions } from "./handlers.js";
export { findUp } from "./find.ts";
export { onCommand, onDelete, onOutput, onPrompt, onRead, onWrite } from "./handlers.js";
