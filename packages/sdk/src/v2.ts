/**
 * Detector API 2: what a detector written against it imports.
 *
 *     import { writtenLines, type Ctx, type Finding } from "@wellactually/sdk/v2";
 *
 * The path is the declaration. A principle whose files import from here is
 * built against version 2 and is handed the event of version 2 for as long
 * as that version is run, also when it is uploaded again after the API has
 * moved on. Its tests import `@wellactually/sdk/v2/test`.
 *
 * In version 2 `file.path` is absolute, the event carries `file.relativePath`,
 * `file.isNew` and `project`, and a detector can read files through `node:fs`.
 */
export type { CodeSyntax, Ctx, Depth, Detector, EventName, FileContext, Finding, Findings, WrittenLine } from "./index.ts";
export { blankCommentsAndStrings, C_LIKE, EVENTS, findWord, HASH_LIKE, lineAt, mentioned, writtenLines } from "./index.ts";
