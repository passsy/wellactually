/**
 * Everything a detector may import, next to `node:fs` and `node:path`.
 *
 * A detector runs inside an isolate with no network and no process. It can
 * read files and cannot change any. This module is bundled into it at publish
 * time, so it must stay free of Node imports and of any state. The one piece
 * of state a detector has, the handlers it registered, lives in `handlers.ts`.
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
 * - 1: one `detect(ctx)` with `file.path` relative. No longer run.
 * - 2: `file.path` absolute, `file.relativePath`, `file.isNew`, `project`, and
 *   reading files through `node:fs` and `node:path`. No longer run.
 * - 3: handlers in place of `detect`: `onWrite`, `onRead`, `onPrompt`,
 *   `onCommand` and `onOutput`, each with its own typed event, and globs on
 *   the file handlers. A finding names a line or a match and carries no text
 *   of its own. Added the `output` event, and a prompt is also what the agent
 *   hands to a subagent.
 * - 4: `event.removed` on a write, the lines the agent removed, and the
 *   `delete` event with `onDelete`, for a file the agent deleted. A finding
 *   with `removed: true` names a removed line.
 *
 * A detector says which one it was written against by where it imports from:
 * `@wellactually/sdk/v4`. Each version has its own file next to this one. A
 * principle is then handed the event of that version for as long as it is
 * run, also when it is uploaded again after the API has moved on. This file
 * itself is what the host imports, not a detector.
 */
export const API_VERSION = 4;

export { matchesGlob, matchesGlobs } from "./glob.ts";

/**
 * What happened in the session.
 *
 * - `write`: the agent wrote or edited a file.
 * - `read`: the agent read a file. It did not write this code.
 * - `delete`: the agent deleted a file.
 * - `prompt`: the user typed a message, or the agent briefed a subagent.
 * - `command`: the agent is about to run a shell command.
 * - `output`: a shell command ran, and this is what it printed.
 */
export type EventName = "write" | "read" | "delete" | "prompt" | "command" | "output";

export const EVENTS: readonly EventName[] = ["write", "read", "delete", "prompt", "command", "output"];

/** The events that carry a file, and so the ones a handler can have globs for. */
export const FILE_EVENTS: readonly EventName[] = ["write", "read", "delete"];

/** A line the agent wrote or removed in this event, as the host records it. */
export interface Written {
  /** 1-based line in the file: after the change for a written line, before it for a removed one. */
  line: number;
  /** The line as written or as it was, untrimmed. */
  text: string;
}

/** A line the agent wrote in this event, as a handler of `onWrite` gets it. */
export type WrittenLine = Written;

/** A line the agent removed in this event, as a handler of `onWrite` or `onDelete` gets it. */
export interface RemovedLine {
  /** 1-based line it had in the file before the change. The file now may hold other text there, or end before it. */
  line: number;
  /** The line as it was, untrimmed. */
  text: string;
  /**
   * Always true. A removed line that a handler yields as it is is a finding
   * on the line that was removed, and this is what says so.
   */
  removed: true;
}

/** The file of a `write` or `read` event. */
export interface File {
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
  /** The agent created this file with this write. It did not exist before. Always false on `read` and `delete`. */
  isNew: boolean;
}

/**
 * An event as the host builds it and hands it to the isolate: one shape for
 * all six. A detector never sees this. Its handlers get the event of their
 * kind, see `WriteEvent` and the others.
 */
export interface Ctx {
  event: EventName;
  /**
   * Null when the event carries text instead of a file. On `delete` the file
   * is as it was before it was deleted, and every line of it is removed.
   */
  file: (File & { written: Written[]; removed: Written[] }) | null;
  /** The file content on `write`, `read` and `delete`, the prompt on `prompt`, the command line on `command`, what was printed on `output`. */
  text: string;
  /** The command line on `command` and `output`. Null on the others. */
  command: string | null;
  /** The folder the session runs in, as an absolute path, on the events without a file. Null on `write`, `read` and `delete`. */
  cwd: string | null;
  /**
   * The root of the project the event happened in, as an absolute path: the
   * nearest folder upwards with a `.git`. Null when there is none.
   */
  project: string | null;
}

