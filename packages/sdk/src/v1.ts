/**
 * Detector API 1: what a detector that stays on it imports.
 *
 *     import { writtenLines, type Ctx, type Finding } from "@wellactually/sdk/v1";
 *
 * In version 1 `file.path` is relative, there is no `project`, and a detector
 * can reach nothing outside its event. The types here are the event of that
 * version, so a detector that uses what came later does not compile.
 */
import type { CtxV1, Findings } from "./index.ts";

export type Ctx = CtxV1;
export type FileContext = NonNullable<CtxV1["file"]>;

/** The shape of a detector module. */
export interface Detector {
  detect: (ctx: Ctx) => Findings | null | undefined;
}

export type { CodeSyntax, Depth, EventName, Finding, Findings, WrittenLine } from "./index.ts";
export { blankCommentsAndStrings, C_LIKE, EVENTS, findWord, HASH_LIKE, lineAt, mentioned, writtenLines } from "./index.ts";
