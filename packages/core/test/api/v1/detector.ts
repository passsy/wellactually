/**
 * The source of the frozen bundle next to this file. It was built once, by
 * the toolchain of detector API 1, and is never built again: the point of the
 * bundle is that it carries the SDK of that time.
 *
 * It reports one finding for everything about its event that API 1 promised,
 * so a host that stops keeping one of those promises loses that finding.
 */
import { findWord, mentioned, writtenLines, type Ctx, type EventName, type Finding } from "@wellactually/sdk";

export const events: EventName[] = ["write", "prompt"];
export const globs = ["lib/**/*.dart"];

export function* detect(ctx: Ctx): Generator<Finding> {
  yield* mentioned(ctx, ["late keyword"]);
  const file = ctx.file;
  if (!file) {
    return;
  }
  const said = (word: string): Finding => ({ line: 1, evidence: word });
  const everything = ctx as unknown as Record<string, unknown>;
  const fileKeys = Object.keys(file).sort().join(",");
  const keys = Object.keys(everything).sort().join(",");
  // In API 1 a path is relative, with forward slashes.
  if (file.path === "lib/session.dart" && file.name === "session.dart" && file.ext === ".dart") {
    yield said("relative");
  }
  if (fileKeys === "content,ext,lines,name,path,written" && keys === "event,file,isCommand,isConversation,isUserPrompt,text") {
    yield said("shape");
  }
  // The isolate of API 1 could not ask the host for anything.
  if (typeof (globalThis as Record<string, unknown>).__fs === "undefined" && typeof (globalThis as Record<string, unknown>).__cwd === "undefined") {
    yield said("alone");
  }
  for (const written of writtenLines(ctx)) {
    if (findWord(written.text, "late") !== -1) {
      yield { line: written.line, evidence: written.text.trim() };
    }
  }
}
