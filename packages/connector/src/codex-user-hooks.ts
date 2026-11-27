import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import template from "../../../hooks/hooks.json" with { type: "json" };
import { boardHome } from "../../board/src/board.ts";

/**
 * Codex hooks that survive plugin updates.
 *
 * Codex pins a plugin's hooks to a hash of the whole plugin folder, so every
 * release would switch them off until the user trusts them again. A hook in
 * the user's own `~/.codex/hooks.json` is pinned only to its declaration:
 * event, matcher, command and timeout. So the Codex plugin ships no hooks
 * (`.codex-plugin/plugin.json` sets them empty), and these entries run a
 * small launcher in ~/.wellactually, which starts the hook of whichever
 * plugin version Codex has installed. The user trusts them once.
 */

/** The file Codex runs. Its content is ours to change: Codex never hashes it. */
export function launcherPath(home = boardHome()): string {
  return path.join(home, "codex-hook.mjs");
}

/** The command every entry runs. It must never change, or Codex asks for trust again. */
export function hookCommand(launcher = launcherPath()): string {
  return `node "${launcher}"`;
}

function codexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/** Whether `root` is a Well Actually plugin Codex installed, the only kind the launcher runs: a checkout or a test never touches the user's hooks. */
export function installedByCodex(root: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const base = path.join(codexHome(env), "plugins", "cache", "wellactually", "wellactually");
  const real = (file: string) => {
    try {
      return fs.realpathSync(file);
    } catch {
      return path.resolve(file);
    }
  };
  return path.dirname(real(root)) === real(base);
}

/**
 * Finds the plugin as Codex does (codex-rs core-plugin-common, active_plugin_version):
 * a `local` folder wins, otherwise the highest semver, otherwise the last name.
 * It never asks the user anything and fails quietly: a hook must not break the session.
 */
export const LAUNCHER = `#!/usr/bin/env node
// Written by the Well Actually plugin. Codex runs it from ~/.codex/hooks.json, and it runs the hook of the
// Well Actually plugin Codex has installed. The plugin rewrites this file when it changes; Codex never hashes it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const codex = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const base = path.join(codex, "plugins", "cache", "wellactually", "wellactually");

// The user switched the plugin off in Codex: then its hooks are off too.
let config = "";
try {
  config = fs.readFileSync(path.join(codex, "config.toml"), "utf8");
} catch {}
const section = /^\\[plugins\\."wellactually@wellactually"\\][^\\S\\n]*\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))/m.exec(config);
if (section && /^\\s*enabled\\s*=\\s*false\\b/m.test(section[1])) process.exit(0);

const SEMVER = /^(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?(?:\\+([0-9A-Za-z.-]+))?$/;
const parts = text => text.split(".").map(part => (/^\\d+$/.test(part) ? Number(part) : part));
const compareIds = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    if (a[i] === b[i]) continue;
    if (typeof a[i] === "number" && typeof b[i] === "number") return a[i] - b[i];
    if (typeof a[i] === "number") return -1;
    if (typeof b[i] === "number") return 1;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
};
const compare = (left, right) => {
  const a = SEMVER.exec(left);
  const b = SEMVER.exec(right);
  if (!a || !b) return left < right ? -1 : left > right ? 1 : 0;
  for (let i = 1; i <= 3; i++) if (Number(a[i]) !== Number(b[i])) return Number(a[i]) - Number(b[i]);
  if (a[4] !== b[4]) {
    if (a[4] === undefined) return 1;
    if (b[4] === undefined) return -1;
    const order = compareIds(parts(a[4]), parts(b[4]));
    if (order) return order;
  }
  return compareIds(parts(a[5] ?? ""), parts(b[5] ?? ""));
};

let versions = [];
try {
  versions = fs.readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^[A-Za-z0-9._+-]+$/.test(entry.name) && entry.name !== "." && entry.name !== "..").map(entry => entry.name);
} catch {}
// Not installed in Codex, or removed: nothing to run.
if (versions.length === 0) process.exit(0);
const version = versions.includes("local") ? "local" : versions.sort(compare).at(-1);
const root = path.join(base, version);
const entry = path.join(root, "dist", "wellactually-hook.mjs");
if (!fs.existsSync(entry)) process.exit(0);
// A release from before these hooks brings its own to Codex; running both would handle every event twice.
let manifest = {};
try {
  manifest = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin", "plugin.json"), "utf8"));
} catch {}
if (!("hooks" in manifest) && fs.existsSync(path.join(root, "hooks", "hooks.json"))) process.exit(0);

// What Codex gives a plugin's own hooks, so the hook knows it runs in Codex and from which install.
process.env.PLUGIN_ROOT = root;
process.env.CLAUDE_PLUGIN_ROOT = root;
process.argv[1] = entry;
await import(pathToFileURL(entry).href);
`;

interface Handler {
  type?: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
}
interface Group {
  matcher?: string;
  hooks?: Handler[];
  [key: string]: unknown;
}
type HooksFile = { hooks?: Record<string, Group[]>; [key: string]: unknown };

/** The entries Codex should hold: the plugin's own hooks.json, each handler running the launcher instead. */
export function desiredGroups(command = hookCommand()): Record<string, Group[]> {
  const result: Record<string, Group[]> = {};
  for (const [event, groups] of Object.entries((template as HooksFile).hooks ?? {})) {
    result[event] = groups.map((group) => ({ ...group, hooks: (group.hooks ?? []).map((handler) => ({ ...handler, command })) }));
  }
  return result;
}

function writeAtomically(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Writes the launcher and puts our entries into Codex's hooks.json, leaving
 * every other entry where it is. Ours stay in place while they are right,
 * since Codex keys a trust by an entry's position, and are replaced at the
 * end of their event only when the plugin's hooks change. Returns whether
 * hooks.json changed, which means Codex asks the user to trust them.
 */
export function ensureCodexHooks(env: NodeJS.ProcessEnv = process.env, home = boardHome()): { changed: boolean; file: string } {
  const launcher = launcherPath(home);
  let current: string | undefined;
  try {
    current = fs.readFileSync(launcher, "utf8");
  } catch {}
  if (current !== LAUNCHER) writeAtomically(launcher, LAUNCHER);

  const file = path.join(codexHome(env), "hooks.json");
  let text: string | undefined;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {}
  let config: HooksFile = {};
  if (text !== undefined && text.trim() !== "") {
    // A file we cannot read as JSON is the user's to fix; overwriting it would lose their hooks.
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} does not hold a JSON object`);
    config = parsed as HooksFile;
  }
  const command = hookCommand(launcher);
  const ours = (group: Group) => (group.hooks ?? []).some((handler) => handler.command === command);
  const desired = desiredGroups(command);
  const hooks: Record<string, Group[]> = { ...(config.hooks ?? {}) };
  for (const event of new Set([...Object.keys(hooks), ...Object.keys(desired)])) {
    const groups = hooks[event] ?? [];
    const want = desired[event] ?? [];
    const mine = groups.filter(ours);
    if (same(mine, want)) continue;
    const kept = [...groups.filter((group) => !ours(group)), ...want];
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (same(hooks, config.hooks ?? {})) return { changed: false, file };
  writeAtomically(file, `${JSON.stringify({ ...config, hooks }, null, 2)}\n`);
  return { changed: true, file };
}
