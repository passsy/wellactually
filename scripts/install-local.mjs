import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Prepare an immutable local copy of exactly the package a registry release uses. */
export function prepareLocalPackage({ destination, version, build = true } = {}) {
  const base = JSON.parse(fs.readFileSync(path.join(root, "packages/cli/package.json"), "utf8")).version;
  version ??= `${base}${base.includes("-") ? "." : "-"}local.${Date.now()}`;
  destination ??= path.join(os.homedir(), ".wellactually", "local-marketplace");
  if (!/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(version) || !/(?:[.-])local(?:[.-]|$)/.test(version)) throw new Error("Local installs require a unique local prerelease version");
  const artifacts = path.join(root, ".artifacts/local");
  if (build) execFileSync(process.execPath, [path.join(root, "scripts/package.mjs"), "--version", version, "--local", "--out", artifacts], { cwd: root, stdio: "inherit" });
  const packed = JSON.parse(fs.readFileSync(path.join(artifacts, "pack.json"), "utf8"));
  if (packed.version !== version || path.basename(packed.filename) !== packed.filename) throw new Error("Local archive/version mismatch");
  const directory = path.join(destination, "versions", version);
  if (fs.existsSync(directory)) throw new Error("This local version already exists; prepare a new version instead of mutating an installed package");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "wellactually-local-install", private: true }));
  try {
    execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", path.join(artifacts, packed.filename)], { cwd: directory, stdio: "inherit" });
    // Local host copiers commonly exclude node_modules. Move the self-contained
    // package to a plain plugin directory before exposing it through the catalog.
    const installed = path.join(directory, "plugin");
    fs.renameSync(path.join(directory, "node_modules/wellactually"), installed);
    const manifest = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
    if (manifest.private !== true || manifest.version !== version) throw new Error("Local package must be private and match the requested version");
    const catalog = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin/marketplace.json"), "utf8"));
    catalog.metadata.version = version;
    for (const plugin of catalog.plugins) {
      plugin.version = version;
      plugin.source = `./versions/${version}/plugin`;
    }
    const file = path.join(destination, ".claude-plugin/marketplace.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(catalog, null, 2)}\n`);
    fs.renameSync(`${file}.tmp`, file);
    return { version, marketplace: destination, installed };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function installLocalHost(host, marketplace) {
  let installed;
  if (host === "codex") {
    // Codex refuses a changed catalog source until the old registration is removed.
    // Removing a catalog registration does not delete review stores or hook trust.
    const list = JSON.parse(execFileSync("codex", ["plugin", "marketplace", "list", "--json"], { encoding: "utf8" }));
    const current = list.marketplaces.find(item => item.name === "wellactually");
    if (current && current.marketplaceSource?.source !== marketplace) execFileSync("codex", ["plugin", "marketplace", "remove", "wellactually"], { stdio: "inherit" });
    if (!current || current.marketplaceSource?.source !== marketplace) execFileSync("codex", ["plugin", "marketplace", "add", marketplace], { stdio: "inherit" });
    const result = JSON.parse(execFileSync("codex", ["plugin", "add", "wellactually@wellactually", "--json"], { encoding: "utf8" }));
    installed = result.installedPath;
  } else if (host === "claude") {
    execFileSync("claude", ["plugin", "marketplace", "add", marketplace], { stdio: "inherit" });
    const list = JSON.parse(execFileSync("claude", ["plugin", "list", "--json"], { encoding: "utf8" }));
    const exists = list.some(item => item.id === "wellactually@wellactually" && item.scope === "user");
    execFileSync("claude", ["plugin", exists ? "update" : "install", "wellactually@wellactually", "--scope", "user"], { stdio: "inherit" });
    const updated = JSON.parse(execFileSync("claude", ["plugin", "list", "--json"], { encoding: "utf8" }));
    installed = updated.find(item => item.id === "wellactually@wellactually" && item.scope === "user")?.installPath;
  } else throw new Error("Host must be codex or claude");
  const catalog = JSON.parse(fs.readFileSync(path.join(marketplace, ".claude-plugin/marketplace.json"), "utf8"));
  const expected = catalog.plugins.find(plugin => plugin.name === "wellactually");
  if (!installed) throw new Error(`${host} did not report an installed plugin path`);
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
  if (manifest.version !== expected.version || manifest.private !== true) throw new Error(`${host} kept another version instead of installing the local package; uninstall its user-scoped Well Actually plugin and retry`);
  const runtime = fs.readFileSync(path.join(installed, "dist/wellactually.mjs"));
  const source = fs.readFileSync(path.resolve(marketplace, expected.source, "dist/wellactually.mjs"));
  if (!runtime.equals(source)) throw new Error(`${host} installed a different local runtime`);
  console.log(`Verified ${host} local install: ${manifest.version}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { host: { type: "string" }, destination: { type: "string" }, version: { type: "string" } } });
  if (values.host && !["codex", "claude", "all"].includes(values.host)) throw new Error("--host must be codex, claude or all");
  const result = prepareLocalPackage({ destination: values.destination ? path.resolve(values.destination) : undefined, version: values.version });
  console.log(`Local package ready: ${result.installed}`);
  if (values.host) {
    console.log(`Switching wellactually@wellactually to local package ${result.version} in ${values.host}.`);
    for (const host of values.host === "all" ? ["codex", "claude"] : [values.host]) installLocalHost(host, result.marketplace);
    console.log("Installed. Start a fresh host session; review changed hooks if the host requests it.");
  } else {
    console.log(`Prepared only; no host configuration changed. To install, run npm run install:local -- --host codex (or claude).`);
  }
}
