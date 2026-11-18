import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const catalog = ".claude-plugin/marketplace.json";
const duplicate = ".agents/plugins/marketplace.json";
const read = (base: string, file: string) => JSON.parse(fs.readFileSync(path.join(base, file), "utf8"));

test("the shared marketplace pins the published runtime without a Codex override", () => {
  const version = read(root, "packages/connector/package.json").version;
  const plugin = read(root, catalog).plugins.find((entry: { name: string }) => entry.name === "wellactually");
  expect(plugin.source).toEqual({ source: "npm", package: "wellactually", version });
  expect(fs.existsSync(path.join(root, duplicate))).toBe(false);
});

test("release promotion updates the shared catalog without recreating a Codex override", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-promotion-"));
  try {
    const files = [
      catalog, "scripts/version.mjs", "package.json", "package-lock.json",
      "packages/connector/package.json", ".claude-plugin/plugin.json",
      ".codex-plugin/plugin.json", "opencode/package.json",
    ];
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(fixture, file));
    }
    execFileSync(process.execPath, [path.join(fixture, "scripts/version.mjs"), "9.8.7"], { cwd: fixture });
    const promoted = read(fixture, catalog);
    const plugin = promoted.plugins.find((entry: { name: string }) => entry.name === "wellactually");
    expect(plugin.source).toEqual({ source: "npm", package: "wellactually", version: "9.8.7" });
    expect(plugin.version).toBe("9.8.7");
    expect(promoted.metadata.version).toBe("9.8.7");
    expect(fs.existsSync(path.join(fixture, duplicate))).toBe(false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
