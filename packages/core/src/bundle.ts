import type { BuildFailure, Message, Plugin } from "esbuild";
import { currentEngines } from "./engines.ts";
import { SDK_SOURCE } from "./sdk-source.generated.ts";

/** A principle's files, keyed by forward-slash path relative to its directory. */
export type FileMap = Record<string, string>;

export class BundleError extends Error {}

/** The name the bundled detector module is bound to inside the isolate. */
export const BUNDLE_GLOBAL = "__principle";

const MAX_BUNDLE_BYTES = 256 * 1024;
const SDK = "@wellactually/sdk";
const DETECTOR_ENTRIES = ["detector.ts", "detector.js", "detector.mjs"];

/** The detector file of a principle, or null when it has none. */
export function detectorEntry(files: FileMap): string | null {
  return DETECTOR_ENTRIES.find((name) => name in files) ?? null;
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
 * the SDK from a string compiled into this package. That is what lets the
 * same build run in the CLI, in local development and inside a Worker. A
 * detector may import its own relative files and the SDK. Everything else is
 * refused here, at build time, because nothing else exists inside the isolate.
 */
export async function buildBundle(files: FileMap): Promise<string> {
  const entry = detectorEntry(files);
  if (!entry) {
    throw new BundleError(`no detector found; expected one of ${DETECTOR_ENTRIES.join(", ")}`);
  }

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
              text: `"${args.path}" cannot be imported. A detector may import its own relative files and ${SDK}, nothing else.`,
            },
          ],
        };
      });
      build.onLoad({ filter: /.*/, namespace: "sdk" }, () => ({ contents: SDK_SOURCE, loader: "ts" }));
      build.onLoad({ filter: /.*/, namespace: "principle" }, (args) => {
        const contents = files[args.path];
        if (contents === undefined) {
          return { errors: [{ text: `"${args.path}" is not one of the principle's files` }] };
        }
        return { contents, loader: args.path.endsWith(".ts") ? "ts" : "js" };
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
      globalName: BUNDLE_GLOBAL,
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
    throw new BundleError(`the bundled detector is larger than ${MAX_BUNDLE_BYTES / 1024} KB`);
  }
  return code;
}

function formatMessage(message: Message): string {
  const where = message.location ? `${message.location.file.replace(/^(principle|sdk):/, "")}:${message.location.line}: ` : "";
  return `${where}${message.text}`;
}
