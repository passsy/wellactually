import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

const { bundleNotices } = await import(new URL("../../../scripts/bundle-notices.mjs", import.meta.url).href);
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-notices-"));
  directories.push(root);
  const add = (name: string, files: Record<string, string>) => {
    const directory = path.join(root, "node_modules", name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version: "1.2.3" }));
    for (const [file, text] of Object.entries({ "index.js": "export const value = 1;", ...files })) fs.writeFileSync(path.join(directory, file), text);
    return `node_modules/${name}/index.js`;
  };
  return { root, add };
}
const bundled = (inputs: Record<string, number>) => ({ outputs: { "out.mjs": { inputs: Object.fromEntries(Object.entries(inputs).map(([name, bytes]) => [name, { bytesInOutput: bytes }])) } } });

test("includes full installed licenses and NOTICE once per bundled package, including a newly added dependency", () => {
  const { root, add } = project();
  const first = add("@example/wasm", { LICENSE: "Copyright upstream engine\nFull permission text\n", NOTICE: "Embedded upstream component notice\n" });
  const second = add("new-dependency", { "LICENSE-MIT": "Copyright another author\nAnother complete license\n" });
  const unused = add("unused", {});
  const text = bundleNotices([bundled({ [second]: 10, [first]: 20, [unused]: 0 }), bundled({ [first]: 5, "packages/detector-sdk/src/v4.ts": 20 })], root);
  expect(text).toContain("Copyright upstream engine\nFull permission text");
  expect(text).toContain("Embedded upstream component notice");
  expect(text).toContain("Copyright another author\nAnother complete license");
  expect(text.match(/@example\/wasm@1.2.3/g)).toHaveLength(1);
  expect(text).not.toContain("unused@");
});

test("fails packaging when a newly bundled dependency omits its license instead of silently dropping its notice", () => {
  const { root, add } = project();
  const input = add("missing-license", { README: "MIT" });
  expect(() => bundleNotices([bundled({ [input]: 10 })], root)).toThrow("missing-license@1.2.3 has no license file");
});

test("rejects empty license text", () => {
  const { root, add } = project();
  const input = add("empty-license", { LICENSE: "  \n" });
  expect(() => bundleNotices([bundled({ [input]: 10 })], root)).toThrow("empty LICENSE");
});
