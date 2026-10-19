import type { BuildFailure, Message, Plugin } from "esbuild";
import { API_VERSION } from "@wellactually/sdk";
import { currentEngines } from "./engines.ts";
import { LICENSE_FILE_NAMES } from "./licenses.ts";
import { isPackageFile, packageOf, PACKAGE_DIR, PackageError, readPins, resolveInPackage, resolvePackage, TAKEN_FROM, type PackageSource } from "./packages.ts";
import { SDK_SOURCES } from "./sdk-source.generated.ts";

/**
 * A principle's files, keyed by forward-slash path relative to its directory,
 * with the packages it vendors below `node_modules/`.
 */
export type PrincipleFiles = Record<string, string>;

export class BundleError extends Error {}

/** The name the bundled detector module is bound to inside the isolate. */
export const BUNDLE_GLOBAL = "__principle";

/** The detector with everything it imports, packages included. It is sent to every machine that uses the principle. */
const MAX_BUNDLE_BYTES = 1024 * 1024;
/** Modules of Node that a package may ask for and the isolate does not have. */
const NODE_MODULES = new Set(["assert", "buffer", "child_process", "crypto", "events", "http", "https", "module", "net", "os", "process", "stream", "string_decoder", "tty", "url", "util", "worker_threads", "zlib"]);
const SDK = "@wellactually/sdk";
/** What an author imports: `@wellactually/sdk/v3` in a detector, `@wellactually/sdk/v3/test` in a test. The version is part of the path. */
const SDK_ENTRY = /^@wellactually\/sdk\/(v\d+)(\/test)?$/;
const SDK_NOW = `${SDK}/v${API_VERSION}`;
/** How the code this build adds reaches the test framework. Not something an author writes. */
const TEST_RUNTIME = "wellactually:test-runtime";
/** How the code this build adds reaches the handlers a detector registered. Not something an author writes. */
const HANDLER_RUNTIME = "wellactually:handler-runtime";
/** The entry of the detector bundle. It is made up by the build and is not one of the principle's files. */
const DETECTOR_ENTRY = "__detector__.ts";
/** What a detector imports to read the project, and the SDK file that answers inside the isolate. */
const BUILT_INS: Record<string, string> = { "node:fs": "fs.ts", fs: "fs.ts", "node:path": "path.ts", path: "path.ts" };
/** The test runner an author uses. Inside the isolate it is the SDK's small copy of it. */
const VITEST = "vitest";
/** Folders that hold a project for a test to run in. A `*.test.ts` in there belongs to that project, not to the principle. */
const FIXTURES = /(^|\/)fixtures\//;
const DETECTOR_ENTRIES = ["detector.ts", "detector.js", "detector.mjs"];
/** The entry of the test bundle. It is made up by the build and is not one of the principle's files. */
const TEST_ENTRY = "__tests__.ts";

/** The name the bundled tests are bound to inside the isolate. */
export const TESTS_GLOBAL = "__tests";

/** The detector file of a principle, or null when it has none. */
export function detectorEntry(files: PrincipleFiles): string | null {
  return DETECTOR_ENTRIES.find((name) => name in files) ?? null;
}

/** The code of a principle: its detector, its tests and what they import. Not the projects in `fixtures/`. */
export function codeFiles(files: PrincipleFiles): string[] {
  return Object.keys(files)
    .filter((name) => /\.(ts|js|mjs)$/.test(name) && !FIXTURES.test(name) && !isPackageFile(name))
    .sort();
}

