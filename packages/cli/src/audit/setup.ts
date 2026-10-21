import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeHome, codexHome } from "./transcripts.ts";

/** How the plugin is set up in one agent, as far as its own configuration tells. */
export interface AgentSetup {
  agent: "claude-code" | "codex" | "opencode";
  /** Whether the agent is on this machine at all, judged by its configuration folder. */
  present: boolean;
  /** Whether the plugin is installed and enabled. Null when the configuration does not tell. */
  enabled: boolean | null;
  /** The installed release, when the agent records it. */
  version: string | null;
  /** Codex only: the plugin's hook events the user trusted in `/hooks`, and those still waiting for it. */
  trusted?: string[];
  untrusted?: string[];
  /** What the audit found, in a sentence each. */
  notes: string[];
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJson(file: string): any {
  const text = readText(file);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    // JSONC, as OpenCode allows: drop the comments and trailing commas.
    try {
      return JSON.parse(text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
    } catch {
      return null;
    }
  }
}

export function claudeSetup(env: NodeJS.ProcessEnv = process.env): AgentSetup {
  const home = claudeHome(env);
  const setup: AgentSetup = { agent: "claude-code", present: fs.existsSync(home), enabled: null, version: null, notes: [] };
  if (!setup.present) {
    return setup;
  }
  const settings = readJson(path.join(home, "settings.json"));
  const enabled = Object.entries((settings?.enabledPlugins ?? {}) as Record<string, unknown>).filter(([key]) => key.startsWith("wellactually@"));
  if (enabled.length > 0) {
    setup.enabled = enabled.some(([, on]) => on === true);
  } else {
    setup.enabled = false;
  }
  const installed = readJson(path.join(home, "plugins", "installed_plugins.json"));
  const installs = Object.entries((installed?.plugins ?? {}) as Record<string, { version?: string; scope?: string }[]>)
    .filter(([key]) => key.startsWith("wellactually@"))
    .flatMap(([, list]) => (Array.isArray(list) ? list : []));
  const user = installs.find((install) => install.scope === "user") ?? installs[0];
  setup.version = user?.version ?? null;
  if (installs.length === 0) {
    setup.notes.push("The plugin is not installed in Claude Code.");
  } else if (!setup.enabled) {
    setup.notes.push("The plugin is installed but not enabled in Claude Code's user settings. A project's own settings can still enable it there.");
  }
  return setup;
}

/** The hook events the plugin's hooks.json registers, as Codex names them. */
export const CODEX_EVENTS = ["session_start", "user_prompt_submit", "pre_tool_use", "post_tool_use", "post_compact", "session_end"];

/**
 * Codex keeps the plugin's switch and which hooks the user trusted in
 * config.toml. A hook is trusted under a key such as
 * `wellactually@wellactually:hooks/hooks.json:user_prompt_submit:0:0`.
 */
export function codexSetup(env: NodeJS.ProcessEnv = process.env): AgentSetup {
  const home = codexHome(env);
  const setup: AgentSetup = { agent: "codex", present: fs.existsSync(home), enabled: null, version: null, notes: [] };
  if (!setup.present) {
    return setup;
  }
  const config = readText(path.join(home, "config.toml")) ?? "";
  const plugin = /^\[plugins\."(wellactually@[^"]+)"\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(config);
  if (plugin) {
    setup.enabled = !/^\s*enabled\s*=\s*false\s*$/m.test(plugin[2] as string);
  } else {
    setup.enabled = false;
  }
  try {
    const cache = path.join(home, "plugins", "cache");
    for (const marketplace of fs.readdirSync(cache)) {
      const dir = path.join(cache, marketplace, "wellactually");
      if (fs.existsSync(dir)) {
        setup.version = fs.readdirSync(dir).sort(compareVersions).pop() ?? null;
      }
    }
  } catch {
    // No plugin cache yet.
  }
  const trusted = new Set<string>();
  for (const match of config.matchAll(/^\[hooks\.state\."wellactually@[^"]*:hooks\/hooks\.json:([a-z_]+):[^"]*"\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/gm)) {
    if (/trusted_hash\s*=/.test(match[2] as string)) {
      trusted.add(match[1] as string);
    }
  }
  setup.trusted = CODEX_EVENTS.filter((event) => trusted.has(event));
  setup.untrusted = CODEX_EVENTS.filter((event) => !trusted.has(event));
  if (!plugin) {
    setup.notes.push("The plugin is not installed in Codex.");
  } else if (!setup.enabled) {
    setup.notes.push("The plugin is installed but switched off in Codex's config.toml.");
  }
  if (plugin && setup.untrusted.length > 0) {
    setup.notes.push(
      setup.trusted.length === 0
        ? "None of the plugin's hooks is trusted. Codex does not run them until the user trusts them in `/hooks`, and says nothing about it."
        : `These hooks of the plugin are not trusted, so Codex does not run them: ${setup.untrusted.join(", ")}. The user trusts them in \`/hooks\`.`,
    );
  }
  return setup;
}

function compareVersions(a: string, b: string): number {
  const left = a.split(/[.+-]/).map(Number);
  const right = b.split(/[.+-]/).map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/** Whether an opencode.json, the global one or the project's of `cwd`, names the plugin under `plugin` or `plugins`. */
export function opencodeNamesPlugin(env: NodeJS.ProcessEnv, cwd: string): boolean {
  const home = path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode");
  const files = ["opencode.json", "opencode.jsonc"].flatMap((name) => [path.join(home, name), path.join(cwd, name), path.join(cwd, ".opencode", name)]);
  for (const file of files) {
    const json = readJson(file);
    const plugins = [...(Array.isArray(json?.plugin) ? json.plugin : []), ...(Array.isArray(json?.plugins) ? json.plugins : [])];
    if (plugins.some((plugin: unknown) => JSON.stringify(plugin).includes("wellactually"))) {
      return true;
    }
  }
  return false;
}

/** OpenCode names its plugins in opencode.json, globally or in a project, under `plugin` or `plugins`. */
export function opencodeSetup(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): AgentSetup {
  const config = env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  const home = path.join(config, "opencode");
  const data = path.join(env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "opencode");
  const setup: AgentSetup = { agent: "opencode", present: fs.existsSync(home) || fs.existsSync(data), enabled: null, version: null, notes: [] };
  if (!setup.present) {
    return setup;
  }
  const named = opencodeNamesPlugin(env, cwd);
  setup.enabled = named;
  if (!named) {
    setup.notes.push("No opencode.json in ~/.config/opencode or in this folder names the plugin. It is installed with `opencode plugin add 'github:passsy/wellactually#path:opencode'`.");
  }
  return setup;
}
