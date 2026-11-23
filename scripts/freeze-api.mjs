// Freezes the current detector API version: the shape of its event and the
// globals and host functions it gets, which later hosts have to keep.
//
// Run it once, right after raising API_VERSION and writing
// packages/core/test/api/v<n>/detector.ts. It refuses to overwrite: a shape
// that is written again proves nothing about the hosts that come later. The
// detector itself is built from source by the tests, nothing compiled is kept.
import fs from "node:fs";
import path from "node:path";
import { API_VERSION, fileCtx, textCtx, toolCtx } from "../packages/detector-sdk/src/index.ts";
import { environmentFor, shapeOf } from "../packages/core/src/node.ts";

const dir = path.resolve(import.meta.dirname, `../packages/core/test/api/v${API_VERSION}`);
const source = path.join(dir, "detector.ts");
const shape = path.join(dir, "shape.json");
if (!fs.existsSync(source)) {
  throw new Error(`write ${source} first: a detector that reports a finding for everything API ${API_VERSION} promises`);
}
if (fs.existsSync(shape)) {
  throw new Error(`API ${API_VERSION} is frozen already. A change to the API is a new version: raise API_VERSION in packages/detector-sdk/src/index.ts.`);
}

// A write that removed a line, so the shape says what a removed line is.
const file = fileCtx("write", "lib/a.dart", "a", { removed: [{ line: 1, text: "b" }] });
const environment = environmentFor(API_VERSION, file, null);
fs.writeFileSync(
  shape,
  `${JSON.stringify(
    {
      file: shapeOf(file),
      delete: shapeOf(fileCtx("delete", "lib/a.dart", "a")),
      text: shapeOf(textCtx("prompt", "a")),
      output: shapeOf(textCtx("output", "a", undefined, "b")),
      tool: shapeOf(toolCtx("t3-code", "pull_request_create", { title: "a" })),
      globals: Object.keys(environment.strings).sort(),
      functions: Object.keys(environment.functions).sort(),
    },
    null,
    2,
  )}\n`,
);
console.log(`froze detector API ${API_VERSION} in ${path.relative(process.cwd(), dir)}`);
