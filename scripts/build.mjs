// Local build outputs are ignored; users install the prebuilt npm package.
import fs from "node:fs";
import path from "node:path";
import { buildRuntime } from "./build-runtime.mjs";

await import("../packages/findings/web/build.mjs");
const root = path.resolve(import.meta.dirname, "..");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "packages/cli/package.json"), "utf8"));
await buildRuntime(root, root, version);
fs.writeFileSync(path.join(root, "skills/review/scripts/review.mjs"), 'import "../../../dist/review.mjs";\n');
console.log("Built development runtime and skill launcher; generated outputs are not committed.");
