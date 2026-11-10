// Build the installable product in an ignored staging directory. Never pack the
// monorepo itself: a plugin host may extract npm packages without running scripts.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { buildRuntime } from "./build-runtime.mjs";
import { syncSkills } from "./sync-skills.mjs";

const root = path.resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: { version: { type: "string" } } });
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const version = values.version ?? readJson("packages/cli/package.json").version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Expected an exact release or prerelease version");
const artifacts = path.join(root, ".artifacts");
const stage = path.join(artifacts, "package");
fs.rmSync(stage, { force: true, recursive: true });
fs.mkdirSync(stage, { recursive: true });
const write = (file, content) => {
  const target = path.join(stage, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};
const json = (file, value) => write(file, `${JSON.stringify(value, null, 2)}\n`);

await import("../packages/findings/web/build.mjs");
await buildRuntime(root, stage, version);

for (const name of fs.readdirSync(path.join(root, "skills"))) {
  const source = path.join(root, "skills", name);
  if (!fs.existsSync(path.join(source, "SKILL.md"))) continue;
  for (const file of fs.readdirSync(source)) {
    if (file.endsWith(".md")) write(`skills/${name}/${file}`, fs.readFileSync(path.join(source, file)));
  }
}
// Review-specific orchestration remains in the skill. Both native skill layouts
// invoke one compiled helper, rather than carrying a copy of its runtime each.
write("skills/review/scripts/review.mjs", 'import "../../../dist/review.mjs";\n');
syncSkills(stage);
write("opencode/skills/wellactually-review/scripts/review.mjs", 'import "../../../../dist/review.mjs";\n');

// npm renders both GitHub theme variants. Keep GitHub's themed source README,
// but publish one illustration without a GitHub-only visibility fragment.
write("README.md", fs.readFileSync(path.join(root, "README.md"), "utf8")
  .replace(/^.*<img[^\n]*#gh-dark-mode-only[^\n]*>\r?\n/gm, "")
  .replaceAll("#gh-light-mode-only", ""));
for (const file of ["LICENSE", "docs/releasing-review.md", "hooks/hooks.json", ".codex-plugin/mcp.json"]) {
  write(file, fs.readFileSync(path.join(root, file)));
}
for (const file of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
  json(file, { ...readJson(file), version });
}
const manifest = {
  name: "wellactually", version, type: "module", license: "Apache-2.0",
  description: "Your Well Actually advisory board, review skills and findings inbox for Claude Code, Codex, OpenCode and pi.",
  repository: { type: "git", url: "git+https://github.com/passsy/wellactually.git" },
  homepage: "https://wellactually.dev", engines: { node: ">=20" },
  keywords: ["pi-package", "opencode-plugin", "codex", "claude-code", "code-review"],
  bin: { wellactually: "./dist/wellactually.mjs" },
  main: "./dist/opencode.mjs",
  exports: { ".": "./dist/opencode.mjs", "./server": "./dist/opencode.mjs", "./tui": "./dist/tui.mjs", "./pi": "./dist/pi.mjs" },
  pi: { extensions: ["./dist/pi.mjs"], skills: ["./opencode/skills"] },
  files: ["dist/", "skills/", "opencode/skills/", "hooks/", ".claude-plugin/", ".codex-plugin/", "assets/", "docs/releasing-review.md", "LICENSE", "README.md"],
  publishConfig: { access: "public" },
};
json("package.json", manifest);
fs.cpSync(path.join(root, "assets"), path.join(stage, "assets"), { recursive: true });
const cli = path.join(stage, "dist/wellactually.mjs");
const command = fs.readFileSync(cli, "utf8");
if (!command.startsWith("#!")) fs.writeFileSync(cli, `#!/usr/bin/env node\n${command}`);
fs.chmodSync(cli, 0o755);

// Candidate catalogs are build outputs, not active installer pointers. Switching
// the Git marketplace is a separate step after registry installation succeeds.
const marketplace = readJson(".claude-plugin/marketplace.json");
marketplace.metadata.version = version;
for (const plugin of marketplace.plugins) {
  plugin.version = version;
  plugin.source = { source: "npm", package: manifest.name, version };
}
fs.writeFileSync(path.join(artifacts, "marketplace.json"), `${JSON.stringify(marketplace, null, 2)}\n`);
// Existing OpenCode/pi users may keep a Git source. After the registry gate,
// these authored adapters let their normal package manager fetch the same npm
// artifact. They do not build or download anything while the agent is running.
const compat = path.join(artifacts, "git-compat");
fs.rmSync(compat, { recursive: true, force: true });
const compatWrite = (file, content) => {
  fs.mkdirSync(path.dirname(path.join(compat, file)), { recursive: true });
  fs.writeFileSync(path.join(compat, file), content);
};
const dependency = { "wellactually-runtime": `npm:wellactually@${version}` };
compatWrite("root/package.json", `${JSON.stringify({ ...readJson("package.json"), dependencies: { ...readJson("package.json").dependencies, ...dependency }, pi: { extensions: ["./compat/pi.mjs"], skills: ["./node_modules/wellactually-runtime/opencode/skills"] } }, null, 2)}\n`);
compatWrite("root/compat/pi.mjs", 'export { default } from "wellactually-runtime/pi";\n');
compatWrite("opencode/package.json", `${JSON.stringify({ ...readJson("opencode/package.json"), version, dependencies: dependency }, null, 2)}\n`);
compatWrite("opencode/index.mjs", 'export { default } from "wellactually-runtime";\n');
compatWrite("opencode/tui.mjs", 'export { default } from "wellactually-runtime/tui";\n');
const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", artifacts], { cwd: stage, encoding: "utf8" }))[0];
fs.writeFileSync(path.join(artifacts, "pack.json"), `${JSON.stringify(packed, null, 2)}\n`);
console.log(`Packed ${packed.filename}: ${packed.size} bytes compressed, ${packed.unpackedSize} bytes unpacked; ${packed.integrity}`);
