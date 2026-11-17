/**
 * Glob matching for the `globs` of a file handler, on forward-slash relative paths.
 *
 * Supports `**`, `*`, `?` and `{a,b}`. A pattern without a slash matches the
 * basename anywhere, so `*.dart` and `**\/*.dart` mean the same thing.
 * A pattern that starts with `!` takes files out again: `!**\/*.g.dart`.
 */

const cache = new Map<string, Matcher>();

export function matchesGlob(path: string, pattern: string): boolean {
  let matcher = cache.get(pattern);
  if (!matcher) {
    matcher = compile(pattern);
    cache.set(pattern, matcher);
  }
  return matcher(path);
}

/**
 * Whether `globs` select the file at `path`.
 *
 * A file is selected when one of the patterns matches it and no pattern
 * starting with `!` does. Without a pattern that selects, every file is in:
 * an empty list means all files, and `["!**\/*.g.dart"]` all but generated ones.
 */
export function matchesGlobs(path: string, globs: readonly string[]): boolean {
  const excluded = globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
  if (excluded.some((glob) => matchesGlob(path, glob))) {
    return false;
  }
  const included = globs.filter((glob) => !glob.startsWith("!"));
  return included.length === 0 || included.some((glob) => matchesGlob(path, glob));
}

type Matcher = (path: string) => boolean;

/** One piece of a pattern: a character, `?`, `*`, `**` before a slash, `**` elsewhere, or `{a,b}`. */
type Piece =
  | { kind: "char"; char: string }
  | { kind: "one" }
  | { kind: "star" }
  | { kind: "folders" }
  | { kind: "any" }
  | { kind: "either"; options: Piece[][] };

/**
 * Reads a pattern into pieces. A `{` that is never closed is a character,
 * and so are a `}` without its `{` and a `,` outside braces.
 */
function parse(pattern: string): Piece[] {
  // By code point, the way the path is read, so a character outside the BMP is one character.
  const anchored = [...(pattern.includes("/") ? pattern.replace(/^\.?\//, "") : `**/${pattern}`)];
  const root: Piece[] = [];
  // The braces that are open, innermost last, each with its options so far.
  const open: Piece[][][] = [];
  const current = (): Piece[] => open.at(-1)?.at(-1) ?? root;
  for (let i = 0; i < anchored.length; i++) {
    const char = anchored[i] ?? "";
    if (char === "*" && anchored[i + 1] === "*") {
      const slashAfter = anchored[i + 2] === "/";
      current().push({ kind: slashAfter ? "folders" : "any" });
      i += slashAfter ? 2 : 1;
      continue;
    }
    if (char === "*") {
      current().push({ kind: "star" });
    } else if (char === "?") {
      current().push({ kind: "one" });
    } else if (char === "{") {
      open.push([[]]);
    } else if (char === "}" && open.length > 0) {
      const options = open.pop() as Piece[][];
      current().push({ kind: "either", options });
    } else if (char === "," && open.length > 0) {
      open.at(-1)?.push([]);
    } else {
      current().push({ kind: "char", char });
    }
  }
  while (open.length > 0) {
    const [first = [], ...rest] = open.pop() as Piece[][];
    current().push({ kind: "char", char: "{" }, ...first, ...rest.flatMap((option): Piece[] => [{ kind: "char", char: "," }, ...option]));
  }
  return root;
}

/** A state of the matcher: the characters it moves on with, and the states it reaches without one. */
interface State {
  moves: { takes: (char: string) => boolean; to: number }[];
  free: number[];
}

const anyChar = (): boolean => true;
const notSlash = (char: string): boolean => char !== "/";

/**
 * Turns a pattern into a matcher that takes time in proportion to the
 * pattern times the path, whatever the pattern.
 *
 * A regular expression would be shorter, but it backtracks: a pattern such
 * as `**\/**\/**\/…` takes seconds on an ordinary path. Globs come from
 * detectors, which anybody writes, and the host matches them before any
 * isolate starts, outside its time limit. So the pattern becomes a set of
 * states that is walked one character of the path at a time, and the walk
 * never goes back.
 */
function compile(pattern: string): Matcher {
  const states: State[] = [{ moves: [], free: [] }];
  const add = (): number => states.push({ moves: [], free: [] }) - 1;
  const state = (index: number): State => states[index] as State;

  // Builds the pieces back to front, so each knows the state that follows it.
  const sequence = (pieces: Piece[], next: number): number => {
    let after = next;
    for (let i = pieces.length - 1; i >= 0; i--) {
      after = piece(pieces[i] as Piece, after);
    }
    return after;
  };
  const piece = (it: Piece, next: number): number => {
    const at = add();
    switch (it.kind) {
      case "char":
        state(at).moves.push({ takes: (char) => char === it.char, to: next });
        break;
      case "one":
        state(at).moves.push({ takes: notSlash, to: next });
        break;
      case "star":
        state(at).moves.push({ takes: notSlash, to: at });
        state(at).free.push(next);
        break;
      case "any":
        state(at).moves.push({ takes: anyChar, to: at });
        state(at).free.push(next);
        break;
      case "folders": {
        // Nothing, or anything that ends with a slash.
        const inside = add();
        state(at).free.push(next, inside);
        state(inside).moves.push({ takes: anyChar, to: inside }, { takes: (char) => char === "/", to: next });
        break;
      }
      case "either":
        for (const option of it.options) {
          state(at).free.push(sequence(option, next));
        }
        break;
    }
    return at;
  };
  const start = sequence(parse(pattern), 0);

  const reach = (from: Iterable<number>): Set<number> => {
    const seen = new Set<number>();
    const stack = [...from];
    while (stack.length > 0) {
      const index = stack.pop() as number;
      if (!seen.has(index)) {
        seen.add(index);
        stack.push(...state(index).free);
      }
    }
    return seen;
  };
  return (path) => {
    let now = reach([start]);
    for (const char of path) {
      const next: number[] = [];
      for (const index of now) {
        for (const move of state(index).moves) {
          if (move.takes(char)) {
            next.push(move.to);
          }
        }
      }
      if (next.length === 0) {
        return false;
      }
      now = reach(next);
    }
    // State 0 is where every pattern ends.
    return now.has(0);
  };
}
