import type { BuildFailure, Message, Plugin } from "esbuild";
import { currentEngines } from "./engines.ts";
import { SDK_SOURCES } from "./sdk-source.generated.ts";

/** A principle's files, keyed by forward-slash path relative to its directory. */
export type FileMap = Record<string, string>;

export class BundleError extends Error {}

/** The name the bundled detector module is bound to inside the isolate. */
export const BUNDLE_GLOBAL = "__principle";

const MAX_BUNDLE_BYTES = 256 * 1024;
const SDK = "@wellactually/sdk";
const SDK_TEST = "@wellactually/sdk/test";
const DETECTOR_ENTRIES = ["detector.ts", "detector.js", "detector.mjs"];
/** The entry of the test bundle. It is made up by the build and is not one of the principle's files. */
const TEST_ENTRY = "__tests__.ts";

/** The name the bundled tests are bound to inside the isolate. */
export const TESTS_GLOBAL = "__tests";

/** The detector file of a principle, or null when it has none. */
export function detectorEntry(files: FileMap): string | null {
  return DETECTOR_ENTRIES.find((name) => name in files) ?? null;
}

/** The test files of a principle: every `*.test.ts` or `*.test.js`, wherever it lies. */
export function testFiles(files: FileMap): string[] {
  return Object.keys(files)
    .filter((name) => /\.test\.(ts|js|mjs)$/.test(name))
    .sort();
}

/** Bytes of a string as UTF-8, without reaching for Node's Buffer. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Resolves `.` and `..` in a forward-slash path. A result starting with `..` left the root. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === ".." && out.length > 0 && out.at(-1) !== "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * Compiles a principle's detector into one script for the isolate.
 *
 * The build never touches a disk: the principle's files come from the map and
 * the SDK from strings compiled into this package. That is what lets the
 * same build run in the CLI, on the registry and in a browser. A detector may
 * import its own relative files and the SDK. Everything else is refused here,
 * at build time, because nothing else exists inside the isolate.
 */
export async function buildBundle(files: FileMap): Promise<string> {
  const entry = detectorEntry(files);
  if (!entry) {
    throw new BundleError(`no detector found; expected one of ${DETECTOR_ENTRIES.join(", ")}`);
  }
  return build(files, entry, BUNDLE_GLOBAL, false);
}

/**
 * Compiles a principle's test files into one script for the isolate.
 *
 * The script loads every test file, which registers its tests, and exposes
 * `run()`. A test file may import the test framework, the SDK and its own
 * relative files. Null when the principle has no test files.
 */
export async function buildTestBundle(files: FileMap): Promise<string | null> {
  const tests = testFiles(files);
  if (tests.length === 0) {
    return null;
  }
  const entry = [`import { __run } from "${SDK_TEST}";`, ...tests.map((name) => `import "./${name}";`), "export const run = __run;", ""].join("\n");
  return build({ ...files, [TEST_ENTRY]: entry }, TEST_ENTRY, TESTS_GLOBAL, true);
}

async function build(files: FileMap, entry: string, globalName: string, isTest: boolean): Promise<string> {
  const tests = new Set(isTest ? testFiles(files) : []);
  const virtual: Plugin = {
    name: "principle-files",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") {
          // esbuild rewrites an entry to "./detector.ts" when a file of that name
          // happens to exist in the working directory, so the path is normalized.
          return { path: normalize(args.path), namespace: "principle" };
        }
        if (args.path === SDK) {
          return { path: "index.ts", namespace: "sdk" };
        }
        if (args.path === SDK_TEST) {
          if (!isTest) {
            return { errors: [{ text: `${SDK_TEST} is for test files. A detector cannot import it.` }] };
          }
          return { path: "test.ts", namespace: "sdk" };
        }
        if (args.namespace === "sdk" && args.path.startsWith("./")) {
          return { path: args.path.slice(2), namespace: "sdk" };
        }
        if (args.namespace === "principle" && args.path.startsWith(".")) {
          const joined = normalize(`${dirname(args.importer)}/${args.path}`);
          const found = [joined, `${joined}.ts`, `${joined}.js`].find((candidate) => candidate in files);
          if (found && !found.startsWith("..")) {
            return { path: found, namespace: "principle" };
          }
          return { errors: [{ text: `cannot find "${args.path}" in the principle's files` }] };
        }
        return {
          errors: [
            {
              text: `"${args.path}" cannot be imported. A ${isTest ? "test" : "detector"} may import its own relative files and ${SDK}${isTest ? ` and ${SDK_TEST}` : ""}, nothing else.`,
            },
          ],
        };
      });
      build.onLoad({ filter: /.*/, namespace: "sdk" }, (args) => {
        const contents = SDK_SOURCES[args.path];
        return contents === undefined ? { errors: [{ text: `the SDK has no file "${args.path}"` }] } : { contents, loader: "ts" };
      });
      build.onLoad({ filter: /.*/, namespace: "principle" }, (args) => {
        const contents = files[args.path];
        if (contents === undefined) {
          return { errors: [{ text: `"${args.path}" is not one of the principle's files` }] };
        }
        const loader = args.path.endsWith(".ts") ? "ts" : "js";
        if (tests.has(args.path)) {
          // Tells the framework which file the following tests belong to. It shares the
          // first line with the file's own code, so line numbers in errors stay right.
          return { contents: `import { __file as __wellactuallyFile } from "${SDK_TEST}";__wellactuallyFile(${JSON.stringify(args.path)});${contents}`, loader };
        }
        return { contents, loader };
      });
    },
  };

  let code: string;
  try {
    const result = await currentEngines().build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "iife",
      globalName,
      platform: "neutral",
      target: "es2020",
      logLevel: "silent",
      plugins: [virtual],
    });
    code = result.outputFiles?.[0]?.text ?? "";
  } catch (error) {
    const failure = error as BuildFailure;
    const messages = failure.errors?.map(formatMessage) ?? [String(error)];
    throw new BundleError(messages.join("\n"));
  }

  if (byteLength(code) > MAX_BUNDLE_BYTES) {
    throw new BundleError(`the bundled ${isTest ? "tests are" : "detector is"} larger than ${MAX_BUNDLE_BYTES / 1024} KB`);
  }
  return code;
}

function formatMessage(message: Message): string {
  const where = message.location ? `${message.location.file.replace(/^(principle|sdk):/, "")}:${message.location.line}: ` : "";
  return `${where}${message.text}`;
}
