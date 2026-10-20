import type { CommandEvent, Ctx, DeleteEvent, EventName, Finding, Findings, OutputEvent, PromptEvent, ReadEvent, RemovedLine, TextFinding, WriteEvent, WrittenLine } from "./index.js";
/**
 * `F`, with every field that `Allowed` does not have turned into an error.
 *
 * A handler written inline has its return type inferred, and TypeScript lets
 * an inferred object carry extra fields. This is what makes `yield { line: 1 }`
 * in a prompt handler, or a misspelled field anywhere, fail to compile.
 */
type Only<F, Allowed> = F extends unknown ? F & {
    [K in Exclude<keyof F, keyof Allowed>]: never;
} : never;
/**
 * A handler of an event with lines: it yields findings that may name a line.
 * It may also return written or removed lines as they are, each of which is a
 * finding on its line.
 *
 * The first half of the union is what lets one handler yield a finding for
 * the file, `{}`, next to findings with a line.
 */
type FileHandler<E, F> = (event: E) => Findings<Only<F, Finding>> | Findings<Only<F, Finding> | WrittenLine | RemovedLine>;
/** A handler of a prompt or a command: its findings have no line to name. */
type TextHandler<E, F> = (event: E) => Findings<Only<F, TextFinding>>;
/** What `onWrite`, `onRead` and `onDelete` take: which files, and what to look for in them. */
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
/** Runs when the agent wrote or edited a file. `event.written` holds the lines it wrote, `event.removed` the lines it removed. */
export declare function onWrite<F extends Finding>(options: FileOptions<WriteEvent, F>): void;
/** Runs when the agent read a file. It did not write this code, so judge the place, not the author. */
export declare function onRead<F extends Finding>(options: FileOptions<ReadEvent, F>): void;
/** Runs when the agent deleted a file. `event.file` is the file as it was, and every line of it is in `event.removed`. */
export declare function onDelete<F extends Finding>(options: FileOptions<DeleteEvent, F>): void;
/** Runs when the user typed a message, and when the agent briefed a subagent. */
export declare function onPrompt<F extends TextFinding>(options: TextOptions<PromptEvent, F>): void;
/** Runs before the agent runs a shell command. */
export declare function onCommand<F extends TextFinding>(options: TextOptions<CommandEvent, F>): void;
/** Runs after a shell command, on what it printed. */
export declare function onOutput<F extends Finding>(options: OutputOptions<F>): void;
/** What the build reads: the handlers the detector file registered while it loaded. */
export declare function __handlers(): Registered[];
/**
 * What the host calls inside the isolate: runs every handler that wants this
 * event and collects what they yield, up to `limit` findings and one more, so
 * the host can tell that there were too many.
 */
export declare function __dispatch(ctx: Ctx, limit: number): unknown[];
export {};
