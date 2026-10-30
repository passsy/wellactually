// Builds the command as one JavaScript file, the one the installed plugin runs,
// and next to it the small script its worker threads run. Then copies what
// OpenCode needs into opencode/.
//
// A plugin is copied to the user's machine without `npm install`, so it
// cannot have dependencies. Everything is bundled, including the isolate,
// whose WebAssembly is inlined. esbuild itself stays outside: it is a native
// binary, only the authoring commands need it, and they say so when it is missing.
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { syncSkills } from "./sync-skills.mjs";

const root = path.resolve(import.meta.dirname, "..");
const outfile = path.join(root, "dist/wellactually.mjs");

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
// The hook starts this one after it has answered, to write its log line without loading the whole command.
const logWriter = path.join(path.dirname(outfile), "wellactually-log.mjs");
await build({ ...shared, entryPoints: [path.join(root, "packages/cli/src/log-writer.ts")], outfile: logWriter });
// The plugins of the agents that load a JavaScript module instead of running hooks: OpenCode and pi,
// plus OpenCode 2's CLI plugin, which shows toasts. They start the command beside them,
// so they bundle none of it but the code that talks to it.
const plugins = ["opencode", "opencode-tui", "pi"].map((agent) => path.join(path.dirname(outfile), `${agent}.mjs`));
for (const plugin of plugins) {
  await build({ ...shared, entryPoints: [path.join(root, "packages/cli/src/agents", `${path.basename(plugin, ".mjs")}.ts`)], outfile: plugin, banner: {} });
}

// OpenCode installs a plugin from git like npm does, and npm runs `npm install`
// in a repository with workspaces or a build script before it packs it, which
// OpenCode cannot. So OpenCode gets a package of its own in opencode/, without
// either, installed with the ::path:opencode selector. It carries its own copy
// of the command, because only that folder is installed.
const opencode = path.join(root, "opencode");
fs.mkdirSync(path.join(opencode, "dist"), { recursive: true });
for (const file of ["wellactually.mjs", "wellactually-worker.mjs", "wellactually-log.mjs"]) {
  fs.copyFileSync(path.join(root, "dist", file), path.join(opencode, "dist", file));
}
fs.renameSync(path.join(root, "dist/opencode.mjs"), path.join(opencode, "dist/opencode.mjs"));
fs.renameSync(path.join(root, "dist/opencode-tui.mjs"), path.join(opencode, "dist/tui.mjs"));
await build({ ...shared, entryPoints: [path.join(root, "skills/review/scripts/main.ts")], outfile: path.join(root, "skills/review/scripts/review.mjs") });
await build({ ...shared, entryPoints: [path.join(root, "skills/review/scripts/finalize.ts")], outfile: path.join(root, "skills/review/scripts/finalize.mjs") });
syncSkills(root);

console.log(`built dist: ${[outfile, worker, logWriter, ...plugins].map((file) => path.basename(file)).join(", ")}, and copied the command and the skills into opencode`);
