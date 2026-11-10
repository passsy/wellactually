// Run only from the explicitly dispatched, npm-environment release job.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { verifyPublishedPackage } from "./verify-package.mjs";

const root = path.resolve(import.meta.dirname, "..");
if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REF !== "refs/heads/main") {
  throw new Error("Automated publication requires the main-branch release workflow");
}
const packed = JSON.parse(fs.readFileSync(path.join(root, ".artifacts/pack.json"), "utf8"));
if (packed.name !== "wellactually" || path.basename(packed.filename) !== packed.filename) throw new Error("Unexpected packed artifact");
execFileSync("npm", ["publish", path.join(root, ".artifacts", packed.filename), "--ignore-scripts", "--access", "public", "--provenance", "--tag", packed.version.includes("-") ? "next" : "latest"], { cwd: root, stdio: "inherit" });
await verifyPublishedPackage(packed);
