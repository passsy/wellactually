// Freezes the current detector API version: its event's shape, and a bundle
// built by today's toolchain that later hosts have to keep running.
//
// Run it once, right after raising API_VERSION and writing
// packages/core/test/api/v<n>/detector.ts. It refuses to overwrite: a frozen
// bundle that is built again proves nothing about the hosts that come later.
import fs from "node:fs";
import path from "node:path";
import { API_VERSION, fileCtx, textCtx } from "../packages/sdk/src/index.ts";
import { buildPrinciple, environmentFor, shapeOf } from "../packages/core/src/node.ts";

const dir = path.resolve(import.meta.dirname, `../packages/core/test/api/v${API_VERSION}`);
const source = path.join(dir, "detector.ts");
const frozen = path.join(dir, "principle.json");
const shape = path.join(dir, "shape.json");
if (!fs.existsSync(source)) {
  throw new Error(`write ${source} first: a detector that reports a finding for everything API ${API_VERSION} promises`);
}
if (fs.existsSync(frozen) || fs.existsSync(shape)) {
  throw new Error(`API ${API_VERSION} is frozen already. A change to the API is a new version: raise API_VERSION in packages/sdk/src/index.ts.`);
}

const built = await buildPrinciple({
  "principle.md":
    "# Golden\n\nA frozen detector that later hosts have to keep running.\n\nIt reports one finding for each promise its detector API made about the event. A host that breaks one of them loses that finding, and the test that runs this bundle fails.",
  "detector.ts": fs.readFileSync(source, "utf8"),
});
fs.writeFileSync(frozen, `${JSON.stringify({ manifest: built.manifest, bundle: built.bundle }, null, 2)}\n`);

const file = fileCtx("write", "lib/a.dart", "a");
const environment = environmentFor(API_VERSION, file, null);
fs.writeFileSync(
  shape,
  `${JSON.stringify({ file: shapeOf(file), text: shapeOf(textCtx("prompt", "a")), globals: Object.keys(environment.strings).sort(), functions: Object.keys(environment.functions).sort() }, null, 2)}\n`,
);
console.log(`froze detector API ${API_VERSION} in ${path.relative(process.cwd(), dir)}`);
