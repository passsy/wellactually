/**
 * Everything a detector may import.
 *
 * A detector runs inside an isolate with no filesystem, no network and no
 * process. This module is bundled into it at publish time, so it must stay
 * free of Node imports and of any state.
 */

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
  /** Path relative to the project root, with forward slashes. */
  path: string;
  /** Basename, e.g. "config_loader.dart". */
  name: string;
  /** Extension including the dot, lower case. Empty when there is none. */
  ext: string;
  content: string;
  /** `content` split into lines. */
  lines: string[];
  /** The lines the agent wrote. Empty on `read`. */
  written: WrittenLine[];
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
