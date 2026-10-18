/**
 * The core for Node: the CLI, tests and local development.
 *
 * Importing this sets the engines, esbuild's native binary and QuickJS as
 * WebAssembly, and adds reading a principle directory from disk.
 */
import { createRequire } from "node:module";
import path from "node:path";
import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";
import { setEngines } from "./build/engines.ts";
import { readFrom } from "./build/fs.ts";

let sandbox: Promise<QuickJSWASMModule> | null = null;

setEngines({
  // Loaded on first use. The hook only runs detectors and never builds one,
  // and the plugin's single-file bundle cannot carry esbuild's native binary.
  build: async (options) => (await loadEsbuild()).build(options),
  // The build with the WebAssembly inlined, so the isolate also loads from a single bundled file.
  quickjs: () => (sandbox ??= newQuickJSWASMModuleFromVariant(variant)),
});

/** esbuild from this installation, or else from the repository of the principle being built. */
async function loadEsbuild(): Promise<typeof import("esbuild")> {
  try {
    return await import("esbuild");
  } catch {
    for (const dir of [...readFrom].reverse()) {
      try {
        return createRequire(path.join(dir, "package.json"))("esbuild") as typeof import("esbuild");
      } catch {
        // Not installed there either.
      }
    }
    throw new Error(
      "Building a principle needs esbuild, which the installed plugin does not carry. Install the SDK in the principle's repository, which brings it: `npm install --save-dev github:passsy/wellactually#sdk vitest`.",
    );
  }
}

export * from "./index.ts";
export * from "./build/fs.ts";
