// Promote an already published release in source manifests and install pointers.
//
//   node scripts/version.mjs 0.9.29
//
// The command, the plugin manifests of each agent and the OpenCode package
// Build/publish first with `npm run package -- --version <version>`, verify the
// registry artifact, then run this and refresh package-lock.json before pushing.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: node scripts/version.mjs <exact-published-version>");
  process.exit(2);
}

const update = (relative, change) => {
  const file = path.join(root, relative);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  change(value);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

update("package.json", (pkg) => {
  pkg.version = version;
  pkg.dependencies["wellactually-runtime"] = `npm:wellactually@${version}`;
});
update("packages/cli/package.json", (cli) => (cli.version = version));
update("package-lock.json", (lock) => (lock.packages["packages/cli"].version = version));
update(".claude-plugin/plugin.json", (plugin) => (plugin.version = version));
update(".claude-plugin/marketplace.json", (marketplace) => {
  marketplace.metadata.version = version;
  for (const plugin of marketplace.plugins) {
    plugin.version = version;
    plugin.source = { source: "npm", package: "wellactually", version };
  }
});
update(".codex-plugin/plugin.json", (plugin) => (plugin.version = version));
update("opencode/package.json", (opencode) => {
  opencode.version = version;
  opencode.dependencies["wellactually-runtime"] = `npm:wellactually@${version}`;
});

console.log(`set the version to ${version}`);
