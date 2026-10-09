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
 */
export const API_VERSION = 2;

/**
 * What happened in the session.
 *
 * - `write`: the agent wrote or edited a file. `ctx.file.written` holds the lines it wrote.
 * - `read`: the agent read a file. It did not write this code.
 * - `prompt`: the user typed a message.
 * - `command`: the agent is about to run a shell command.
 */
export type EventName = "write" | "read" | "prompt" | "command";

export const EVENTS: readonly EventName[] = ["write", "read", "prompt", "command"];

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
 * Pointer findings for each of `names` that occurs in a conversation event.
 *
 * This is a name check for a named technology, not a keyword cloud.
 * Pass the few phrases that can only mean your topic.
 */
export function* mentioned(ctx: Ctx, names: readonly string[]): Generator<Finding> {
  if (!ctx.isConversation) {
    return;
  }
  const haystack = ctx.text.toLowerCase();
  for (const name of names) {
    const at = findWord(haystack, name.toLowerCase());
    if (at === -1) {
      continue;
    }
    yield { evidence: ctx.text.slice(at, at + name.length), depth: "pointer" };
    return;
  }
}

/** The lines the agent wrote in this event. Empty when no file is involved. */
export function writtenLines(ctx: Ctx): WrittenLine[] {
  return ctx.file?.written ?? [];
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
export function fileCtx(event: "write" | "read", relativePath: string, content: string, written?: WrittenLine[], where: Where = {}): Ctx {
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
      written: event === "read" ? [] : (written ?? allLines),
      isNew: event === "write" && where.isNew === true,
    },
    text: content,
    isUserPrompt: false,
    isCommand: false,
    isConversation: false,
    project: root,
  };
}

/** The event for text: what the user typed, or a command about to run. */
export function textCtx(event: "prompt" | "command", text: string, root: string | null = TEST_ROOT): Ctx {
  return {
    event,
    file: null,
    text,
    isUserPrompt: event === "prompt",
    isCommand: event === "command",
    isConversation: true,
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
export function locateWritten(content: string, fragments: readonly string[]): WrittenLine[] {
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
