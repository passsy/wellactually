/**
 * The test framework for a principle, as it runs inside the isolate.
 *
 * A test builds the event a detector receives and asks what the detector
 * says about it:
 *
 *     test("fires on a late field", () => {
 *       expect(detect(write("lib/user.dart", "late String name;"))).toEqual([{ line: 1, evidence: "late String name;" }]);
 *     });
 *
 * On an author's machine the same file runs under vitest, where `test` and
 * `expect` are vitest's and `detect` comes from `test.node.ts`. Here, in
 * `wellactually test`, the browser editor and the registry, `vitest` resolves
 * to this file's small copy of that API. Either way `detect` does not call
 * the detector directly. It asks the host, which runs the real detector the
 * way the hook does and keeps a record, so the registry knows what was shown
 * to fire and what was shown to stay quiet.
 */
import type { Ctx, Finding } from "./index.ts";
import type { DetectOptions } from "./events.ts";

export { command, edit, prompt, read, source, write, type DetectOptions } from "./events.ts";

interface Host {
  __detect?: (call: string) => string;
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
export function detect(event: Ctx, options: DetectOptions = {}): Finding[] {
  if (!host.__detect) {
    throw new Error("detect() only works inside a principle's test run.");
  }
  const answer = JSON.parse(host.__detect(JSON.stringify({ event, options }))) as { findings?: Finding[]; error?: string };
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
  /** Deeply equal. Here it is the same as `toEqual`. */
  toStrictEqual(expected: unknown): void;
  /** The same value. */
  toBe(expected: unknown): void;
  toHaveLength(length: number): void;
  /** An array holding `item` itself, or a string holding the text. */
  toContain(item: unknown): void;
  /** An array holding an item deeply equal to `item`. */
  toContainEqual(item: unknown): void;
  /** Has everything `expected` has, and may have more. */
  toMatchObject(expected: unknown): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  /** A function that throws. With `message`, the error has to contain it. */
  toThrow(message?: string): void;
  not: Expectation;
}

function expectation(actual: unknown, negated: boolean): Expectation {
  const check = (passed: boolean, what: string, expected?: unknown): void => {
    if (passed === negated) {
      throw new Error(`Expected ${negated ? "not " : ""}${what}${expected === undefined ? "" : `\n${show(expected)}`}\nReceived\n${show(actual)}`);
    }
  };
  const thrown = (): string | null => {
    try {
      (actual as () => unknown)();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  const matchers: Expectation = {
    toEqual: (expected) => check(equal(actual, expected), "to equal", expected),
    toStrictEqual: (expected) => check(equal(actual, expected), "to equal", expected),
    toBe: (expected) => check(Object.is(actual, expected), "to be", expected),
    toHaveLength: (length) => check((actual as { length?: unknown } | null)?.length === length, "length", length),
    toContain: (item) => check(typeof actual === "string" ? actual.includes(String(item)) : Array.isArray(actual) && actual.includes(item), "to contain", item),
    toContainEqual: (item) => check(Array.isArray(actual) && actual.some((candidate) => equal(candidate, item)), "to contain", item),
    toMatchObject: (expected) => check(matches(actual, expected), "to match", expected),
    toBeTruthy: () => check(Boolean(actual), "a truthy value"),
    toBeFalsy: () => check(!actual, "a falsy value"),
    toBeNull: () => check(actual === null, "null"),
    toBeUndefined: () => check(actual === undefined, "undefined"),
    toBeDefined: () => check(actual !== undefined, "a defined value"),
    toThrow: (message) => {
      const error = thrown();
      check(error !== null && (message === undefined || error.includes(message)), message === undefined ? "to throw" : "to throw an error containing", message);
    },
    get not() {
      return expectation(actual, !negated);
    },
  };
  // A test also runs under vitest, which knows many more matchers. One that is
  // missing here must say so, or it fails on the registry as "not a function".
  return new Proxy(matchers, {
    get(target, name, receiver) {
      if (typeof name === "string" && !(name in target)) {
        throw new Error(
          `expect().${name} is not available when the registry runs the tests. Use one of: ${Object.keys(target).filter((key) => key !== "not").join(", ")}.`,
        );
      }
      return Reflect.get(target, name, receiver);
    },
  });
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
