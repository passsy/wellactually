// Builds the command as one JavaScript file, the one the installed plugin runs,
// and next to it the small script its worker threads run.
//
// A plugin is copied to the user's machine without `npm install`, so it
// cannot have dependencies. Everything is bundled, including the isolate,
// whose WebAssembly is inlined. esbuild itself stays outside: it is a native
// binary, only the authoring commands need it, and they say so when it is missing.
//
// In the public repository this file is scripts/build.mjs.
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const outfile = path.resolve(process.argv[2] ?? path.join(root, "dist/wellactually.mjs"));

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["esbuild"],
  // Some bundled dependencies are CommonJS and call require().
  banner: { js: 'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);' },
  legalComments: "none",
  logLevel: "warning",
};

await build({ ...shared, entryPoints: [path.join(root, "packages/cli/src/main.ts")], outfile });
// A worker loads its script from scratch, so it gets only the isolate. The hook looks for it beside the command.
const worker = path.join(path.dirname(outfile), "wellactually-worker.mjs");
await build({ ...shared, entryPoints: [path.join(root, "packages/cli/src/worker.ts")], outfile: worker });
console.log(`built ${path.relative(process.cwd(), outfile)} and ${path.basename(worker)}`);
