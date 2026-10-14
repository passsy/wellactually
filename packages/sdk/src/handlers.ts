/**
 * How a detector says what it reacts to.
 *
 *     onWrite({
 *       globs: ["**\/*.dart", "!**\/*.g.dart"],
 *       *detect(event) {
 *         for (const written of event.written) {
 *           if (/\blate\b/.test(written.text)) {
 *             yield { line: written.line };
 *           }
 *         }
 *       },
 *     });
 *
 *     onPrompt({
 *       *detect(event) {
 *         yield* mentioned(event, ["late keyword", "late final"]);
 *       },
 *     });
 *
 * Each call takes one object. Its `detect` is a generator method, the star
 * in front of the name. It yields a finding for each thing it found, and
 * passes on what a helper returns with `yield*`.
 *
 * A detector file calls these at its top level. The build loads the file once
 * to learn which handlers it has and which files they want, so a host knows
 * without starting an isolate that an edit to a Python file is none of a Dart
 * principle's business. For that reason a call inside a function, an `if` or
 * another handler does not count.
 *
 * This file holds the one piece of state a detector has: its handlers. Each
 * detector is bundled with its own copy and runs in a fresh isolate.
 */
import { matchesGlobs } from "./glob.ts";
import type { CommandEvent, Ctx, EventName, Finding, Findings, OutputEvent, PromptEvent, ReadEvent, TextFinding, WriteEvent, WrittenLine } from "./index.ts";

/**
 * `F`, with every field that `Allowed` does not have turned into an error.
 *
 * A handler written inline has its return type inferred, and TypeScript lets
 * an inferred object carry extra fields. This is what makes `yield { line: 1 }`
 * in a prompt handler, or a misspelled field anywhere, fail to compile.
 */
type Only<F, Allowed> = F extends unknown ? F & { [K in Exclude<keyof F, keyof Allowed>]: never } : never;

/**
 * A handler of an event with lines: it yields findings that may name a line.
 * It may also return written lines as they are, each of which is a finding on its line.
 *
 * The first half of the union is what lets one handler yield a finding for
 * the file, `{}`, next to findings with a line.
 */
type FileHandler<E, F> = (event: E) => Findings<Only<F, Finding>> | Findings<Only<F, Finding> | WrittenLine>;
/** A handler of a prompt or a command: its findings have no line to name. */
type TextHandler<E, F> = (event: E) => Findings<Only<F, TextFinding>>;

/** What `onWrite` and `onRead` take: which files, and what to look for in them. */
export interface FileOptions<E, F> {
  /**
   * Patterns for the path from the project root: `**`, `*`, `?` and `{a,b}`.
   * A pattern starting with `!` takes files out again. Without a pattern that
   * selects, `detect` runs on every file.
   */
  globs?: readonly string[];
  /** Yields a finding for each thing it found in the event. */
  detect: FileHandler<E, F>;
}

/** What `onPrompt` and `onCommand` take. */
export interface TextOptions<E, F> {
  /** Yields a finding for each thing it found in the event. */
  detect: TextHandler<E, F>;
}

/** What `onOutput` takes. */
export interface OutputOptions<F> {
  /** Yields a finding for each thing it found in what the command printed. */
  detect: FileHandler<OutputEvent, F>;
}

/** A handler as the build sees it: its event and the files it wants. */
export interface Registered {
  event: EventName;
  /** Empty on the events that carry no file. */
  globs: string[];
}

interface Registration extends Registered {
  handler: (event: never) => Findings<Finding>;
}

const registered: Registration[] = [];
/** True once the file has been loaded. A handler registered after that was never seen by the build. */
let sealed = false;

function register(event: EventName, options: unknown): void {
  const name = `on${event[0]?.toUpperCase() ?? ""}${event.slice(1)}`;
  if (sealed) {
    throw new Error(`${name}() was called while a handler ran. Register handlers at the top level of detector.ts.`);
  }
  const { globs, detect } = (typeof options === "object" && options !== null ? options : {}) as { globs?: unknown; detect?: unknown };
  if (typeof detect !== "function") {
    throw new Error(`${name}() takes an object with a detect function: ${name}({ *detect(event) { ... } })`);
  }
  // What is not a list of patterns is kept as it is, for the build to refuse with a message for the author.
  registered.push({ event, globs: (Array.isArray(globs) ? [...globs] : (globs ?? [])) as string[], handler: detect as Registration["handler"] });
}

/** Runs when the agent wrote or edited a file. `event.written` holds the lines it wrote. */
export function onWrite<F extends Finding>(options: FileOptions<WriteEvent, F>): void {
  register("write", options);
}

/** Runs when the agent read a file. It did not write this code, so judge the place, not the author. */
export function onRead<F extends Finding>(options: FileOptions<ReadEvent, F>): void {
  register("read", options);
}

/** Runs when the user typed a message, and when the agent briefed a subagent. */
export function onPrompt<F extends TextFinding>(options: TextOptions<PromptEvent, F>): void {
  register("prompt", options);
}

/** Runs before the agent runs a shell command. */
export function onCommand<F extends TextFinding>(options: TextOptions<CommandEvent, F>): void {
  register("command", options);
}

/** Runs after a shell command, on what it printed. */
export function onOutput<F extends Finding>(options: OutputOptions<F>): void {
  register("output", options);
}

/** What the build reads: the handlers the detector file registered while it loaded. */
export function __handlers(): Registered[] {
  return registered.map(({ handler: _, ...rest }) => rest);
}

/** The event as the handlers of its kind get it. */
function eventOf(ctx: Ctx): unknown {
  const base = { event: ctx.event, text: ctx.text, lines: ctx.file?.lines ?? ctx.text.split("\n"), project: ctx.project };
  if (!ctx.file) {
    const text = { ...base, cwd: ctx.cwd ?? ctx.project ?? "/" };
    return ctx.command === null ? text : { ...text, command: ctx.command };
  }
  const { written, ...file } = ctx.file;
  if (ctx.event !== "write") {
    return { ...base, file };
  }
  return { ...base, file, written };
}

/**
 * What the host calls inside the isolate: runs every handler that wants this
 * event and collects what they yield, up to `limit` findings and one more, so
 * the host can tell that there were too many.
 */
export function __dispatch(ctx: Ctx, limit: number): unknown[] {
  sealed = true;
  const out: unknown[] = [];
  let event: unknown;
  for (const { event: kind, globs, handler } of registered) {
    if (kind !== ctx.event || (ctx.file && !matchesGlobs(ctx.file.relativePath, globs))) {
      continue;
    }
    const found = (handler as (event: unknown) => unknown)((event ??= eventOf(ctx)));
    if (found === null || found === undefined) {
      continue;
    }
    if (typeof (found as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== "function" || typeof found === "string") {
      throw new Error(`a handler has to return findings: a generator, a list, or nothing. This one returned ${typeof found === "object" ? "an object" : String(found)}.`);
    }
    for (const finding of found as Iterable<unknown>) {
      out.push(asFinding(finding));
      if (out.length > limit) {
        return out;
      }
    }
  }
  return out;
}

/**
 * What a handler yielded, reduced to what a finding is. A written line that
 * was returned as it is becomes a finding on its line: its text stays here.
 */
function asFinding(found: unknown): unknown {
  if (typeof found !== "object" || found === null || Array.isArray(found)) {
    return found;
  }
  const { line, endLine, match, file, depth } = found as Record<string, unknown>;
  return { line, endLine, match, file, depth };
}