/** What every event has. */
interface EventBase {
  /** The file content on `write`, `read` and `delete`, the prompt on `prompt`, the command line on `command`, what was printed on `output`. */
  text: string;
  /** `text` split into lines. A finding's `line` counts in here. */
  lines: string[];
  /**
   * The root of the project the event happened in, as an absolute path: the
   * nearest folder upwards with a `.git`. Null when there is none, which is
   * normal, so do not rely on it. To find a `pubspec.yaml` or a
   * `package.json`, walk up from `file.path` instead.
   */
  project: string | null;
}

/** The agent wrote or edited a file. */
export interface WriteEvent extends EventBase {
  event: "write";
  file: File;
  /** The lines the agent wrote. Code that was there before is not in here. */
  written: WrittenLine[];
  /**
   * The lines the agent removed, with the line each had before. A line it
   * changed is removed as it was and written as it is now. Empty when the
   * host cannot tell what the file was before, as for a new file.
   */
  removed: RemovedLine[];
}

/** The agent read a file. It wrote none of it. */
export interface ReadEvent extends EventBase {
  event: "read";
  file: File;
}

/** The agent deleted a file. `file` is as it was, and every line of it is in `removed`. */
export interface DeleteEvent extends EventBase {
  event: "delete";
  file: File;
  /** Every line of the file, the same as `file.lines`. A handler that judges removed lines serves `onWrite` and `onDelete` alike. */
  removed: RemovedLine[];
}

/** What an event without a file has in its place: where the session is. */
interface TextEventBase extends EventBase {
  /**
   * The folder the session runs in, as an absolute path. Start here to look
   * at the project with `node:fs`, e.g. `findUp("pubspec.yaml", event.cwd)`.
   */
  cwd: string;
}

/** The user typed a message, or the agent briefed a subagent. A request for work that has not happened yet. */
export interface PromptEvent extends TextEventBase {
  event: "prompt";
}

/** The agent is about to run a shell command. */
export interface CommandEvent extends TextEventBase {
  event: "command";
  /** The command line. The same as `text`. */
  command: string;
}

/** A shell command ran. `text` is what it printed. */
export interface OutputEvent extends TextEventBase {
  event: "output";
  /** The command line that printed it. */
  command: string;
}

/** An event that carries a file, for a helper that serves `onWrite`, `onRead` and `onDelete` alike. */
export type FileEvent = WriteEvent | ReadEvent | DeleteEvent;

/**
 * How much of the advice a finding deserves.
 *
 * A word match established a topic and asks for a `pointer`: title and summary.
 * Code that breaks the principle asks for `full`: the whole advice text.
 */
export type Depth = "pointer" | "full";

/**
 * What a handler of `onPrompt` or `onCommand` yields. Nothing in it is
 * required: `yield {}` fires the principle and says nothing more.
 */
export interface TextFinding {
  /**
   * The exact text that triggered: the keyword in a prompt, a piece of a line.
   * It has to occur word for word in the event, within the lines the finding
   * names when it names some, and may not span lines. The agent is shown it.
   * A match that does not occur is left out, and the finding still fires.
   */
  match?: string;
  /**
   * Another file the finding points at: the jpg that should be a webp, the
   * test that already exists. A path from the project root, or an absolute
   * one. The agent is told the file. `line` and `match` stay about the event.
   * It has to be a file or folder that exists, or occur word for word in the
   * event. Any other path is left out, and the finding still fires.
   */
  file?: string;
  /** Omitted means `full`. */
  depth?: Depth;
}

/**
 * What a handler of `onWrite`, `onRead`, `onDelete` or `onOutput` yields.
 * Nothing in it is required.
 *
 * A finding with a `line` points at that line, and the host quotes it to the
 * agent. A finding carries no text of its own.
 *
 * A finding without a `line` points at the file: `yield {}` in `onWrite` or
 * `onRead` says the file itself is the problem, for its name, its place or
 * something it lacks. Do not pick a first line to stand in for it. In
 * `onOutput` it fires the principle and says nothing more.
 *
 * A finding with a `file` points at another file than the one of the event:
 * `yield { line: written.line, file: "assets/hero.jpg" }`.
 *
 * A finding with `removed: true` names a line the agent removed, by the line
 * it had before: `yield { line: removed.line, removed: true }`, or the removed
 * line itself, `yield removed`.
 */
