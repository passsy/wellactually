import { API_VERSION, blankCommentsAndStrings, type Ctx } from "@wellactually/sdk";
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
 * 2. Freeze the event of the version that was current as a type in the SDK,
 *    point that version's file (`v<n-1>.ts`) at it, and add `v<n>.ts` for the
 *    new one. A detector says its version by importing from one of them.
 * 3. Add the step that turns the new event into that one to `DOWNGRADE`.
 * 4. Say in `environmentFor` which globals and host functions each version has.
 * 5. Add `test/api/v<n>`: the new event's shape, and a bundle built once by
 *    the new toolchain. The tests there fail until all of this is done.
 */

/** The oldest version this host still runs. Raise it to retire one, and delete its step. */
export const MIN_API_VERSION = 3;

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
 * One step per version: `DOWNGRADE[n]` turns the event of version `n` into
 * the event of version `n - 1`. A detector of an old version gets today's
 * event walked down, step by step, so a new version only ever adds one step.
 */
const DOWNGRADE: Record<number, (ctx: never) => unknown> = {};

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
  return {
    // `node:path` resolves against the project root, and `node:fs` asks the host.
    strings: { __ctx: JSON.stringify(ctxFor(api, ctx)), __cwd: ctx.project ?? "/" },
    functions: { __fs: fsHost(ctx.project ?? "/", project) },
  };
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

const SDK = "@wellactually/sdk";
const current = `"${SDK}/v${API_VERSION}"`;

/**
 * What a source file imports from the SDK, as written: `@wellactually/sdk/v3`, `@wellactually/sdk/v3/test`.
 *
 * It is read from the source, not from the build, because an import of types
 * only is gone by the time esbuild has compiled the file, and types are all
 * that many detectors import.
 */
export function sdkImports(source: string): string[] {
  // Comments and string contents are blanked with positions kept, so an import that is commented out is not found.
  const code = blankCommentsAndStrings(source);
  const found = new Set<string>();
  for (const match of code.matchAll(/\b(?:from|import)\s*\(?\s*(["'])/g)) {
    const open = match.index + match[0].length;
    const close = source.indexOf(match[1] ?? '"', open);
    const specifier = close === -1 ? "" : source.slice(open, close);
    if (specifier === SDK || specifier.startsWith(`${SDK}/`)) {
      found.add(specifier);
    }
  }
  return [...found];
}

/**
 * The detector API version a principle is written against: the one its files import the SDK from.
 *
 * `sources` are the principle's code files by name. Throws with a message for
 * the author when they name no version, two, or one this host does not build for.
 */
export function importedApi(sources: Record<string, string>): number {
  const seen = new Map<number, string>();
  for (const name of Object.keys(sources).sort()) {
    for (const specifier of sdkImports(sources[name] ?? "")) {
      const where = `${name} imports "${specifier}"`;
      const version = /^@wellactually\/sdk\/v(\d+)(?:\/test)?$/.exec(specifier)?.[1];
      if (version === undefined) {
        const wanted = specifier.endsWith("/test") ? `"${SDK}/v${API_VERSION}/test"` : current;
        throw new Error(`${where}. The detector API version is part of the path: import from ${wanted}.`);
      }
      const api = Number(version);
      if (api < MIN_API_VERSION || api > API_VERSION) {
        const built = MIN_API_VERSION === API_VERSION ? `detector API ${API_VERSION}` : `the detector API versions ${MIN_API_VERSION} to ${API_VERSION}`;
        throw new Error(`${where}. This version of Well Actually builds for ${built}: import from ${specifier.endsWith("/test") ? `"${SDK}/v${API_VERSION}/test"` : current}.`);
      }
      if (!seen.has(api)) {
        seen.set(api, where);
      }
    }
  }
  if (seen.size === 0) {
    throw new Error(`no file says which detector API the principle is written against. Import from the version in detector.ts, for example: import { onWrite } from ${current};`);
  }
  if (seen.size > 1) {
    throw new Error(`the principle is written against ${seen.size} versions of the detector API: ${[...seen.values()].join(", ")}. Import from one version everywhere.`);
  }
  return [...seen.keys()][0] as number;
}

/** What a detector can import that only exists from some version on, with that version. */
export const BUILT_IN_SINCE: Record<string, number> = {};
