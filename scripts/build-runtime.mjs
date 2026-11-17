import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

// Both development builds and npm archives use this single runtime layout.
export async function buildRuntime(root, destination, version) {
  const options = {
    bundle: true, platform: "node", format: "esm", target: "node20", external: ["esbuild"],
    banner: { js: 'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);' },
    legalComments: "none", logLevel: "warning",
    plugins: [{ name: "release-version", setup(build) {
      build.onLoad({ filter: /packages\/cli\/package\.json$/ }, () => ({
        contents: JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(root, "packages/connector/package.json"), "utf8")), version }), loader: "json",
      }));
    } }],
  };
  for (const [name, source] of Object.entries({
    wellactually: "packages/connector/src/main.ts", "wellactually-hook": "packages/connector/src/hook-entry.ts",
    "wellactually-worker": "packages/connector/src/worker.ts", "wellactually-log": "packages/connector/src/log-writer.ts",
    opencode: "packages/connector/src/agents/opencode.ts", tui: "packages/connector/src/agents/opencode-tui.ts",
    pi: "packages/connector/src/agents/pi.ts", review: "skills/review/scripts/main.ts",
  })) {
    await build({ ...options, entryPoints: [path.join(root, source)], outfile: path.join(destination, "dist", `${name}.mjs`) });
  }
  fs.rmSync(path.join(destination, "dist/web"), { recursive: true, force: true });
  fs.cpSync(path.join(root, "packages/findings/web/dist"), path.join(destination, "dist/web"), { recursive: true });
}
