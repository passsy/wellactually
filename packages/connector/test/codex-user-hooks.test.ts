import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import template from "../../../hooks/hooks.json" with { type: "json" };
import { desiredGroups, ensureCodexHooks, hookCommand, installedByCodex, LAUNCHER, launcherPath } from "../src/codex-user-hooks.ts";

let work: string;
let env: NodeJS.ProcessEnv;
let home: string;
beforeEach(() => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wa-codex-hooks-")));
  env = { CODEX_HOME: path.join(work, "codex") };
  home = path.join(work, "wellactually");
});
afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

const hooksFile = () => path.join(work, "codex", "hooks.json");
const readHooks = () => JSON.parse(fs.readFileSync(hooksFile(), "utf8"));

test("adds one entry per hook of the plugin, each running the launcher, and writes the launcher", () => {
  expect(ensureCodexHooks(env, home)).toEqual({ changed: true, file: hooksFile() });
  const command = hookCommand(launcherPath(home));
  const hooks = readHooks().hooks;
  expect(Object.keys(hooks).sort()).toEqual(Object.keys(template.hooks).sort());
  expect(hooks.PreToolUse).toEqual([{ matcher: template.hooks.PreToolUse[0]!.matcher, hooks: [{ type: "command", command, timeout: 10 }] }]);
  expect(fs.readFileSync(launcherPath(home), "utf8")).toBe(LAUNCHER);
});

test("leaves other tools' hooks where they are, and changes nothing on a second run", () => {
  fs.mkdirSync(path.dirname(hooksFile()), { recursive: true });
  const other = { hooks: [{ type: "command", command: "other-tool --event PreToolUse", timeout: 3 }] };
  fs.writeFileSync(hooksFile(), JSON.stringify({ hooks: { PreToolUse: [other], Stop: [other] }, extra: true }));
  ensureCodexHooks(env, home);
  const first = fs.readFileSync(hooksFile(), "utf8");
  const parsed = JSON.parse(first);
  expect(parsed.extra).toBe(true);
  expect(parsed.hooks.Stop).toEqual([other]);
  expect(parsed.hooks.PreToolUse[0]).toEqual(other);
  expect(parsed.hooks.PreToolUse).toHaveLength(2);
  expect(ensureCodexHooks(env, home).changed).toBe(false);
  expect(fs.readFileSync(hooksFile(), "utf8")).toBe(first);
});

test("replaces an entry of ours the plugin no longer has, keeping the rest in place", () => {
  const command = hookCommand(launcherPath(home));
  const stale = { matcher: "Old", hooks: [{ type: "command", command, timeout: 1 }] };
  const other = { hooks: [{ type: "command", command: "other", timeout: 3 }] };
  fs.mkdirSync(path.dirname(hooksFile()), { recursive: true });
  fs.writeFileSync(hooksFile(), JSON.stringify({ hooks: { PreToolUse: [stale, other], Removed: [stale] } }));
  ensureCodexHooks(env, home);
  const hooks = readHooks().hooks;
  expect(hooks.Removed).toBeUndefined();
  expect(hooks.PreToolUse).toEqual([other, ...desiredGroups(command).PreToolUse!]);
});

test("refuses to touch a hooks.json it cannot read as an object", () => {
  fs.mkdirSync(path.dirname(hooksFile()), { recursive: true });
  for (const content of ["{ broken", "[]"]) {
    fs.writeFileSync(hooksFile(), content);
    expect(() => ensureCodexHooks(env, home)).toThrow();
    expect(fs.readFileSync(hooksFile(), "utf8")).toBe(content);
  }
});

test("only a plugin inside Codex's cache counts as installed by Codex", () => {
  const base = path.join(work, "codex", "plugins", "cache", "wellactually", "wellactually");
  fs.mkdirSync(path.join(base, "1.0.0"), { recursive: true });
  expect(installedByCodex(path.join(base, "1.0.0"), env)).toBe(true);
  expect(installedByCodex(work, env)).toBe(false);
});

/** A Codex plugin cache with these versions, each with a hook that prints which version ran and what it got. */
function cache(versions: string[]): string {
  const base = path.join(work, "codex", "plugins", "cache", "wellactually", "wellactually");
  for (const version of versions) {
    fs.mkdirSync(path.join(base, version, "dist"), { recursive: true });
    fs.mkdirSync(path.join(base, version, ".codex-plugin"), { recursive: true });
    fs.writeFileSync(path.join(base, version, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "wellactually", hooks: { hooks: {} } }));
    fs.writeFileSync(
      path.join(base, version, "dist", "wellactually-hook.mjs"),
      `let input = ""; for await (const chunk of process.stdin) input += chunk; console.log(JSON.stringify({ version: ${JSON.stringify(version)}, root: process.env.PLUGIN_ROOT, claude: process.env.CLAUDE_PLUGIN_ROOT, argv: process.argv[1], input }));`,
    );
  }
  return base;
}

const launch = (input = "{}") => {
  ensureCodexHooks(env, home);
  return execFileSync(process.execPath, [launcherPath(home)], { env: { ...process.env, ...env }, input, encoding: "utf8" }).trim();
};

test("the launcher runs the hook of the version Codex uses, with the environment Codex gives plugin hooks", () => {
  const base = cache(["0.9.0", "0.10.0", "0.10.0-rc.1", "0.13.2-local.5"]);
  const ran = JSON.parse(launch('{"hook_event_name":"SessionStart"}'));
  const root = path.join(base, "0.13.2-local.5");
  expect(ran).toEqual({ version: "0.13.2-local.5", root, claude: root, argv: path.join(root, "dist", "wellactually-hook.mjs"), input: '{"hook_event_name":"SessionStart"}' });
  cache(["0.13.2"]);
  expect(JSON.parse(launch()).version).toBe("0.13.2");
  cache(["local"]);
  expect(JSON.parse(launch()).version).toBe("local");
});

test("the launcher does nothing when the plugin is not installed or switched off in Codex", () => {
  expect(launch()).toBe("");
  cache(["1.0.0"]);
  fs.writeFileSync(path.join(work, "codex", "config.toml"), '[plugins."other@x"]\nenabled = false\n\n[plugins."wellactually@wellactually"]\nenabled = false\n');
  expect(launch()).toBe("");
  fs.writeFileSync(path.join(work, "codex", "config.toml"), '[plugins."wellactually@wellactually"]\nenabled = true\n\n[plugins."other@x"]\nenabled = false\n');
  expect(JSON.parse(launch()).version).toBe("1.0.0");
});

test("the launcher leaves an older release that brings its own Codex hooks to them, so no event runs twice", () => {
  const base = cache(["0.13.2"]);
  fs.writeFileSync(path.join(base, "0.13.2", ".codex-plugin", "plugin.json"), JSON.stringify({ name: "wellactually" }));
  fs.mkdirSync(path.join(base, "0.13.2", "hooks"));
  fs.writeFileSync(path.join(base, "0.13.2", "hooks", "hooks.json"), "{}");
  expect(launch()).toBe("");
});
