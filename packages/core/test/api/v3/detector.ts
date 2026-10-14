/**
 * The source of the frozen bundle next to this file. It was built once, by
 * the toolchain of detector API 3, and is never built again: the point of the
 * bundle is that it carries the SDK of that time.
 *
 * It reports one finding for everything about its events that API 3 promised,
 * so a host that stops keeping one of those promises loses that finding.
 */
import fs from "node:fs";
import path from "node:path";
import { findUp, findWord, mentioned, onCommand, onOutput, onPrompt, onRead, onWrite, type Finding } from "@wellactually/sdk/v3";

const keysOf = (value: object): string => Object.keys(value).sort().join(",");

// A prompt knows the folder the session runs in, and a detector looks around from there.
onPrompt({ detect: (event) => (event.text.startsWith("dart") && findUp("pubspec.yaml", event.cwd) === "/project/pubspec.yaml" ? [{ match: "dart" }] : []) });

onPrompt({
  *detect(event) {
    yield* mentioned(event, ["late keyword"]);
    if (keysOf(event) === "cwd,event,lines,project,text") {
      yield { match: "shape" };
    }
  },
});

onCommand({
  *detect(event) {
    if (event.command === event.text && keysOf(event) === "command,cwd,event,lines,project,text") {
      yield { match: "shape" };
    }
  },
});

onOutput({
  *detect(event) {
    if (event.command === "dart analyze" && keysOf(event) === "command,cwd,event,lines,project,text") {
      yield { line: event.lines.length, match: "shape" };
    }
  },
});

// A handler only runs on the files its globs select, and a pattern with ! takes files out again.
onRead({
  globs: ["lib/**/*.dart"],
  *detect(event) {
    if (keysOf(event) === "event,file,lines,project,text" && !event.file.isNew) {
      yield { line: 1, match: "shape" };
    }
  },
});

onWrite({
  globs: ["lib/**/*.dart", "!**/*.g.dart"],
  *detect(event) {
    const { file } = event;
    const said = (word: string): Finding => ({ line: 1, match: word });
    // A path is absolute, and the path from the project root is next to it.
    if (file.path === "/project/lib/session.dart" && file.relativePath === "lib/session.dart" && file.name === "session.dart" && file.ext === ".dart") {
      yield said("absolute");
    }
    if (keysOf(file) === "content,ext,isNew,lines,name,path,relativePath" && keysOf(event) === "event,file,lines,project,text,written" && event.lines === file.lines) {
      yield said("shape");
    }
    if (file.isNew) {
      yield said("fresh");
    }
    // A relative path starts at the project root.
    if (event.project === "/project" && path.resolve("lib") === "/project/lib" && path.dirname(file.path) === "/project/lib") {
      yield said("root");
    }
    // Files are read through node:fs, and only read.
    const pubspec = path.join(path.dirname(file.path), "..", "pubspec.yaml");
    if (fs.existsSync(pubspec) && fs.readFileSync(pubspec, "utf8").includes("name: app") && fs.readdirSync(event.project ?? "/").includes("lib") && fs.statSync(pubspec)?.isFile() && cannotWrite()) {
      yield said("reads");
    }
    for (const written of event.written) {
      if (findWord(written.text, "late") !== -1) {
        yield { line: written.line };
      }
    }
  },
});

// A written line has its number and its text, and can be returned as the finding on its line.
onWrite({ globs: ["test/**/*.dart"], detect: (event) => event.written.filter((written) => written.text.includes("late") && keysOf(written) === "line,text") });

// A second handler for the same event runs too, after the first.
onWrite({
  globs: ["pubspec.yaml"],
  *detect(event) {
    const start = event.lines.findIndex((line) => line.startsWith("dependencies:"));
    if (start !== -1) {
      yield { line: start + 1, endLine: event.lines.length };
    }
  },
});

function cannotWrite(): boolean {
  try {
    fs.writeFileSync("/project/x", "y");
    return false;
  } catch (error) {
    return (error as { code?: string }).code === "EROFS";
  }
}
