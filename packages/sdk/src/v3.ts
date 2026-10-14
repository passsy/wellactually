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
 */
export type { CommandEvent, Depth, EventName, File, FileEvent, Finding, Findings, OutputEvent, PromptEvent, ReadEvent, TextFinding, WriteEvent, WrittenLine } from "./index.ts";
export { EVENTS, findWord, lineAt, mentioned } from "./index.ts";
export { matchesGlob, matchesGlobs } from "./glob.ts";
export type { FileOptions } from "./handlers.ts";
export { findUp } from "./find.ts";
export { onCommand, onOutput, onPrompt, onRead, onWrite } from "./handlers.ts";
