/**
 * Everything a detector may import, next to `node:fs` and `node:path`.
 *
 * A detector runs inside an isolate with no network and no process. It can
 * read files and cannot change any. This module is bundled into it at publish
 * time, so it must stay free of Node imports and of any state.
 */
/**
 * The version of the detector API this SDK is: the event a detector is handed
 * and what it may ask the host for.
 *
 * A principle records the version it was built against, and a host runs each
 * detector against the version it was built for. So the API changes by adding
 * a version here, with the host's step back to the one before. Changing what
 * an existing version means would break principles that are already released.
 *
 * - 1: the event with `file.path` relative. A detector could reach nothing outside it.
 * - 2: `file.path` is absolute. Added `file.relativePath`, `file.isNew` and
 *   `project`, and reading files through `node:fs` and `node:path`.
 *
 * A detector says which one it was written against with `export const api = 2;`.
 * It is then handed the event of that version for as long as it exists, also
 * when it is uploaded again after the API has moved on. The helpers in this
 * file work on the event of every version. Without the export it is built
 * against the newest version at the time of the upload.
 */
export declare const API_VERSION = 2;
/**
 * The event of API 1. A detector that declares `api = 1` is handed this:
 * `detect(ctx: CtxV1)`.
 */
export interface CtxV1 {
    event: EventName;
    file: {
        /** Relative, with forward slashes. */
        path: string;
        name: string;
        ext: string;
        content: string;
        lines: string[];
        written: WrittenLine[];
    } | null;
    text: string;
    isUserPrompt: boolean;
    isCommand: boolean;
    isConversation: boolean;
}
/**
 * What happened in the session.
 *
 * - `write`: the agent wrote or edited a file. `ctx.file.written` holds the lines it wrote.
 * - `read`: the agent read a file. It did not write this code.
 * - `prompt`: the user typed a message.
 * - `command`: the agent is about to run a shell command.
 */
export type EventName = "write" | "read" | "prompt" | "command";
export declare const EVENTS: readonly EventName[];
/** A line the agent wrote in this event. */
export interface WrittenLine {
    /** 1-based line in the file. */
    line: number;
    /** The line as written, untrimmed. */
    text: string;
}
export interface FileContext {
    /** Absolute path, with forward slashes. Navigate from here with `node:path` and read neighbours with `node:fs`. */
    path: string;
    /**
     * Path from the project root, e.g. "lib/src/config_loader.dart". This is what `globs` are matched against.
     * Without a project root it is the path from where the session runs, or just the file's name.
     */
    relativePath: string;
    /** Basename, e.g. "config_loader.dart". */
    name: string;
    /** Extension including the dot, lower case. Empty when there is none. */
    ext: string;
    content: string;
    /** `content` split into lines. */
    lines: string[];
    /** The lines the agent wrote. Empty on `read`. */
    written: WrittenLine[];
    /** The agent created this file with this write. It did not exist before. */
    isNew: boolean;
}
/** Everything a detector can look at. It is plain data, parsed from JSON. */
export interface Ctx {
    event: EventName;
    /** Null when the event carries text instead of a file. */
    file: FileContext | null;
    /** The file content on `write` and `read`, the prompt on `prompt`, the command line on `command`. */
    text: string;
    /** The user typed this. A request for work that has not happened yet. */
    isUserPrompt: boolean;
    /** A shell command the agent is about to run. */
    isCommand: boolean;
    /** The event carries text rather than a file. */
    isConversation: boolean;
    /**
     * The root of the project the event happened in, as an absolute path: the
     * nearest folder upwards with a `.git`. Null when there is none, which is
     * normal, so do not rely on it. To find a `pubspec.yaml` or a
     * `package.json`, walk up from `file.path` instead.
     */
    project: string | null;
}
/**
 * How much of the advice a finding deserves.
 *
 * A word match established a topic and asks for a `pointer`: title and summary.
 * Code that breaks the principle asks for `full`: the whole advice text.
 */
export type Depth = "pointer" | "full";
export interface Finding {
    /** 1-based. Omit when the finding is not about a line. */
    line?: number;
    /**
     * The text that triggered the finding.
     * It must occur verbatim in `ctx.text`; the host drops findings whose evidence does not.
     */
    evidence: string;
    /** Omitted means `full`. */
    depth?: Depth;
}
/** What `detect` returns: a generator or any other iterable of findings. */
export type Findings = Iterable<Finding>;
/** The shape of a detector module. */
export interface Detector {
    detect: (ctx: Ctx) => Findings | null | undefined;
}
/**
 * Index of `word` in `text` where it stands alone, or -1.
 * `findWord("isolate", "late")` is -1; `findWord("late final x", "late")` is 0.
 */
export declare function findWord(text: string, word: string, from?: number): number;
/**
 * Pointer findings for each of `names` that occurs in a conversation event.
 *
 * This is a name check for a named technology, not a keyword cloud.
 * Pass the few phrases that can only mean your topic.
 */
export declare function mentioned(ctx: Pick<Ctx, "isConversation" | "text">, names: readonly string[]): Generator<Finding>;
/** The lines the agent wrote in this event. Empty when no file is involved. */
export declare function writtenLines(ctx: {
    file: {
        written: WrittenLine[];
    } | null;
}): WrittenLine[];
/** 1-based line of a character offset in `text`. */
export declare function lineAt(text: string, offset: number): number;
export interface CodeSyntax {
    /** Starts a comment that runs to the end of the line. */
    lineComment?: string;
    /** Opens and closes a block comment. */
    blockComment?: readonly [string, string];
    /** Characters that open and close a string literal. */
    quotes?: readonly string[];
}
/** Comments and strings as written in C, Dart, Java, JavaScript, Kotlin, Swift and friends. */
export declare const C_LIKE: CodeSyntax;
/** Comments and strings as written in Python, Ruby, shell and YAML. */
export declare const HASH_LIKE: CodeSyntax;
/**
 * `text` with comments and string contents replaced by spaces.
 *
 * Positions and line breaks are preserved, so an offset or line found in the
 * result points at the same place in the original. Use it to keep a keyword
 * inside a comment or a string from counting as code.
 */
export declare function blankCommentsAndStrings(text: string, syntax?: CodeSyntax): string;
/** The project root of every event a test builds. It is made up, and the same in every runner. */
export declare const TEST_ROOT = "/project";
/** Where an event happened. A test leaves it out and gets `TEST_ROOT`. */
export interface Where {
    /** The repository root, or null when the file is in none. */
    root?: string | null;
    /** The file's absolute path, when it is not simply `root/relativePath`. */
    absolute?: string;
    isNew?: boolean;
}
/**
 * The event for a file the agent wrote or read.
 *
 * On `write`, `written` defaults to every line: a new file is written whole.
 * On `read` nothing was written, whatever is passed.
 */
export declare function fileCtx(event: "write" | "read", relativePath: string, content: string, written?: WrittenLine[], where?: Where): Ctx;
/** The event for text: what the user typed, or a command about to run. */
export declare function textCtx(event: "prompt" | "command", text: string, root?: string | null): Ctx;
/**
 * The lines of `content` the agent just wrote, given the text it inserted.
 *
 * The file after the edit is the truth. A fragment is found there as a whole
 * first; when it is not, for instance because a formatter ran, its lines are
 * matched one by one.
 */
export declare function locateWritten(content: string, fragments: readonly string[]): WrittenLine[];