export interface Finding extends TextFinding {
  /** 1-based line of the event's text: of the file, or of what a command printed. */
  line?: number;
  /** The last line, when the finding spans several. Needs `line`. */
  endLine?: number;
  /**
   * `line` and `endLine` name lines the agent removed, by the line each had
   * before, and `match` occurs in them. Every line from `line` to `endLine`
   * has to be in `event.removed`. Needs `line`.
   */
  removed?: boolean;
}

/** What a handler returns: a generator or any other iterable of findings, or nothing. */
export type Findings<F = Finding> = Iterable<F> | null | undefined | void;

const WORD_CHAR = /[A-Za-z0-9_$]/;

/**
 * Index of `word` in `text` where it stands alone, or -1.
 * `findWord("isolate", "late")` is -1; `findWord("late final x", "late")` is 0.
 */
export function findWord(text: string, word: string, from = 0): number {
  let at = text.indexOf(word, from);
  while (at !== -1) {
    const before = at === 0 ? "" : (text[at - 1] ?? "");
    const after = text[at + word.length] ?? "";
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) {
      return at;
    }
    at = text.indexOf(word, at + 1);
  }
  return -1;
}

/**
 * A pointer finding for the first of `names` that the event's text mentions.
 *
 * A name counts where it stands alone, in any case, and with or without the
 * separators people put inside names: `rxdart` also finds rx_dart, rx-dart
 * and RxDart. A space in a name stands for any whitespace.
 *
 * This is a name check for a named technology, not a keyword cloud.
 * Pass the few phrases that can only mean your topic.
 *
 *     onPrompt({
 *       *detect(event) {
 *         yield* mentioned(event, ["late keyword", "late final"]);
 *       },
 *     });
 */
