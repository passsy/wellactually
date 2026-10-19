// Sets the version of a release in every file that carries it.
//
//   node scripts/version.mjs 0.9.29
//
// The command, the plugin manifests of each agent and the OpenCode package
// all say which release they are, and they have to agree. `npm run build`
// afterwards puts the new version into dist.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: node scripts/version.mjs <major.minor.patch>");
  process.exit(2);
}

const update = (relative, change) => {
  const file = path.join(root, relative);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  change(value);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

update("packages/cli/package.json", (cli) => (cli.version = version));
update("package-lock.json", (lock) => (lock.packages["packages/cli"].version = version));
update(".claude-plugin/plugin.json", (plugin) => (plugin.version = version));
update(".claude-plugin/marketplace.json", (marketplace) => {
  marketplace.metadata.version = version;
  for (const plugin of marketplace.plugins) {
    plugin.version = version;
  }
});
update(".codex-plugin/plugin.json", (plugin) => (plugin.version = version));
update("opencode/package.json", (opencode) => (opencode.version = version));

console.log(`set the version to ${version}`);
