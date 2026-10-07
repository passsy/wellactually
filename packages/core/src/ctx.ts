import type { Ctx, WrittenLine } from "@wellactually/sdk";
import { matchesAnyGlob } from "./glob.ts";
import type { Manifest } from "./manifest.ts";

/**
 * The context for a file event.
 *
 * On `write`, `written` defaults to every line: a new file is written whole.
 * On `read` nothing was written, whatever is passed.
 */
export function fileCtx(event: "write" | "read", relativePath: string, content: string, written?: WrittenLine[]): Ctx {
  const path = relativePath.replaceAll("\\", "/");
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const lines = content.split("\n");
  const allLines = lines.map((text, index) => ({ line: index + 1, text }));
  return {
    event,
    file: {
      path,
      name,
      ext: dot > 0 ? name.slice(dot).toLowerCase() : "",
      content,
      lines,
      written: event === "read" ? [] : (written ?? allLines),
    },
    text: content,
    isUserPrompt: false,
    isCommand: false,
    isConversation: false,
  };
}

/** The context for an event that carries text: what the user typed, or a command about to run. */
export function textCtx(event: "prompt" | "command", text: string): Ctx {
  return {
    event,
    file: null,
    text,
    isUserPrompt: event === "prompt",
    isCommand: event === "command",
    isConversation: true,
  };
}

/**
 * Whether a principle's detector runs for this context at all.
 *
 * The host decides this from the manifest before any isolate starts, so an
 * edit to a Dart file never loads a Python principle. The case runner and
 * the probe ask the same question, which is why a case can prove that a
 * principle stays quiet on a file its globs exclude.
 */
export function applies(manifest: Manifest, ctx: Ctx): boolean {
  if (!manifest.events.includes(ctx.event)) {
    return false;
  }
  if (!ctx.file) {
    return true;
  }
  return matchesAnyGlob(ctx.file.path, manifest.globs);
}
