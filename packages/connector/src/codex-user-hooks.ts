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
 * event, matcher, command, timeout, and its position in the file. So the
 * Codex plugin ships no hooks (`.codex-plugin/plugin.json` sets them empty),
 * and these entries run a small launcher in ~/.wellactually, which starts the
 * hook of whichever plugin version Codex has installed. The user trusts them once.
 */

const LAUNCHER_NAME = "codex-hook.mjs";

/** The file Codex runs. Its content is ours to change: Codex never hashes it. */
export function launcherPath(home = boardHome()): string {
  return path.join(home, LAUNCHER_NAME);
}

/**
 * The command every entry runs. It must never change, or Codex asks for trust again.
 * Codex runs it with `sh -lc`, or `cmd /C` on Windows: single quotes keep a `$` in
 * the path literal for sh, and cmd only knows double quotes.
 */
export function hookCommand(launcher = launcherPath(), platform = process.platform): string {
  // shortcut: cmd still expands %NAME% inside the quotes, so a Windows home with a percent sign breaks; escape it if anyone has one.
  return platform === "win32" ? `node "${launcher}"` : `node '${launcher.replaceAll("'", "'\\''")}'`;
}

/** An entry we wrote, whatever WELLACTUALLY_HOME was then, so a moved home replaces it rather than adding a second. */
function managed(command: unknown): boolean {
  return typeof command === "string" && /^node (['"]).*[\\/]codex-hook\.mjs\1$/.test(command);
}

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.CODEX_HOME || path.join(os.homedir(), ".codex"));
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
 * a `local` folder wins, otherwise the highest version as Rust's semver crate orders
 * them, with names that are no valid version compared as strings. It runs only a
 * version that opted in, and fails quietly: a hook must not break the session.
 */
export const LAUNCHER = String.raw`#!/usr/bin/env node
// Written by the Well Actually plugin. Codex runs it from ~/.codex/hooks.json, and it runs the hook of the
// Well Actually plugin Codex has installed. The plugin rewrites this file when it changes; Codex never hashes it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const codex = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
const base = path.join(codex, "plugins", "cache", "wellactually", "wellactually");

// Switched off in Codex: the plugins feature, or the plugin itself. Keys are read the way TOML writes them,
// as a table and a key, or dotted, with either kind of quotes.
let config = "";
try {
  config = fs.readFileSync(path.join(codex, "config.toml"), "utf8");
} catch {}
const unquote = key => key.split(".").map(part => part.trim().replace(/^"(.*)"$|^'(.*)'$/, "$1$2")).join(".");
let table = "";
const settings = new Map();
for (const raw of config.split(/\r?\n/)) {
  const line = raw.replace(/\s+#.*$/, "").trim();
  if (!line || line.startsWith("#")) continue;
  if (line.startsWith("[[")) {
    table = "\0";
    continue;
  }
  const header = /^\[\s*([^\[\]]+?)\s*\]$/.exec(line);
  if (header) {
    table = unquote(header[1]);
    continue;
  }
  const pair = /^((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=\s*(.+)$/.exec(line);
  if (pair) settings.set((table ? table + "." : "") + unquote(pair[1]), pair[2].trim());
}
if (settings.get("features.plugins") === "false" || settings.get("plugins.wellactually@wellactually.enabled") === "false") process.exit(0);

// Version order as Rust's semver crate: no leading zeros, pre-releases before the release, build metadata after.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const parse = text => {
  const match = SEMVER.exec(text);
  if (!match) return null;
  const pre = match[4] ? match[4].split(".") : [];
  if (pre.some(id => /^0\d+$/.test(id))) return null;
  return { core: [match[1], match[2], match[3]].map(BigInt), pre, build: match[5] ? match[5].split(".") : [] };
};
const numeric = id => /^\d+$/.test(id);
const compareId = (a, b) => {
  if (numeric(a) && numeric(b)) return a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0;
  if (numeric(a) !== numeric(b)) return numeric(a) ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
};
const compareList = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = compareId(a[i], b[i]);
    if (order) return order;
  }
  return a.length - b.length;
};
const compare = (left, right) => {
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return left < right ? -1 : left > right ? 1 : 0;
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  if (a.pre.length === 0 || b.pre.length === 0) {
    if (a.pre.length !== b.pre.length) return a.pre.length === 0 ? 1 : -1;
  } else {
    const order = compareList(a.pre, b.pre);
    if (order) return order;
  }
  return compareList(a.build, b.build);
};

let versions = [];
try {
  versions = fs.readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^[A-Za-z0-9._+-]+$/.test(entry.name) && !/^\.+$/.test(entry.name)).map(entry => entry.name);
} catch {}
// Not installed in Codex, or removed: nothing to run.
if (versions.length === 0) process.exit(0);
const version = versions.includes("local") ? "local" : versions.sort(compare).at(-1);
const root = path.join(base, version);
const entry = path.join(root, "dist", "wellactually-hook.mjs");
if (!fs.existsSync(entry)) process.exit(0);
// Only a version that opted into this launcher, by giving Codex no hooks of its own: an older release brings
// its own, and running both would handle every event twice.
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin", "plugin.json"), "utf8"));
} catch {
  process.exit(0);
}
if (JSON.stringify(manifest?.hooks) !== '{"hooks":{}}') process.exit(0);

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

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** A group that holds only our launcher. A group shared with another tool's handler is theirs as much as ours, and stays as it is. */
const ours = (group: Group) => (group.hooks ?? []).length > 0 && (group.hooks ?? []).every((handler) => managed(handler.command));
const shared = (group: Group) => !ours(group) && (group.hooks ?? []).some((handler) => managed(handler.command));

/**
 * The hooks with ours made `want`. Ours are changed where they stand, since
 * Codex keys a trust by an entry's position in its event and moving one would
 * cost the trust of every entry after it. New ones go at the end of their event.
 */
export function reconcile(hooks: Record<string, Group[]>, want: Record<string, Group[]>): Record<string, Group[]> {
  const result: Record<string, Group[]> = { ...hooks };
  for (const event of new Set([...Object.keys(hooks), ...Object.keys(want)])) {
    const groups = hooks[event] ?? [];
    const wanted = want[event] ?? [];
    if (groups.some(shared)) continue;
    const mine = groups.flatMap((group, index) => (ours(group) ? [index] : []));
    const next = [...groups];
    for (let k = 0; k < Math.min(mine.length, wanted.length); k++) next[mine[k]!] = wanted[k]!;
    next.push(...wanted.slice(mine.length));
    // shortcut: removing one of ours moves the entries after it, and Codex asks once more for them; it happens only when the plugin drops a hook or on uninstall.
    for (const index of mine.slice(wanted.length).reverse()) next.splice(index, 1);
    if (next.length === 0) delete result[event];
    else result[event] = next;
  }
  return result;
}

function readHooksFile(file: string): { text: string | undefined; config: HooksFile } {
  let text: string | undefined;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    // Only a missing file is an empty one; one we cannot read is the user's to fix, and treating it as empty would lose their hooks.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text === undefined || text.trim() === "") return { text, config: {} };
  const parsed = JSON.parse(text) as HooksFile;
  const hooks = parsed?.hooks;
  const valid =
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    (hooks === undefined ||
      (hooks !== null &&
        typeof hooks === "object" &&
        !Array.isArray(hooks) &&
        Object.values(hooks).every((groups) => Array.isArray(groups) && groups.every((group) => group !== null && typeof group === "object" && Array.isArray(group.hooks)))));
  if (!valid) throw new Error(`${file} does not hold hooks in the form Codex reads, so it is left as it is`);
  return { text, config: parsed };
}

/** Serializes writers of this file among our own processes, such as two Codex sessions starting at once. */
function withLock<T>(file: string, run: () => T): T {
  const lock = `${file}.wellactually.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error(`${lock} is held by another process`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return run();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** Writes `text` where `file` really is, through a symlink, keeping its mode, unless another program changed it since `before`. */
function writeIfUnchanged(file: string, before: string | undefined, text: string): void {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {}
  let mode: number | undefined;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch {}
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, mode === undefined ? {} : { mode });
  let now: string | undefined;
  try {
    now = fs.readFileSync(target, "utf8");
  } catch {}
  if (now !== before) {
    fs.rmSync(temp, { force: true });
    throw new Error(`${file} changed while the Well Actually hooks were added; run again`);
  }
  fs.renameSync(temp, target);
}

function editHooks(env: NodeJS.ProcessEnv, change: (hooks: Record<string, Group[]>) => Record<string, Group[]>): { changed: boolean; file: string } {
  const file = path.join(codexHome(env), "hooks.json");
  return withLock(file, () => {
    const { text, config } = readHooksFile(file);
    const hooks = change(config.hooks ?? {});
    if (same(hooks, config.hooks ?? {})) return { changed: false, file };
    const { hooks: _previous, ...rest } = config;
    const next = Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
    writeIfUnchanged(file, text, `${JSON.stringify(next, null, 2)}\n`);
    return { changed: true, file };
  });
}

/**
 * Writes the launcher and puts our entries into Codex's hooks.json, leaving
 * every other entry where it is. Returns whether hooks.json changed, which
 * means Codex asks the user to trust them.
 */
export function ensureCodexHooks(env: NodeJS.ProcessEnv = process.env, home = boardHome()): { changed: boolean; file: string } {
  const launcher = launcherPath(home);
  let current: string | undefined;
  try {
    current = fs.readFileSync(launcher, "utf8");
  } catch {}
  if (current !== LAUNCHER) {
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    const temp = `${launcher}.${process.pid}.tmp`;
    fs.writeFileSync(temp, LAUNCHER);
    fs.renameSync(temp, launcher);
  }
  const want = desiredGroups(hookCommand(launcher));
  return editHooks(env, (hooks) => reconcile(hooks, want));
}

/** Takes our entries out of Codex's hooks.json and removes the launcher, for `wellactually uninstall`. */
export function removeCodexHooks(env: NodeJS.ProcessEnv = process.env, home = boardHome()): { changed: boolean; file: string } {
  const result = editHooks(env, (hooks) => reconcile(hooks, {}));
  fs.rmSync(launcherPath(home), { force: true });
  return result;
}
