// Exercise the actual SDK tarball in an author project outside this checkout.
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const artifacts = path.join(root, ".artifacts/detector-sdk");
const packed = JSON.parse(fs.readFileSync(path.join(artifacts, "pack.json"), "utf8"));
assert.equal(packed.name, "@wellactually/detector-sdk");
assert.equal(path.basename(packed.filename), packed.filename);
assert.equal(`sha512-${createHash("sha512").update(fs.readFileSync(path.join(artifacts, packed.filename))).digest("base64")}`, packed.integrity);
const project = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-detector-sdk-test-"));
const dev = (name) => `${name}@${JSON.parse(fs.readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8")).version}`;
try {
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync("npm", ["install", "--prefer-offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", path.join(artifacts, packed.filename), dev("typescript"), dev("@types/node"), dev("vitest")], { cwd: project, stdio: "inherit" });
  const installed = JSON.parse(fs.readFileSync(path.join(project, "node_modules/@wellactually/detector-sdk/package.json"), "utf8"));
  assert.equal(installed.version, packed.version);
  assert.equal(installed.private, undefined);
  assert.deepEqual(Object.keys(installed.dependencies), ["esbuild"]);
  fs.cpSync(path.join(root, "packages/sdk/test/example"), path.join(project, "rules"), { recursive: true });
  fs.writeFileSync(path.join(project, "vitest.config.mjs"), 'export default { test: { maxWorkers: 1 } };\n');
  fs.writeFileSync(path.join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", target: "ES2023", noEmit: true, skipLibCheck: false, types: ["node"] }, include: ["rules/**/*.ts", "imports.ts"] }));
  fs.writeFileSync(path.join(project, "imports.ts"), 'import { findUp } from "@wellactually/detector-sdk/v4";\nimport { onWrite } from "@wellactually/detector-sdk/v3";\nimport { detect } from "@wellactually/detector-sdk/v3/test";\nimport { deleted } from "@wellactually/detector-sdk/v4/test";\nvoid [findUp, onWrite, detect, deleted];\n');
  execFileSync(process.execPath, [path.join(project, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], { cwd: project, stdio: "inherit" });
  execFileSync(process.execPath, [path.join(project, "node_modules/vitest/vitest.mjs"), "run"], { cwd: project, stdio: "inherit" });
  console.log(`Verified packed ${packed.name}@${packed.version}: public types and v3/v4 detector tests.`);
} finally {
  fs.rmSync(project, { recursive: true, force: true });
}
