/**
 * The source of the frozen bundle next to this file. It was built once, by
 * the toolchain of detector API 2, and is never built again: the point of the
 * bundle is that it carries the SDK of that time.
 *
 * It reports one finding for everything about its event that API 2 promised,
 * so a host that stops keeping one of those promises loses that finding.
 */
import fs from "node:fs";
import path from "node:path";
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
  const fileKeys = Object.keys(file).sort().join(",");
  const keys = Object.keys(ctx).sort().join(",");
  // In API 2 a path is absolute, and the path from the project root is next to it.
  if (file.path === "/project/lib/session.dart" && file.relativePath === "lib/session.dart" && file.name === "session.dart" && file.ext === ".dart") {
    yield said("absolute");
  }
  if (fileKeys === "content,ext,isNew,lines,name,path,relativePath,written" && keys === "event,file,isCommand,isConversation,isUserPrompt,project,text") {
    yield said("shape");
  }
  if (file.isNew) {
    yield said("fresh");
  }
  // A relative path starts at the project root.
  if (ctx.project === "/project" && path.resolve("lib") === "/project/lib" && path.dirname(file.path) === "/project/lib") {
    yield said("root");
  }
  // Files are read through node:fs, and only read.
  const pubspec = path.join(path.dirname(file.path), "..", "pubspec.yaml");
  if (fs.existsSync(pubspec) && fs.readFileSync(pubspec, "utf8").includes("name: app") && fs.readdirSync(ctx.project ?? "/").includes("lib") && fs.statSync(pubspec)?.isFile() && cannotWrite()) {
    yield said("reads");
  }
  for (const written of writtenLines(ctx)) {
    if (findWord(written.text, "late") !== -1) {
      yield { line: written.line, evidence: written.text.trim() };
    }
  }
}

function cannotWrite(): boolean {
  try {
    fs.writeFileSync("/project/x", "y");
    return false;
  } catch (error) {
    return (error as { code?: string }).code === "EROFS";
  }
}