export function mentioned(event: { text: string }, names: readonly string[]): TextFinding[] {
  for (const name of names) {
    const letters = [...name.toLowerCase().replaceAll(/[_\-.]/g, "")];
    if (letters.length === 0) {
      continue;
    }
    const body = letters.map((letter) => (letter === " " ? "\\s+" : letter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("[_\\-.]?");
    // Any letter ends a word, not just ASCII: "Prüfe" must not read as "pr" and "fe".
    const match = new RegExp(`(?<![\\p{L}\\p{N}_$.\\-])${body}(?![\\p{L}\\p{N}_$\\-])`, "iu").exec(event.text);
    if (match) {
      // A match may not span lines, and a name with a space in it can. Then the finding goes without one.
      return [match[0].includes("\n") ? { depth: "pointer" } : { match: match[0], depth: "pointer" }];
    }
  }
  return [];
}

/** 1-based line of a character offset in `text`. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
    }
  }
  return line;
}

export interface CodeSyntax {
  /** Starts a comment that runs to the end of the line. */
  lineComment?: string;
  /** Opens and closes a block comment. */
  blockComment?: readonly [string, string];
  /** Characters that open and close a string literal. */
  quotes?: readonly string[];
}

/** Comments and strings as written in C, Dart, Java, JavaScript, Kotlin, Swift and friends. */
export const C_LIKE: CodeSyntax = {
  lineComment: "//",
  blockComment: ["/*", "*/"],
  quotes: ['"', "'", "`"],
};

/** Comments and strings as written in Python, Ruby, shell and YAML. */
export const HASH_LIKE: CodeSyntax = {
  lineComment: "#",
  quotes: ['"', "'"],
};

/**
 * `text` with comments and string contents replaced by spaces.
 *
 * Positions and line breaks are preserved, so an offset or line found in the
 * result points at the same place in the original. Use it to keep a keyword
 * inside a comment or a string from counting as code.
 */
export function blankCommentsAndStrings(text: string, syntax: CodeSyntax = C_LIKE): string {
  const out: string[] = [];
  const quotes = syntax.quotes ?? [];
  let i = 0;
  while (i < text.length) {
    const char = text[i] ?? "";
    if (syntax.lineComment && text.startsWith(syntax.lineComment, i)) {
      while (i < text.length && text[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (syntax.blockComment && text.startsWith(syntax.blockComment[0], i)) {
      const close = text.indexOf(syntax.blockComment[1], i + syntax.blockComment[0].length);
      const end = close === -1 ? text.length : close + syntax.blockComment[1].length;
      for (; i < end; i++) {
        out.push(text[i] === "\n" ? "\n" : " ");
      }
      continue;
    }
    if (quotes.includes(char)) {
      out.push(char);
      i++;
      while (i < text.length && text[i] !== char) {
        if (text[i] === "\\" && i + 1 < text.length) {
          out.push(" ");
          i++;
        }
        out.push(text[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < text.length) {
        out.push(char);
        i++;
      }
      continue;
    }
    out.push(char);
    i++;
  }
  return out.join("");
}

/** The project root of every event a test builds. It is made up, and the same in every runner. */
export const TEST_ROOT = "/project";

/** The lines a write changed. */
export interface Change {
  /** Defaults to every line of the file. */
  written?: Written[];
  /** Defaults to none. */
  removed?: Written[];
}

function removedOf(event: "write" | "read" | "delete", change: Change, allLines: Written[]): Written[] {
  if (event === "delete") {
    return allLines;
  }
  if (event === "read") {
    return [];
  }
  return change.removed ?? [];
}

/** Where an event happened. A test leaves it out and gets `TEST_ROOT`. */
export interface Where {
  /** The repository root, or null when the file is in none. */
  root?: string | null;
  /** The file's absolute path, when it is not simply `root/relativePath`. */
  absolute?: string;
  isNew?: boolean;
}

/**
 * The event for a file the agent wrote, read or deleted.
 *
 * On `write`, `written` defaults to every line: a new file is written whole.
 * On `read` nothing was written or removed, whatever is passed. On `delete`
 * `content` is the file as it was, and every line of it is removed.
 */
export function fileCtx(event: "write" | "read" | "delete", relativePath: string, content: string, change: Change = {}, where: Where = {}): Ctx {
  const relative = relativePath.replaceAll("\\", "/").replace(/^\.?\/+/, "");
  const root = where.root === undefined ? TEST_ROOT : where.root;
  const path = (where.absolute ?? `${root ?? ""}/${relative}`).replaceAll("\\", "/");
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const lines = content.split("\n");
  const allLines = lines.map((text, index) => ({ line: index + 1, text }));
  return {
    event,
    file: {
      path,
      relativePath: relative,
      name,
      ext: dot > 0 ? name.slice(dot).toLowerCase() : "",
      content,
      lines,
      written: event === "write" ? (change.written ?? allLines) : [],
      removed: removedOf(event, change, allLines),
      isNew: event === "write" && where.isNew === true,
    },
    text: content,
    command: null,
    cwd: null,
    project: root,
  };
}

/**
 * The event for text: a prompt, a command about to run, or what a command printed.
 * `command` is the command line an `output` belongs to, and `cwd` the folder
 * the session runs in, which is the project root unless said otherwise.
 */
export function textCtx(event: "prompt" | "command" | "output", text: string, root: string | null = TEST_ROOT, command = "", cwd: string = root ?? "/"): Ctx {
  return {
    event,
    file: null,
    text,
    command: event === "prompt" ? null : event === "command" ? text : command,
    cwd,
    project: root,
  };
}

/**
 * The lines of `content` the agent just wrote, given the text it inserted.
 *
 * The file after the edit is the truth. A fragment is found there as a whole
 * first; when it is not, for instance because a formatter ran, its lines are
 * matched one by one.
 */
export function locateWritten(content: string, fragments: readonly string[]): Written[] {
  const lines = content.split("\n");
  const written = new Map<number, string>();
  for (const fragment of fragments) {
    if (fragment.trim() === "") {
      continue;
    }
    const at = content.indexOf(fragment);
    if (at !== -1) {
      const first = content.slice(0, at).split("\n").length;
      const count = fragment.split("\n").length;
      for (let line = first; line < first + count && line <= lines.length; line++) {
        written.set(line, lines[line - 1] ?? "");
      }
      continue;
    }
    for (const wanted of fragment.split("\n")) {
      const trimmed = wanted.trim();
      if (trimmed === "") {
        continue;
      }
      const index = lines.findIndex((line, lineIndex) => !written.has(lineIndex + 1) && line.trim() === trimmed);
      if (index !== -1) {
        written.set(index + 1, lines[index] ?? "");
      }
    }
  }
  return [...written.entries()].sort(([a], [b]) => a - b).map(([line, text]) => ({ line, text }));
}
