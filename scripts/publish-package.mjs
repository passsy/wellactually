// Run only from the explicitly dispatched main-branch publish job. Its OIDC
// credentials are isolated from the build/tests, and it installs no dependencies.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { verifyPublishedPackage } from "./verify-package.mjs";
import { stagedReceipt } from "./stage-package.mjs";

const root = path.resolve(import.meta.dirname, "..");
if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REF !== "refs/heads/main") {
  throw new Error("Automated publication requires the main-branch release workflow");
}
const packed = JSON.parse(fs.readFileSync(path.join(root, ".artifacts/pack.json"), "utf8"));
if (packed.name !== "wellactually" || path.basename(packed.filename) !== packed.filename) throw new Error("Unexpected packed artifact");
if (packed.version !== process.env.RELEASE_VERSION) throw new Error("Artifact version differs from the requested release");
const tarball = path.join(root, ".artifacts", packed.filename);
const integrity = `sha512-${createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}`;
if (integrity !== packed.integrity) throw new Error("Downloaded build artifact differs from the tested archive");
const existing = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packed.name)}/${encodeURIComponent(packed.version)}`, { signal: AbortSignal.timeout(15000) });
if (existing.status === 404) {
  const output = execFileSync("npm", ["stage", "publish", tarball, "--json", "--ignore-scripts", "--access", "public", "--provenance", "--tag", packed.version.includes("-") ? "next" : "latest"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const receipt = stagedReceipt(output, packed);
  fs.writeFileSync(path.join(root, ".artifacts/stage.json"), JSON.stringify(receipt, null, 2) + "\n");
  const summary = `Staged ${packed.name}@${packed.version}: ${receipt.stageId}. Not published. Review the staged archive and approve with npm stage approve ${receipt.stageId} using 2FA, then verify public registry integrity before promoting installer pointers.\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  process.exit(0);
} else if (!existing.ok) {
  throw new Error(`Could not check whether this version is already public: ${existing.status}`);
}
// An already public version must match the tested archive. Stage approval is
// separate; an unapproved stage never reaches this published-release verifier.
await verifyPublishedPackage(packed);
