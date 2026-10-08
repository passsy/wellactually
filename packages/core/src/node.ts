/**
 * The core for Node: the CLI, the hook, tests and local development.
 *
 * Importing this sets the engines, esbuild's native binary and QuickJS as
 * WebAssembly, and adds what needs a disk: reading a principle
 * directory, the local advisory board and the repository probe.
 */
import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";
import { setEngines } from "./engines.ts";

let sandbox: Promise<QuickJSWASMModule> | null = null;

setEngines({
  // Loaded on first use. The hook only runs detectors and never builds one,
  // and the plugin's single-file bundle cannot carry esbuild's native binary.
  build: async (options) => {
    let esbuild: typeof import("esbuild");
    try {
      esbuild = await import("esbuild");
    } catch {
      throw new Error(
        "Building a principle needs esbuild, which the installed plugin does not carry. Use the command from a checkout of https://github.com/passsy/wellactually: `npm install && npm link -w wellactually`.",
      );
    }
    return esbuild.build(options);
  },
  // The build with the WebAssembly inlined, so the isolate also loads from a single bundled file.
  quickjs: () => (sandbox ??= newQuickJSWASMModuleFromVariant(variant)),
});

export * from "./index.ts";
export * from "./board.ts";
export * from "./detections.ts";
export * from "./fs.ts";
export * from "./payload.ts";
export * from "./switches.ts";
export * from "./probe.ts";