/** The test files of a principle: every `*.test.ts` or `*.test.js`, wherever it lies outside `fixtures/`. */
export function testFiles(files: PrincipleFiles): string[] {
  return Object.keys(files)
    .filter((name) => /\.test\.(ts|js|mjs)$/.test(name) && !FIXTURES.test(name) && !isPackageFile(name))
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
 * import its own relative files, the SDK, `node:fs` and `node:path`, which
 * resolve to the SDK's read-only versions, and the packages its package.json
 * names, whose code is among the files below `node_modules/`. Everything else
 * is refused here, at build time, because nothing else exists inside the isolate.
 *
 * With a `source`, the code of a package that is not among the files yet is
 * asked from there. That is how a principle is submitted: see `vendorPackages`.
 */
export async function buildBundle(files: PrincipleFiles, source?: PackageSource): Promise<string> {
  return (await buildDetector(files, source)).bundle;
}

/**
 * The principle's files with the code of its packages added, ready to be
 * checked and uploaded.
 *
 * Only the files of a package that the detector and the tests reach are
 * taken, with its package.json, its licence and its NOTICE. After this the files are the
 * whole principle: the registry builds them again with no source to ask.
 */
export async function vendorPackages(files: PrincipleFiles, source: PackageSource): Promise<PrincipleFiles> {
  let pins: Record<string, string>;
  try {
    pins = readPins(files);
  } catch (error) {
    throw new BundleError((error as Error).message);
  }
  if (Object.keys(pins).length === 0 || detectorEntry(files) === null) {
    return files;
  }
  const fetched: PrincipleFiles = {};
  await buildDetector(files, source, fetched);
  await buildTestBundle(files, source, fetched);
  const names = new Set<string>();
  for (const path of Object.keys(fetched)) {
    const name = packageOf(path);
    if (name !== null) {
      names.add(name);
    }
  }
  for (const name of names) {
    // Where a package from a repository was taken from. A package from npm has no such answer.
    const from = await source(name, pins[name] ?? null, TAKEN_FROM);
    if (from !== null) {
      fetched[`${PACKAGE_DIR}${name}/${TAKEN_FROM}`] = from;
    }
    // Every licence and NOTICE file of the package, asked for at once: on the website each is a request.
    const texts = await Promise.all(LICENSE_FILE_NAMES.map((file) => source(name, pins[name] ?? null, file)));
    const taken = new Set<string>();
    for (const [index, text] of texts.entries()) {
      // A disk that ignores case answers LICENSE and license with the same file.
      if (text === null || taken.has(text)) {
        continue;
      }
      taken.add(text);
      fetched[`${PACKAGE_DIR}${name}/${LICENSE_FILE_NAMES[index] ?? ""}`] = text;
    }
  }
  return { ...fetched, ...files };
}

/**
 * The same, with what the detector imported from Node: "node:fs", "node:path".
 * Which of them exist depends on the detector API version. `inlined` names
 * the packages whose code is in the bundle, which are the ones whose licence
 * the bundle has to carry.
 */
export async function buildDetector(files: PrincipleFiles, source?: PackageSource, fetched: PrincipleFiles = {}): Promise<{ bundle: string; builtIns: string[]; inlined: string[] }> {
  const entry = detectorEntry(files);
  if (!entry) {
    throw new BundleError(`no detector found; expected one of ${DETECTOR_ENTRIES.join(", ")}`);
  }
  const builtIns = new Set<string>();
  const inlined = new Set<string>();
  // The detector file registers its handlers while it loads. What the isolate is given is how to list them and how to run them.
  const made = [`import { __dispatch, __handlers } from "${HANDLER_RUNTIME}";`, `import "./${entry}";`, "export const handlers = __handlers;", "export const run = __dispatch;", ""].join("\n");
  const bundle = await build({ ...files, [DETECTOR_ENTRY]: made }, DETECTOR_ENTRY, BUNDLE_GLOBAL, false, builtIns, source, fetched, inlined);
  return { bundle, builtIns: [...builtIns].sort(), inlined: [...inlined].sort() };
}

/**
 * Compiles a principle's test files into one script for the isolate.
 *
 * The script loads every test file, which registers its tests, and exposes
 * `run()`. A test file may import `vitest`, which resolves to the SDK's copy
 * of its API, the SDK of its version and its own relative files. Null when the principle has
 * no test files.
 */
export async function buildTestBundle(files: PrincipleFiles, source?: PackageSource, fetched: PrincipleFiles = {}): Promise<string | null> {
  const tests = testFiles(files);
  if (tests.length === 0) {
    return null;
  }
  const entry = [`import { __run } from "${TEST_RUNTIME}";`, ...tests.map((name) => `import "./${name}";`), "export const run = __run;", ""].join("\n");
  return build({ ...files, [TEST_ENTRY]: entry }, TEST_ENTRY, TESTS_GLOBAL, true, new Set(), source, fetched);
}

async function build(files: PrincipleFiles, entry: string, globalName: string, isTest: boolean, builtIns: Set<string>, source: PackageSource | undefined, fetched: PrincipleFiles, inlined = new Set<string>()): Promise<string> {
  const tests = new Set(isTest ? testFiles(files) : []);
  let pins: Record<string, string>;
  try {
    pins = readPins(files);
  } catch (error) {
    throw new BundleError((error as Error).message);
  }
  const missing = new Set<string>();
  // A file of the principle, or a file of a package asked from the source and kept in `fetched`.
  const read = async (path: string): Promise<string | null> => {
    const own = files[path] ?? fetched[path];
    if (own !== undefined) {
      return own;
    }
    const name = packageOf(path);
    if (name === null || source === undefined || missing.has(path)) {
      return null;
    }
    const text = await source(name, pins[name] ?? null, path.slice(PACKAGE_DIR.length + name.length + 1));
    if (text === null) {
      missing.add(path);
      return null;
    }
    fetched[path] = text;
    return text;
  };
  const virtual: Plugin = {
    name: "principle-files",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === "entry-point") {
          // esbuild rewrites an entry to "./detector.ts" when a file of that name
          // happens to exist in the working directory, so the path is normalized.
          return { path: normalize(args.path), namespace: "principle" };
        }
        if (args.path === TEST_RUNTIME) {
          return { path: "test.ts", namespace: "sdk" };
        }
        if (args.path === HANDLER_RUNTIME) {
          return { path: "handlers.ts", namespace: "sdk" };
        }
        const sdk = SDK_ENTRY.exec(args.path);
        if (sdk) {
          const file = `${sdk[1]}.ts`;
          if (!(file in SDK_SOURCES)) {
            return { errors: [{ text: `"${args.path}" does not exist. The newest detector API is "${SDK_NOW}".` }] };
          }
          if (!sdk[2]) {
            return { path: file, namespace: "sdk" };
          }
          if (!isTest) {
            return { errors: [{ text: `${args.path} is for test files. A detector cannot import it.` }] };
          }
          return { path: "test.ts", namespace: "sdk" };
        }
        if (args.path === SDK || args.path.startsWith(`${SDK}/`)) {
          return { errors: [{ text: `"${args.path}" cannot be imported. The detector API version is part of the path: "${args.path.endsWith("/test") ? `${SDK_NOW}/test` : SDK_NOW}".` }] };
        }
        const builtIn = BUILT_INS[args.path];
        if (builtIn === "fs.ts" && isTest && args.namespace === "principle" && tests.has(args.importer)) {
          return { errors: [{ text: `A test cannot read files itself. Put them in a folder of the principle and pass it to detect(event, { project: "fixtures/name" }).` }] };
        }
        if (builtIn) {
          builtIns.add(builtIn === "fs.ts" ? "node:fs" : "node:path");
          return { path: builtIn, namespace: "sdk" };
        }
        if (args.path === VITEST) {
          if (!isTest) {
            return { errors: [{ text: `${VITEST} is for test files. A detector cannot import it.` }] };
          }
          return { path: "vitest.ts", namespace: "sdk" };
        }
        if (args.namespace === "sdk" && args.path.startsWith("./")) {
          return { path: args.path.slice(2), namespace: "sdk" };
        }
        if (args.namespace === "principle" && isPackageFile(args.importer) && args.path.startsWith(".")) {
          const found = await resolveInPackage(read, args.importer, args.path);
          if (found === null) {
            return { errors: [{ text: `cannot find "${args.path}" in the package ${packageOf(args.importer) ?? ""}` }] };
          }
          return { path: found, namespace: "principle" };
        }
        if (args.namespace === "principle" && args.path.startsWith(".")) {
          const joined = normalize(`${dirname(args.importer)}/${args.path}`);
          const found = [joined, `${joined}.ts`, `${joined}.js`].find((candidate) => candidate in files);
          if (found && !found.startsWith("..")) {
            return { path: found, namespace: "principle" };
          }
          return { errors: [{ text: `cannot find "${args.path}" in the principle's files` }] };
        }
        const fromPackage = packageOf(args.importer);
        if (args.path.startsWith("node:") || NODE_MODULES.has(args.path)) {
          const who = fromPackage === null ? `A ${isTest ? "test" : "detector"}` : `The package ${fromPackage}`;
          return { errors: [{ text: `"${args.path}" cannot be imported. ${who} runs in an isolate without Node. Of Node there is node:fs and node:path, to read files.` }] };
        }
        if (args.namespace === "principle" && (fromPackage !== null || Object.keys(pins).length > 0)) {
          try {
            return { path: await resolvePackage(read, args.path, pins, args.importer, args.kind === "require-call"), namespace: "principle" };
          } catch (error) {
            if (error instanceof PackageError) {
              return { errors: [{ text: error.message }] };
            }
            throw error;
          }
        }
        return {
          errors: [
            {
              text: `"${args.path}" cannot be imported. A ${isTest ? "test" : "detector"} may import its own relative files, ${SDK_NOW}, node:fs and node:path${isTest ? `, ${SDK_NOW}/test and ${VITEST}` : ""}, and the packages its package.json names.`,
            },
          ],
        };
      });
      build.onLoad({ filter: /.*/, namespace: "sdk" }, (args) => {
        const contents = SDK_SOURCES[args.path];
        return contents === undefined ? { errors: [{ text: `the SDK has no file "${args.path}"` }] } : { contents, loader: "ts" };
      });
      build.onLoad({ filter: /.*/, namespace: "principle" }, async (args) => {
        const contents = await read(args.path);
        if (contents === null) {
          return { errors: [{ text: `"${args.path}" is not one of the principle's files` }] };
        }
        let loader: "ts" | "js" | "json" = "js";
        if (args.path.endsWith(".ts")) {
          loader = "ts";
        } else if (args.path.endsWith(".json")) {
          loader = "json";
        }
        if (tests.has(args.path)) {
          // Tells the framework which file the following tests belong to. It shares the
          // first line with the file's own code, so line numbers in errors stay right.
          return { contents: `import { __file as __wellactuallyFile } from "${TEST_RUNTIME}";__wellactuallyFile(${JSON.stringify(args.path)});${contents}`, loader };
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
      // Packages ask which build they are in. There is no process to ask in the isolate.
      define: { "process.env.NODE_ENV": '"production"' },
      // Says which files ended up in the bundle. A package that is installed and never imported is not in it.
      metafile: true,
      plugins: [virtual],
    });
    code = result.outputFiles?.[0]?.text ?? "";
    for (const output of Object.values(result.metafile?.outputs ?? {})) {
      for (const [input, used] of Object.entries(output.inputs)) {
        const name = packageOf(input.replace(/^principle:/, ""));
        if (name !== null && used.bytesInOutput > 0) {
          inlined.add(name);
        }
      }
    }
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

/** A detector bundle with the notices of its packages at its end. The limit on its size is for all of it. */
export function withNotices(bundle: string, notices: string): string {
  if (notices === "") {
    return bundle;
  }
  const whole = `${bundle}${notices}`;
  if (byteLength(whole) > MAX_BUNDLE_BYTES) {
    throw new BundleError(`the bundled detector with the licences of its packages is larger than ${MAX_BUNDLE_BYTES / 1024} KB`);
  }
  return whole;
}

function formatMessage(message: Message): string {
  const where = message.location ? `${message.location.file.replace(/^(principle|sdk):/, "")}:${message.location.line}: ` : "";
  return `${where}${message.text}`;
}
