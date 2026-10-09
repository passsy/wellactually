import fs from "node:fs";
import path from "node:path";
import { writtenLines, type Ctx, type EventName, type Finding } from "@wellactually/sdk";

export const api = 2;
export const events: EventName[] = ["write"];
export const globs = ["**/*.dart"];

const IMPORT = /^import\s+['"]([^'"]+)['"]/;

/**
 * A cycle exists between two files, so one file cannot show it. The detector
 * follows each import the agent just wrote to the file it names and looks
 * whether that file imports this one back.
 */
export function* detect(ctx: Ctx): Generator<Finding> {
  const file = ctx.file;
  if (!file) {
    return;
  }
  for (const written of writtenLines(ctx)) {
    const target = resolveImport(IMPORT.exec(written.text.trim())?.[1], file.path);
    if (target !== null && importsBack(target, file.path)) {
      yield { line: written.line, evidence: written.text.trim() };
    }
  }
}

function importsBack(target: string, self: string): boolean {
  if (!fs.existsSync(target)) {
    return false;
  }
  return fs
    .readFileSync(target, "utf8")
    .split("\n")
    .some((line) => resolveImport(IMPORT.exec(line.trim())?.[1], target) === self);
}

/** The file an import names, as an absolute path. Null for the SDK and for other packages. */
function resolveImport(spec: string | undefined, from: string): string | null {
  if (spec === undefined || spec.startsWith("dart:")) {
    return null;
  }
  if (!spec.startsWith("package:")) {
    return path.resolve(path.dirname(from), spec);
  }
  const [name, ...rest] = spec.slice("package:".length).split("/");
  const root = packageRoot(from);
  if (root === null || packageName(root) !== name) {
    return null;
  }
  return path.join(root, "lib", ...rest);
}

/** The nearest directory upwards with a pubspec.yaml. */
function packageRoot(from: string): string | null {
  for (let dir = path.dirname(from); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "pubspec.yaml"))) {
      return dir;
    }
    if (dir === path.dirname(dir)) {
      return null;
    }
  }
}

function packageName(root: string): string | null {
  return /^name:\s*(\S+)/m.exec(fs.readFileSync(path.join(root, "pubspec.yaml"), "utf8"))?.[1] ?? null;
}
