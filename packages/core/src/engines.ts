import type { BuildOptions, BuildResult } from "esbuild";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";

/**
 * The two engines a check needs: a bundler and an isolate.
 *
 * Both exist as a native build for Node and as WebAssembly for a Worker, and
 * a Worker may only load WebAssembly it imported statically. So this package
 * names what it needs and whoever starts the process supplies it:
 * `@wellactually/core/node` for the CLI and local development, the checker
 * Worker for production.
 */
export interface Engines {
  /** esbuild's `build`, from `esbuild` or from an initialized `esbuild-wasm`. */
  build: (options: BuildOptions & { write: false }) => Promise<BuildResult<BuildOptions & { write: false }>>;
  /** The QuickJS module. Called once; the result is kept for the life of the process. */
  quickjs: () => Promise<QuickJSWASMModule>;
}

let engines: Engines | null = null;
let quickjs: Promise<QuickJSWASMModule> | null = null;

export function setEngines(next: Engines): void {
  engines = next;
  quickjs = null;
}

export function currentEngines(): Engines {
  if (!engines) {
    throw new Error('No engines are set. Import "@wellactually/core/node", or call setEngines() before building or running a detector.');
  }
  return engines;
}

/** The isolate's WebAssembly module, loaded on first use. */
export function loadSandbox(): Promise<QuickJSWASMModule> {
  quickjs ??= currentEngines().quickjs();
  return quickjs;
}
