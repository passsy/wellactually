import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import template from "../../../hooks/hooks.json" with { type: "json" };
import { desiredGroups, ensureCodexHooks, hookCommand, installedByCodex, LAUNCHER, launcherPath, reconcile, removeCodexHooks } from "../src/codex-user-hooks.ts";

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

test("changes an entry of ours where it stands and drops one the plugin no longer has", () => {
  const command = hookCommand(launcherPath(home));
  const stale = { matcher: "Old", hooks: [{ type: "command", command, timeout: 1 }] };
  const other = { hooks: [{ type: "command", command: "other", timeout: 3 }] };
  fs.mkdirSync(path.dirname(hooksFile()), { recursive: true });
  fs.writeFileSync(hooksFile(), JSON.stringify({ hooks: { PreToolUse: [stale, other], Removed: [stale] } }));
  ensureCodexHooks(env, home);
  const hooks = readHooks().hooks;
  expect(hooks.Removed).toBeUndefined();
  expect(hooks.PreToolUse).toEqual([...desiredGroups(command).PreToolUse!, other]);
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

test("a shared group stays as it is, ours change in place, and nothing after them moves", () => {
  const command = hookCommand(launcherPath(home));
  const other = { hooks: [{ type: "command", command: "other", timeout: 3 }] };
  const later = { hooks: [{ type: "command", command: "later", timeout: 3 }] };
  const stale = { matcher: "Bash", hooks: [{ type: "command", command, timeout: 1 }] };
  const sharedGroup = { hooks: [{ type: "command", command, timeout: 1 }, { type: "command", command: "neighbour" }] };
  const want = desiredGroups(command);
  const result = reconcile({ PreToolUse: [other, stale, later], SessionStart: [sharedGroup, later] }, want);
  expect(result.PreToolUse).toEqual([other, want.PreToolUse![0], later]);
  expect(result.SessionStart).toEqual([sharedGroup, later]);
});

test("entries written under another WELLACTUALLY_HOME are replaced in place, not doubled", () => {
  ensureCodexHooks(env, path.join(work, "old-home"));
  ensureCodexHooks(env, home);
  const hooks = readHooks().hooks;
  for (const groups of Object.values(hooks) as { hooks: { command: string }[] }[][]) {
    expect(groups).toHaveLength(1);
    expect(groups[0]!.hooks[0]!.command).toBe(hookCommand(launcherPath(home)));
  }
});

test("a hooks.json that cannot be read, or holds the wrong shape, is left untouched", () => {
  fs.mkdirSync(path.dirname(hooksFile()), { recursive: true });
  fs.writeFileSync(hooksFile(), JSON.stringify({ hooks: { Stop: "not a list" } }));
  expect(() => ensureCodexHooks(env, home)).toThrow(/form Codex reads/);
  if (process.getuid?.() !== 0) {
    fs.writeFileSync(hooksFile(), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "keep" }] }] } }));
    fs.chmodSync(hooksFile(), 0o000);
    expect(() => ensureCodexHooks(env, home)).toThrow();
    fs.chmodSync(hooksFile(), 0o644);
    expect(readHooks().hooks.Stop).toHaveLength(1);
    expect(readHooks().hooks.PreToolUse).toBeUndefined();
  }
});

test("a symlinked hooks.json keeps its link and its mode", () => {
  const real = path.join(work, "dotfiles", "hooks.json");
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, "{}", { mode: 0o600 });
  fs.mkdirSync(path.dirname(hooksFile()), { recursive: true });
  fs.symlinkSync(real, hooksFile());
  ensureCodexHooks(env, home);
  expect(fs.lstatSync(hooksFile()).isSymbolicLink()).toBe(true);
  expect(fs.statSync(real).mode & 0o777).toBe(0o600);
  expect(Object.keys(JSON.parse(fs.readFileSync(real, "utf8")).hooks)).toContain("PreToolUse");
});

test("uninstall takes out only our entries and the launcher", () => {
  fs.mkdirSync(path.dirname(hooksFile()), { recursive: true });
  const other = { hooks: [{ type: "command", command: "other", timeout: 3 }] };
  fs.writeFileSync(hooksFile(), JSON.stringify({ hooks: { PreToolUse: [other] } }));
  ensureCodexHooks(env, home);
  expect(removeCodexHooks(env, home).changed).toBe(true);
  expect(readHooks()).toEqual({ hooks: { PreToolUse: [other] } });
  expect(fs.existsSync(launcherPath(home))).toBe(false);
});

test("the command quotes the path for the shell Codex runs it in", () => {
  expect(hookCommand("/home/a$b/x/codex-hook.mjs", "linux")).toBe("node '/home/a$b/x/codex-hook.mjs'");
  expect(hookCommand("/home/o'neil/codex-hook.mjs", "darwin")).toBe(`node '/home/o'\\''neil/codex-hook.mjs'`);
  expect(hookCommand("C:\\Users\\Ann Lee\\.wellactually\\codex-hook.mjs", "win32")).toBe('node "C:\\Users\\Ann Lee\\.wellactually\\codex-hook.mjs"');
  const dollar = path.join(work, "a$b");
  ensureCodexHooks(env, dollar);
  cache(["1.0.0"]);
  const command = readHooks().hooks.SessionStart[0].hooks[0].command;
  expect(JSON.parse(execFileSync("/bin/sh", ["-lc", command], { env: { ...process.env, ...env }, input: "{}", encoding: "utf8" })).version).toBe("1.0.0");
});

test("the launcher orders versions as Codex does, build metadata included", () => {
  cache(["1.0.0", "1.0.0+1"]);
  expect(JSON.parse(launch()).version).toBe("1.0.0+1");
  cache(["1.0.0+1.2", "1.0.0-rc.10", "1.0.0-rc.9"]);
  expect(JSON.parse(launch()).version).toBe("1.0.0+1.2");
});

test("the launcher does nothing when Codex has plugins off, however config.toml spells it", () => {
  cache(["1.0.0"]);
  const config = path.join(work, "codex", "config.toml");
  for (const off of ["[features]\nplugins = false\n", "features.plugins = false\n", "[plugins.'wellactually@wellactually']\nenabled = false # off\n", 'plugins."wellactually@wellactually".enabled = false\n']) {
    fs.writeFileSync(config, off);
    expect(launch()).toBe("");
  }
  fs.writeFileSync(config, "[features]\nplugins = true\n");
  expect(JSON.parse(launch()).version).toBe("1.0.0");
});

test("the launcher runs only a version that opted in with an empty hooks list", () => {
  const base = cache(["1.0.0"]);
  for (const manifest of ["{ broken", JSON.stringify({ name: "wellactually" }), JSON.stringify({ hooks: "./hooks/hooks.json" })]) {
    fs.writeFileSync(path.join(base, "1.0.0", ".codex-plugin", "plugin.json"), manifest);
    expect(launch()).toBe("");
  }
});
