import { API_VERSION, type Ctx } from "@wellactually/sdk";
import { fsHost, type ProjectFiles } from "./project.ts";

/**
 * Running detectors that were built against an older detector API.
 *
 * A released principle is never built again. Its bundle carries the SDK of
 * the day it was built, so the helpers it imported cannot change under it.
 * What can change under it is this side: the event it is handed and the
 * functions it may call. So every built principle records the API version it
 * was built against, and before a detector runs, the host turns today's event
 * into the event of that version.
 *
 * The API changes by adding a version, never by editing one:
 *
 * 1. Raise `API_VERSION` in the SDK and describe the change there.
 * 2. Freeze the event of the version that was current as a type here.
 * 3. Add the step that turns the new event into that one to `DOWNGRADE`.
 * 4. Say in `environmentFor` which globals and host functions each version has.
 * 5. Add `test/api/v<n>`: the new event's shape, and a bundle built once by
 *    the new toolchain. The tests there fail until all of this is done.
 */

/** The oldest version this host still runs. Raise it to retire one, and delete its step. */
export const MIN_API_VERSION = 1;

/** The version a principle was built against. Principles from before versions were recorded are version 1. */
export function apiOf(manifest: { api?: number }): number {
  return manifest.api ?? 1;
}

/** Why this host cannot run a detector of version `api`, or null when it can. */
export function unsupported(api: number): string | null {
  if (!Number.isInteger(api) || api < 1) {
    return `it names a detector API version this host does not know: ${String(api)}`;
  }
  if (api > API_VERSION) {
    return `it was built for detector API ${api} and this version of Well Actually runs up to ${API_VERSION}. Update the plugin.`;
  }
  if (api < MIN_API_VERSION) {
    return `it was built for detector API ${api}, which is no longer run. Its expert has to release it again.`;
  }
  return null;
}

/**
 * The event of API 1, as it was until Well Actually 0.5.
 * A path was relative and there was nothing else to know about where it is.
 */
export interface CtxV1 {
  event: Ctx["event"];
  file: {
    /** Relative, with forward slashes. */
    path: string;
    name: string;
    ext: string;
    content: string;
    lines: string[];
    written: { line: number; text: string }[];
  } | null;
  text: string;
  isUserPrompt: boolean;
  isCommand: boolean;
  isConversation: boolean;
}

/** API 2 made `file.path` absolute and added `relativePath`, `isNew` and `project`. */
function toV1(ctx: Ctx): CtxV1 {
  return {
    event: ctx.event,
    file: ctx.file && {
      path: ctx.file.relativePath,
      name: ctx.file.name,
      ext: ctx.file.ext,
      content: ctx.file.content,
      lines: ctx.file.lines,
      written: ctx.file.written,
    },
    text: ctx.text,
    isUserPrompt: ctx.isUserPrompt,
    isCommand: ctx.isCommand,
    isConversation: ctx.isConversation,
  };
}

/**
 * One step per version: `DOWNGRADE[n]` turns the event of version `n` into
 * the event of version `n - 1`. A detector of an old version gets today's
 * event walked down, step by step, so a new version only ever adds one step.
 */
const DOWNGRADE: Record<number, (ctx: never) => unknown> = {
  2: toV1,
};

/** Today's event as a detector of version `api` expects it. */
export function ctxFor(api: number, ctx: Ctx): unknown {
  let event: unknown = ctx;
  for (let version = API_VERSION; version > api; version--) {
    const step = DOWNGRADE[version] as ((ctx: unknown) => unknown) | undefined;
    if (!step) {
      throw new Error(`there is no step from detector API ${version} to ${version - 1}`);
    }
    event = step(event);
  }
  return event;
}

/** What the isolate holds besides the detector: its event, other globals, and the functions it may call on the host. */
export interface Environment {
  /** Globals that are strings. `__ctx` is the event as JSON. */
  strings: Record<string, string>;
  functions: Record<string, (argument: string) => string>;
}

/** The isolate a detector of version `api` was built to run in. */
export function environmentFor(api: number, ctx: Ctx, project: ProjectFiles | null): Environment {
  const strings: Record<string, string> = { __ctx: JSON.stringify(ctxFor(api, ctx)) };
  const functions: Environment["functions"] = {};
  if (api >= 2) {
    // API 2 added reading files: `node:fs` asks the host, and `node:path` resolves against the project root.
    strings.__cwd = ctx.project ?? "/";
    functions.__fs = fsHost(ctx.project ?? "/", project);
  }
  return { strings, functions };
}

/**
 * The shape of a value: its keys and the kind of each, without the values.
 * Two events of the same shape are the same to a detector. The tests compare
 * today's event with the shape that was frozen for its version, which is how
 * a change to the event is caught before it reaches a released principle.
 */
export function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [shapeOf(value[0])];
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, shapeOf((value as Record<string, unknown>)[key])]),
    );
  }
  return value === null ? "null" : typeof value;
}
