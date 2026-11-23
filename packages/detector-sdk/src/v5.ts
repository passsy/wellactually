/**
 * Detector API 5: what a detector written against it imports.
 *
 *     import { onPrompt, onTool, onWrite, mentioned } from "@wellactually/detector-sdk/v5";
 *
 * The path is the declaration. A principle whose files import from here is
 * built against version 5 and is handed the events of version 5 for as long
 * as that version is run, also when it is uploaded again after the API has
 * moved on. Its tests import `@wellactually/detector-sdk/v5/test`.
 *
 * In version 5 a detector registers a handler per event, with `onWrite`,
 * `onRead`, `onDelete`, `onPrompt`, `onCommand`, `onOutput` and `onTool`.
 * Each handler gets the event of its kind and yields findings. `onTool` runs
 * before the agent calls a tool of an MCP server. It can read files through
 * `node:fs`.
 */
export type { CommandEvent, DeleteEvent, Depth, EventName, File, FileEvent, Finding, Findings, OutputEvent, PromptEvent, ReadEvent, RemovedLine, TextFinding, ToolEvent, WriteEvent, WrittenLine } from "./index.ts";
export { EVENTS, findWord, lineAt, mentioned } from "./index.ts";
export { matchesGlob, matchesGlobs } from "./glob.ts";
export type { FileOptions } from "./handlers.ts";
export { findUp } from "./find.ts";
export { onCommand, onDelete, onOutput, onPrompt, onRead, onTool, onWrite } from "./handlers.ts";
