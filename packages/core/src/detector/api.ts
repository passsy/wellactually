import { API_VERSION, blankCommentsAndStrings, type Ctx } from "@wellactually/detector-sdk";
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
 * 5. Add `test/api/v<n>`: a detector that reports one finding for each thing
 *    the version promises, and the new event's shape from
 *    `scripts/freeze-api.mjs`. The tests build the detector from source on
 *    every run and fail until all of this is done.
 */

/** The oldest version this host still runs. Raise it to retire one, and delete its step. */
export const MIN_API_VERSION: number = 3;

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
const DOWNGRADE: Record<number, (ctx: never) => unknown> = {
  // Version 4 added the lines a write removed and the `delete` event. A detector of version 3 has no handler for a deletion, so it is never asked about one.
  4: (ctx: Ctx) => {
    if (ctx.file === null) {
      return ctx;
    }
    const { removed: _, ...file } = ctx.file;
    return { ...ctx, file };
  },
  // Version 5 added the `tool` event. A detector of version 4 has no handler for one, so it is never asked about one.
  5: (ctx: Ctx) => {
    const { tool: _, ...rest } = ctx;
    return rest;
  },
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
  /** Globals that are strings. `__ctx` is the event, packed by `packCtx`. */
  strings: Record<string, string>;
  functions: Record<string, (argument: string) => string>;
}

/**
 * The event of a write carries the file four times: as `text`, as `content`,
 * split into `lines`, and once more in `written`. Parsing all of that as JSON
 * in every isolate cost more than most detectors, so the text crosses once
 * and `UNPACK_CTX` builds the same event from it in the isolate.
 *
 * `__ctx` is JSON of `[event, length of the content, where the text is]`,
 * then U+0001, which JSON output never holds unescaped, then the content and
 * the text as they are. In the JSON, what the isolate puts back is null: the
 * content, the lines when they are the content split, and the text. A list of
 * written or removed lines that are all the file's lines is just their
 * numbers; in any other list, such a line has a null text. Everything else
 * stays in the JSON, so the event a detector sees is the one it always saw.
 *
 * A string reaches the isolate only up to its first NUL, so an event with a
 * NUL in its text crosses as JSON, as before.
 */
function packCtx(event: Record<string, unknown>): string {
  const file = event.file as { content: string; lines: string[]; written?: Line[]; removed?: Line[] } | null | undefined;
  if (file?.content.includes("\0") || (typeof event.text === "string" && event.text.includes("\0"))) {
    return `${JSON.stringify([event, -1, TEXT_IN_JSON])}\u0001`;
  }
  const packed: Record<string, unknown> = { ...event };
  let content = "";
  let length = -1;
  if (file) {
    const lines = file.content.split("\n");
    const derived = lines.length === file.lines.length && lines.every((line, index) => line === file.lines[index]);
    // A list whose every line is the file's line crosses as its line numbers. Otherwise each such line has a null text.
    const fromLines = (list: Line[] | undefined): (Line | number)[] | undefined => {
      if (list === undefined) return undefined;
      const same = list.map((entry) => file.lines[entry.line - 1] === entry.text && Object.keys(entry).join() === "line,text");
      return same.every(Boolean) ? list.map((entry) => entry.line) : list.map((entry, index) => (same[index] ? { ...entry, text: null } : entry));
    };
    packed.file = { ...file, content: null, lines: derived ? null : file.lines, ...("written" in file ? { written: fromLines(file.written) } : {}), ...("removed" in file ? { removed: fromLines(file.removed) } : {}) };
    content = file.content;
    length = content.length;
  }
  let text = "";
  let where = TEXT_IN_JSON;
  if (typeof event.text === "string") {
    packed.text = null;
    where = file && event.text === file.content ? TEXT_IS_CONTENT : TEXT_FOLLOWS;
    text = where === TEXT_FOLLOWS ? event.text : "";
  }
  return `${JSON.stringify([packed, length, where])}\u0001${content}${text}`;
}

const TEXT_IN_JSON = 0;
const TEXT_IS_CONTENT = 1;
const TEXT_FOLLOWS = 2;

interface Line {
  line: number;
  text: string | null;
}

/** The event `packCtx` packed, as the detector expects it. Keys are assigned where the JSON holds them as null, so they keep their order. */
export const UNPACK_CTX = `(() => {
  const cut = __ctx.indexOf("\\u0001");
  const [ctx, length, where] = JSON.parse(__ctx.slice(0, cut));
  const file = ctx.file;
  if (file && file.content === null) {
    file.content = __ctx.slice(cut + 1, cut + 1 + length);
    if (file.lines === null) file.lines = file.content.split("\\n");
    for (const list of [file.written, file.removed]) {
      if (list) for (let i = 0; i < list.length; i++) {
        const entry = list[i];
        if (typeof entry === "number") list[i] = { line: entry, text: file.lines[entry - 1] };
        else if (entry.text === null) entry.text = file.lines[entry.line - 1];
      }
    }
  }
  if (where === ${TEXT_IS_CONTENT}) ctx.text = file.content;
  if (where === ${TEXT_FOLLOWS}) ctx.text = __ctx.slice(cut + 1 + Math.max(length, 0));
  return ctx;
})()`;

/** The packed event per version, for each event: every detector on one event gets the same. */
const packedCtx = new WeakMap<Ctx, Map<number, string>>();

function packedFor(api: number, ctx: Ctx): string {
  let byApi = packedCtx.get(ctx);
  if (byApi === undefined) {
    byApi = new Map();
    packedCtx.set(ctx, byApi);
  }
  let packed = byApi.get(api);
  if (packed === undefined) {
    packed = packCtx(ctxFor(api, ctx) as Record<string, unknown>);
    byApi.set(api, packed);
  }
  return packed;
}

/** The isolate a detector of version `api` was built to run in. */
export function environmentFor(api: number, ctx: Ctx, project: ProjectFiles | null): Environment {
  return {
    // `node:path` resolves against the project root, and `node:fs` asks the host.
    strings: { __ctx: packedFor(api, ctx), __cwd: ctx.project ?? "/" },
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

const SDK = "@wellactually/detector-sdk";
const current = `"${SDK}/v${API_VERSION}"`;

/**
 * What a source file imports from the SDK, as written: `@wellactually/detector-sdk/v3`, `@wellactually/detector-sdk/v3/test`.
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
    if ([SDK, "@wellactually/sdk"].some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
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
      const version = /^@wellactually\/(?:detector-sdk|sdk)\/v(\d+)(?:\/test)?$/.exec(specifier)?.[1];
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
