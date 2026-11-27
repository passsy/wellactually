import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Runs an agent's command with its output shown; false when it failed, timed out or could not start. */
export type Run = (file: string, args: string[]) => boolean;

/** What `wellactually install` did in one agent. */
export type Outcome = { status: "installed" | "updated" | "present" | "failed" } | { status: "pinned"; entry: string; file: string };

/** An agent `wellactually install` sets up, and what the user still does in it afterwards. */
export interface Host {
  name: string;
  bin: string;
  setup: (file: string, exec: Run, env: NodeJS.ProcessEnv) => Outcome;
  then?: string;
}

/** A plugin manager downloads the package; ten minutes covers a slow network, and a hung one does not stop the other agents. */
const STEP_TIMEOUT_MS = 10 * 60 * 1000;

const run: Run = (file, args) => {
  // npm installs the agents' launchers as .cmd files on Windows, which only cmd.exe starts; the path is absolute and the arguments are fixed words.
  const batch = /\.(cmd|bat)$/i.test(file);
  const options: SpawnSyncOptions = { stdio: ["ignore", "inherit", "inherit"], timeout: STEP_TIMEOUT_MS, windowsHide: true };
  const result = batch
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${file}" ${args.join(" ")}"`], { ...options, windowsVerbatimArguments: true })
    : spawnSync(file, args, options);
  if (result.error) console.log(`${path.basename(file)} ${args.join(" ")}: ${result.error.message}`);
  return result.status === 0;
};

/**
 * The agent's launcher on the PATH, or undefined. It never looks in the
 * current folder, as Windows' own lookup would, and runs nothing.
 */
export function which(bin: string, env = process.env, platform = process.platform): string | undefined {
  const extensions = platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":")) {
    if (!path.isAbsolute(dir)) continue;
    for (const extension of extensions) {
      const file = path.join(dir, bin + extension);
      try {
        if (fs.statSync(file).isFile() && (platform === "win32" || (fs.statSync(file).mode & 0o111) !== 0)) return file;
      } catch {}
    }
  }
  return undefined;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** The plugin entry of a list such as OpenCode's `plugin` or pi's `packages`, where an entry is a string, a [name, options] pair or { source }. */
function entryOf(list: unknown, name: RegExp): string | undefined {
  if (!Array.isArray(list)) return undefined;
  for (const item of list) {
    const value = typeof item === "string" ? item : Array.isArray(item) ? item[0] : (item as { source?: unknown } | null)?.source;
    if (typeof value === "string" && name.test(value)) return value;
  }
  return undefined;
}

const step = (ok: boolean, done: "installed" | "updated"): Outcome => ({ status: ok ? done : "failed" });

export const HOSTS: Host[] = [
  {
    name: "Claude Code",
    bin: "claude",
    setup(file, exec, env) {
      // Both succeed when the marketplace is there already; a failure means GitHub could not be reached, and the plugin would come from a stale catalog.
      if (!exec(file, ["plugin", "marketplace", "add", "passsy/wellactually"]) || !exec(file, ["plugin", "marketplace", "update", "wellactually"])) return { status: "failed" };
      // `plugin install` succeeds on an installed plugin without updating it, so an installed one is updated instead.
      const installed = readJson(path.join(env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "plugins", "installed_plugins.json")) as { plugins?: Record<string, { scope?: string }[]> } | undefined;
      const exists = installed?.plugins?.["wellactually@wellactually"]?.some((entry) => entry.scope === "user") ?? false;
      return exists
        ? step(exec(file, ["plugin", "update", "wellactually@wellactually", "--scope", "user"]), "updated")
        : step(exec(file, ["plugin", "install", "wellactually@wellactually", "--scope", "user"]), "installed");
    },
  },
  {
    name: "Codex",
    bin: "codex",
    setup(file, exec) {
      if (!exec(file, ["plugin", "marketplace", "add", "passsy/wellactually"]) || !exec(file, ["plugin", "marketplace", "upgrade", "wellactually"])) return { status: "failed" };
      return step(exec(file, ["plugin", "add", "wellactually@wellactually"]), "installed");
    },
    // Codex runs no hook of a new plugin until the user trusts it, and offers no command to do that for them.
    then: "open Codex, type /hooks and press t to trust the new hooks",
  },
  {
    name: "OpenCode",
    bin: "opencode",
    setup(file, exec, env) {
      const config = path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode", "opencode.json");
      // OpenCode 2 lists them under `plugins`, OpenCode 1 under `plugin`.
      const json = readJson(config) as { plugins?: unknown; plugin?: unknown } | undefined;
      const entry = entryOf(json?.plugins, /^wellactually(@|$)/) ?? entryOf(json?.plugin, /^wellactually(@|$)/);
      if (entry?.includes("@")) return { status: "pinned", entry, file: config };
      // shortcut: OpenCode 2.3's `plugin update` does not find plugins that `plugin add` configured, so an installed one is left as it is; its runtime updates itself through the shim. Update it here once OpenCode's update works.
      return entry ? { status: "present" } : step(exec(file, ["plugin", "add", "wellactually"]), "installed");
    },
  },
  {
    name: "pi",
    bin: "pi",
    setup(file, exec, env) {
      const settings = path.join(env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "settings.json");
      const entry = entryOf((readJson(settings) as { packages?: unknown } | undefined)?.packages, /^npm:wellactually(@|$)/);
      if (entry?.includes("@")) return { status: "pinned", entry, file: settings };
      return entry ? step(exec(file, ["update", "--extension", entry]), "updated") : step(exec(file, ["install", "npm:wellactually"]), "installed");
    },
  },
];

/**
 * `wellactually install`: adds the plugin to every agent on this machine
 * through the agent's own plugin manager, or updates it where it is already
 * installed. A version the user pinned stays as it is.
 */
export function install(hosts = HOSTS, exec: Run = run, find = which, env = process.env): { host: Host; outcome: Outcome | { status: "missing" } }[] {
  return hosts.map((host) => {
    const file = find(host.bin);
    if (!file) return { host, outcome: { status: "missing" } };
    console.log(`\n${host.name}:`);
    return { host, outcome: host.setup(file, exec, env) };
  });
}
