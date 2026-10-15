import path from "node:path";

/** A file a shell command wrote, and what it wrote there. */
export interface ShellWrite {
  /** The absolute path of the file. */
  file: string;
  /** The pieces of text the command added to the file, or null when all of the file is the command's. */
  fragments: string[] | null;
}

/** A word of a command, without its quotes. */
interface Word {
  text: string;
  /** Whether the shell would expand part of it, like `$TMPDIR`. Its text is then not what the shell sees. */
  dynamic: boolean;
  /** Whether any of it was quoted. `2>` is a redirect of standard error, `"2">` is not. */
  quoted: boolean;
}

/** A redirect of standard output into a file: `>`, `>>`, `&>`. */
interface Redirect {
  target: Word;
  append: boolean;
}

/** One command between `&&`, `||`, `;`, `|` and newlines. */
interface SimpleCommand {
  words: Word[];
  redirects: Redirect[];
  /** The body of its here-document, without the line that ends it. */
  heredoc: string | null;
  /** Whether a `|` feeds it what the command before it printed. */
  piped: boolean;
}

/** What a word after a redirect operator stands for. */
type Pending = { kind: "redirect"; append: boolean } | { kind: "heredoc"; stripTabs: boolean } | { kind: "skip" };

/** A command, or the start or end of a `( … )` subshell, which keeps its `cd` to itself. */
type Step = SimpleCommand | "(" | ")";

/**
 * The files a shell command writes with a redirect or `tee`, the way agents
 * write files without a file tool: `cat > lib/a.dart <<'EOF'`.
 *
 * Only text the command itself carries counts: a here-document, `echo` or
 * `printf`. What a program printed into a file, like
 * `git show HEAD:a.dart > a.dart` or `curl … > vendor.js`, is not text the
 * agent wrote, and is left out.
 *
 * `cwd` is where the command starts. A `cd` in the command moves where the
 * paths after it are resolved from. A path the shell would expand, like
 * `$TMPDIR/a.dart`, is not known here and left out.
 *
 * This reads the command, it does not run it: only what a redirect or `tee`
 * names is found, not a file a program writes by itself, like `sed -i`.
 */
export function shellWrites(command: string, cwd: string, home: string): ShellWrite[] {
  const writes = new Map<string, string[] | null>();
  const dirs: (string | null)[] = [];
  let dir: string | null = cwd;
  /** What the command before a `|` printed, when that can be told. */
  let piped: string | null = null;

  const resolve = (word: Word): string | null => {
    if (word.dynamic) {
      return null;
    }
    const text = word.text === "~" || word.text.startsWith("~/") ? home + word.text.slice(1) : word.text;
    if (path.isAbsolute(text)) {
      return text;
    }
    return dir === null ? null : path.resolve(dir, text);
  };
  const record = (target: Word, append: boolean, text: string | null): void => {
    const file = resolve(target);
    // Text this cannot tell is what a program printed, like `git show HEAD:a.dart > a.dart`, which the agent did not write.
    if (file === null || file.startsWith("/dev/") || text === null) {
      return;
    }
    if (!append) {
      writes.set(file, null);
      return;
    }
    // Appended to a file the command wrote whole.
    const before = writes.get(file);
    if (before === null) {
      return;
    }
    writes.set(file, [...(before ?? []), text]);
  };

  for (const step of parse(command)) {
    if (step === "(") {
      dirs.push(dir);
      continue;
    }
    if (step === ")") {
      dir = dirs.length > 0 ? (dirs.pop() ?? null) : dir;
      continue;
    }
    const stdin = step.heredoc ?? (step.piped ? piped : null);
    const [name, ...args] = step.words;
    piped = null;
    if (name?.text === "cd" && !name.quoted) {
      const target = args[0];
      dir = target === undefined ? home : target.text === "-" ? null : resolve(target);
      continue;
    }
    // Where a `pushd` or `popd` leads depends on the stack the shell had before the command.
    if ((name?.text === "pushd" || name?.text === "popd") && !name.quoted) {
      dir = null;
      continue;
    }
    const printed = printedBy(name, args, stdin);
    piped = printed;
    for (const redirect of step.redirects) {
      record(redirect.target, redirect.append, printed);
    }
    if (name?.text === "tee") {
      const append = args.some((arg) => arg.text === "--append" || /^-[a-z]*a/.test(arg.text));
      for (const arg of args) {
        if (!arg.text.startsWith("-")) {
          record(arg, append, stdin);
        }
      }
    }
  }
  return [...writes.entries()].map(([file, fragments]) => ({ file, fragments }));
}

