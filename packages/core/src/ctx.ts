import { fileCtx, textCtx, type Ctx } from "@wellactually/sdk";
import { matchesAnyGlob } from "./glob.ts";
import type { Manifest } from "./manifest.ts";

// The events themselves are built by the SDK, so a test builds exactly what the hook builds.
export { fileCtx, textCtx };

/**
 * Whether a principle's detector runs for this context at all.
 *
 * The host decides this from the manifest before any isolate starts, so an
 * edit to a Dart file never loads a Python principle. The test runner and
 * the probe ask the same question, which is why a test can prove that a
 * principle stays quiet on a file its globs exclude.
 */
export function applies(manifest: Manifest, ctx: Ctx): boolean {
  if (!manifest.events.includes(ctx.event)) {
    return false;
  }
  if (!ctx.file) {
    return true;
  }
  return matchesAnyGlob(ctx.file.relativePath, manifest.globs);
}
