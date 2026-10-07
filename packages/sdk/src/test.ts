/**
 * The test framework for a principle.
 *
 * A test builds the event a detector receives and asks what the detector
 * says about it:
 *
 *     test("fires on a late field", () => {
 *       expect(detect(write("lib/user.dart", "late String name;"))).toEqual([{ line: 1, evidence: "late String name;" }]);
 *     });
 *
 * Tests run inside the isolate: in `wellactually test`, in the browser editor
 * and on the registry, always the same way. `detect` does not call the
 * detector directly. It asks the host, which runs the real detector the way
 * the hook does and keeps a record, so the registry knows what was shown to
 * fire and what was shown to stay quiet.
 */
import { fileCtx, locateWritten, textCtx, type Ctx, type Finding } from "./index.ts";

/** The agent wrote this file in full. Every line counts as written. */
export function write(path: string, content: string): Ctx {
  return fileCtx("write", path, content);
}

/**
 * The agent edited a file. `content` is the file after the edit and
 * `change.written` is the text the agent put in, as one piece or several.
 */
export function edit(path: string, content: string, change: { written: string | readonly string[] }): Ctx {
  const fragments = typeof change.written === "string" ? [change.written] : change.written;
  const written = locateWritten(content, fragments);
  if (written.length === 0) {
    throw new Error(`edit("${path}"): the written text does not occur in the file. Pass the file as it is after the edit.`);
  }
  return fileCtx("write", path, content, written);
}

/** The agent read this file. It wrote none of it. */
export function read(path: string, content: string): Ctx {
  return fileCtx("read", path, content);
}

/** The user typed this. */
export function prompt(text: string): Ctx {
  return textCtx("prompt", text);
}

/** The agent is about to run this shell command. */
export function command(text: string): Ctx {
  return textCtx("command", text);
}

/**
 * A multi-line string without the indentation of the test around it.
 *
 * `${` and a backtick inside it need a backslash, as in any template string.
 */
export function source(strings: TemplateStringsArray, ...values: unknown[]): string {
  const text = strings.raw.reduce((out, part, index) => out + part.replace(/\\([`$\\])/g, "$1") + (index < values.length ? String(values[index]) : ""), "");
  const lines = text.split("\n");
  if (lines[0]?.trim() === "") {
    lines.shift();
  }
  if (lines.at(-1)?.trim() === "") {
    lines.pop();
  }
  const indent = Math.min(...lines.filter((line) => line.trim() !== "").map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0));
  return lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join("\n");
}

interface Host {
  __detect?: (event: string) => string;
  __begin?: (test: string) => void;
}

const host = globalThis as Host;

/**
 * What the detector reports for an event: the findings that passed the host's checks.
 *
 * It is empty when the detector's `events` or `globs` do not select the event,
 * exactly as in a session. It throws when the detector fails or reports a
 * finding the host would drop, so a test cannot pass on a broken detector.
 */
export function detect(event: Ctx): Finding[] {
  if (!host.__detect) {
    throw new Error("detect() only works inside the principle test runner: `wellactually test`, the editor's Run tests, or the registry.");
  }
  const answer = JSON.parse(host.__detect(JSON.stringify(event))) as { findings?: Finding[]; error?: string };
  if (answer.error !== undefined) {
    throw new Error(answer.error);
  }
  return answer.findings ?? [];
}

interface Registered {
  file: string;
  name: string;
  run: () => unknown;
}

const MAX_TESTS = 100;
const registered: Registered[] = [];
const groups: string[] = [];
let currentFile = "";

/** Groups tests under a name. */
export function describe(name: string, body: () => void): void {
  groups.push(name);
  try {
    body();
  } finally {
    groups.pop();
  }
}

function register(name: string, run: () => unknown): void {
  registered.push({ file: currentFile, name: [...groups, name].join(" > "), run });
}

function each<Row>(rows: readonly Row[]) {
  return (name: string, body: (row: Row) => unknown): void => {
    for (const row of rows) {
      const shown = typeof row === "string" ? row : JSON.stringify(row);
      register(name.includes("%s") ? name.replace("%s", shown) : `${name} (${shown})`, () => body(row));
    }
  };
}

/** Declares one test. `test.each(rows)(name, body)` declares one per row; `%s` in the name is the row. */
export const test = Object.assign(register, { each });
export const it = test;

function show(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value, null, 2);
}

/** Deep equality that ignores properties set to undefined, as a finding without a line has no `line`. */
function equal(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)].filter((key) => left[key] !== undefined || right[key] !== undefined));
  if (Array.isArray(a) && a.length !== (b as unknown[]).length) {
    return false;
  }
  return [...keys].every((key) => equal(left[key], right[key]));
}

/** Whether `actual` has everything `expected` has. Arrays must match item by item. */
function matches(actual: unknown, expected: unknown): boolean {
  if (typeof expected !== "object" || expected === null) {
    return equal(actual, expected);
  }
  if (typeof actual !== "object" || actual === null || Array.isArray(actual) !== Array.isArray(expected)) {
    return false;
  }
  if (Array.isArray(expected)) {
    return (actual as unknown[]).length === expected.length && expected.every((item, index) => matches((actual as unknown[])[index], item));
  }
  return Object.entries(expected).every(([key, value]) => matches((actual as Record<string, unknown>)[key], value));
}

export interface Expectation {
  /** Deeply equal. */
  toEqual(expected: unknown): void;
  /** The same value. */
  toBe(expected: unknown): void;
  toHaveLength(length: number): void;
  /** An array holding an item deeply equal to `item`. */
  toContainEqual(item: unknown): void;
  /** Has everything `expected` has, and may have more. */
  toMatchObject(expected: unknown): void;
  not: Expectation;
}

function expectation(actual: unknown, negated: boolean): Expectation {
  const check = (passed: boolean, what: string, expected: unknown): void => {
    if (passed === negated) {
      throw new Error(`Expected ${negated ? "not " : ""}${what}\n${show(expected)}\nReceived\n${show(actual)}`);
    }
  };
  return {
    toEqual: (expected) => check(equal(actual, expected), "to equal", expected),
    toBe: (expected) => check(Object.is(actual, expected), "to be", expected),
    toHaveLength: (length) => check((actual as { length?: unknown } | null)?.length === length, "length", length),
    toContainEqual: (item) => check(Array.isArray(actual) && actual.some((candidate) => equal(candidate, item)), "to contain", item),
    toMatchObject: (expected) => check(matches(actual, expected), "to match", expected),
    get not() {
      return expectation(actual, !negated);
    },
  };
}

export function expect(actual: unknown): Expectation {
  return expectation(actual, false);
}

/** Called by the runner before a test file is loaded, so its tests carry its name. */
export function __file(name: string): void {
  currentFile = name;
}

/** Called by the runner once every test file is loaded. Returns the results as JSON. */
export function __run(): string {
  if (registered.length > MAX_TESTS) {
    throw new Error(`a principle may hold at most ${MAX_TESTS} tests, this one has ${registered.length}`);
  }
  const results = registered.map((entry) => {
    host.__begin?.(JSON.stringify({ file: entry.file, name: entry.name }));
    try {
      const returned = entry.run();
      if (typeof (returned as { then?: unknown } | null)?.then === "function") {
        throw new Error("A test must not be async. detect() answers immediately.");
      }
      return { file: entry.file, name: entry.name, passed: true, message: "" };
    } catch (error) {
      return { file: entry.file, name: entry.name, passed: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
  return JSON.stringify(results);
}