/**
 * What a command prints, when that can be told from the command alone: a
 * here-document through `cat` or `tee`, `echo`, or `printf` with a format
 * that takes no arguments. That is text the agent wrote into the command.
 */
function printedBy(name: Word | undefined, args: Word[], stdin: string | null): string | null {
  if ((name?.text === "cat" && args.length === 0) || name?.text === "tee") {
    return stdin;
  }
  const format = args[0];
  if (name?.text === "printf" && args.length === 1 && format !== undefined && !format.dynamic && !format.text.includes("%")) {
    return format.text.replace(/\\([nt\\])/g, (_, escape: string) => (escape === "n" ? "\n" : escape === "t" ? "\t" : "\\"));
  }
  if (name?.text === "echo" && args.every((arg) => !arg.dynamic)) {
    return args
      .map((arg) => arg.text)
      .filter((text, index) => index > 0 || !/^-[neE]+$/.test(text))
      .join(" ");
  }
  return null;
}

/**
 * Splits a shell command into its simple commands, the way a POSIX shell
 * reads it: quotes, escapes, comments, redirects and here-documents. What
 * `$( … )` and backticks run is left as part of a word.
 */
function parse(command: string): Step[] {
  const steps: Step[] = [];
  const fresh = (piped: boolean): SimpleCommand => ({ words: [], redirects: [], heredoc: null, piped });
  let current = fresh(false);
  let word: Word | null = null;
  let pending: Pending | null = null;
  let heredocs: { delimiter: string; stripTabs: boolean; command: SimpleCommand }[] = [];
  let i = 0;

  const add = (text: string, flags: { dynamic?: boolean; quoted?: boolean } = {}): void => {
    word ??= { text: "", dynamic: false, quoted: false };
    word.text += text;
    word.dynamic ||= flags.dynamic === true;
    word.quoted ||= flags.quoted === true;
  };
  const endWord = (): void => {
    if (word === null) {
      return;
    }
    if (pending?.kind === "redirect") {
      current.redirects.push({ target: word, append: pending.append });
    } else if (pending?.kind === "heredoc") {
      heredocs.push({ delimiter: word.text, stripTabs: pending.stripTabs, command: current });
    } else if (pending === null) {
      current.words.push(word);
    }
    pending = null;
    word = null;
  };
  const endCommand = (piped: boolean): void => {
    endWord();
    pending = null;
    if (current.words.length > 0 || current.redirects.length > 0 || current.heredoc !== null || heredocs.some((heredoc) => heredoc.command === current)) {
      steps.push(current);
    }
    current = fresh(piped);
  };
  /** The redirect of a file descriptor named by the word just before the operator, like the 2 in `2>`. */
  const takeDescriptor = (): string => {
    const taken = word;
    if (taken !== null && !taken.quoted && /^\d+$/.test(taken.text)) {
      word = null;
      return taken.text;
    }
    endWord();
    return "1";
  };
  /** The here-documents of the line that just ended, which start on the next one. */
  const readHeredocs = (): void => {
    for (const heredoc of heredocs) {
      const body: string[] = [];
      while (i < command.length) {
        const end = command.indexOf("\n", i);
        const stop = end === -1 ? command.length : end;
        const raw = command.slice(i, stop);
        const line = heredoc.stripTabs ? raw.replace(/^\t+/, "") : raw;
        i = stop + 1;
        if (line === heredoc.delimiter) {
          break;
        }
        body.push(line);
      }
      heredoc.command.heredoc = body.join("\n");
    }
    heredocs = [];
  };

  while (i < command.length) {
    const c = command[i] ?? "";
    const next = command[i + 1] ?? "";
    if (c === "\\") {
      if (next !== "\n") {
        add(next, { quoted: true });
      }
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end === -1 ? command.length : end;
      add(command.slice(i + 1, stop), { quoted: true });
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      i++;
      add("", { quoted: true });
      while (i < command.length && command[i] !== '"') {
        const inner = command[i] ?? "";
        if (inner === "\\" && /[$`"\\\n]/.test(command[i + 1] ?? "")) {
          if (command[i + 1] !== "\n") {
            add(command[i + 1] ?? "");
          }
          i += 2;
          continue;
        }
        if (inner === "$" || inner === "`") {
          const stop = expansionEnd(command, i);
          add(command.slice(i, stop), { dynamic: stop > i + 1 });
          i = stop;
          continue;
        }
        add(inner);
        i++;
      }
      i++;
      continue;
    }
    if (c === "$" || c === "`") {
      const stop = expansionEnd(command, i);
      add(command.slice(i, stop), { dynamic: stop > i + 1 });
      i = stop;
      continue;
    }
    if (c === "#" && word === null) {
      const end = command.indexOf("\n", i);
      i = end === -1 ? command.length : end;
      continue;
    }
    if (c === "\n") {
      endCommand(false);
      i++;
      readHeredocs();
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      i++;
      continue;
    }
    if (c === ";" || c === "(" || c === ")") {
      endCommand(false);
      if (c !== ";") {
        steps.push(c);
      }
      i++;
      continue;
    }
    if (c === "|") {
      endCommand(next !== "|");
      i += next === "|" || next === "&" ? 2 : 1;
      continue;
    }
    if (c === "&" && next === ">") {
      endWord();
      const append = command[i + 2] === ">";
      pending = { kind: "redirect", append };
      i += append ? 3 : 2;
      continue;
    }
    if (c === "&") {
      endCommand(false);
      i += next === "&" ? 2 : 1;
      continue;
    }
    if (c === ">") {
      const descriptor = takeDescriptor();
      const append = next === ">";
      i += append ? 2 : 1;
      if (command[i] === "|") {
        i++;
      }
      if (command[i] === "&") {
        // `>&2` hands output to another descriptor, `>&file` is `&>file`.
        i++;
        const duplicate = /[\d-]/.test(command[i] ?? "");
        pending = duplicate || descriptor !== "1" ? { kind: "skip" } : { kind: "redirect", append };
        continue;
      }
      pending = descriptor === "1" ? { kind: "redirect", append } : { kind: "skip" };
      continue;
    }
    if (c === "<") {
      takeDescriptor();
      if (command.startsWith("<<<", i)) {
        pending = { kind: "skip" };
        i += 3;
      } else if (next === "<") {
        const stripTabs = command[i + 2] === "-";
        pending = { kind: "heredoc", stripTabs };
        i += stripTabs ? 3 : 2;
      } else {
        pending = { kind: "skip" };
        i += next === "&" || next === ">" ? 2 : 1;
      }
      continue;
    }
    add(c);
    i++;
  }
  endCommand(false);
  return steps;
}

/** Where an expansion that starts at `start` ends: `$name`, `${ … }`, `$( … )` or a backtick pair. */
function expansionEnd(command: string, start: number): number {
  if (command[start] === "`") {
    const end = command.indexOf("`", start + 1);
    return end === -1 ? command.length : end + 1;
  }
  const open = command[start + 1];
  if (open === "(" || open === "{") {
    const close = open === "(" ? ")" : "}";
    let depth = 0;
    for (let i = start + 1; i < command.length; i++) {
      if (command[i] === open) {
        depth++;
      } else if (command[i] === close) {
        depth--;
        if (depth === 0) {
          return i + 1;
        }
      }
    }
    return command.length;
  }
  const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9?#@*!$-])/.exec(command.slice(start + 1));
  return start + 1 + (name?.[0].length ?? 0);
}
