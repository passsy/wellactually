import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Codex runs a plugin's hooks only after the user trusted them in /hooks, and
 * says nothing while it skips them. It ties that trust to a fingerprint of the
 * whole installed plugin folder, so every update sends the hooks back for review.
 * Without them no principle reaches the agent, and only this MCP server, which
 * Codex starts without a review, can tell.
 */
export type CodexHookTrust =
  | { state: "trusted" }
  /** The hooks Codex skips: never trusted, or trusted for another version of the plugin. */
  | { state: "needs-review"; events: string[] };

/** What the agent is asked to tell the user, short enough for the one line Codex shows of a server's instructions. */
export const HOOKS_NEED_REVIEW =
  "Well Actually's hooks are not running: Codex skips them until they are trusted again after an install or update, so no principle reaches you. Tell the user to open /hooks in Codex (in the Codex app: Settings > Hooks) and trust the Well Actually hooks.";

function codexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/**
 * The trust Codex records for the hooks of the plugin installed at `root`, or
 * null when `root` is no Codex plugin install or its trust can't be judged.
 */
export function codexHookTrust(root: string, env: NodeJS.ProcessEnv = process.env): CodexHookTrust | null {
  const home = codexHome(env);
  // Codex installs a plugin at plugins/cache/<marketplace>/<plugin>/<version>.
  const parts = path.relative(path.join(home, "plugins", "cache"), root).split(path.sep);
  if (parts.length !== 3 || parts[0] === "..") {
    return null;
  }
  const [marketplace, plugin] = parts;
  let hooks: Record<string, { hooks?: unknown[] }[]>;
  let config: string;
  try {
    hooks = (JSON.parse(fs.readFileSync(path.join(root, "hooks", "hooks.json"), "utf8")) as { hooks: typeof hooks }).hooks;
    config = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  } catch {
    return null;
  }
  const tables = hookStates(config);
  let content: string;
  try {
    content = pluginContentHash(root);
  } catch {
    return null;
  }
  const events = new Set<string>();
  for (const [event, groups] of Object.entries(hooks)) {
    const name = event.replace(/(?<!^)[A-Z]/g, c => "_" + c).toLowerCase();
    groups.forEach((group, g) => (group.hooks ?? []).forEach((_, h) => {
      const table = tables.get(`${plugin}@${marketplace}:hooks/hooks.json:${name}:${g}:${h}`);
      if (table?.enabled === false) {
        return; // switched off by the user on purpose
      }
      if (!table?.trustedHash) {
        events.add(event);
        return;
      }
      // Older Codex releases recorded no content hash, and then trust the definition alone.
      if (table.contentHash && table.contentHash !== content) {
        events.add(event);
      }
    }));
  }
  return events.size ? { state: "needs-review", events: [...events] } : { state: "trusted" };
}

interface HookState {
  trustedHash?: string;
  contentHash?: string;
  enabled?: boolean;
}

/** The `[hooks.state."<key>"]` tables of a Codex config.toml. A later table of the same key wins. */
export function hookStates(config: string): Map<string, HookState> {
  const states = new Map<string, HookState>();
  let current: HookState | undefined;
  for (const line of config.split(/\r?\n/)) {
    const header = /^\s*\[\s*hooks\.state\."([^"]+)"\s*\]\s*$/.exec(line);
    if (header) {
      current = {};
      states.set(header[1]!, current);
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = undefined;
      continue;
    }
    const field = current && /^\s*(trusted_hash|trusted_content_hash|enabled)\s*=\s*(?:"([^"]*)"|(true|false))/.exec(line);
    if (current && field) {
      if (field[1] === "enabled") current.enabled = field[3] === "true";
      else if (field[1] === "trusted_hash") current.trustedHash = field[2];
      else current.contentHash = field[2];
    }
  }
  return states;
}

/**
 * Codex's fingerprint of an installed plugin folder, ported from
 * codex-rs/hooks/src/engine/plugin_fingerprint.rs: every entry depth first in
 * byte order of its name, its relative path, its kind and a file's length and bytes.
 */
export function pluginContentHash(root: string): string {
  const hash = crypto.createHash("sha256").update("codex-plugin-bundle-v1");
  const u64 = (n: number) => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt(n));
    return bytes;
  };
  const pending = [""];
  while (pending.length) {
    const relative = pending.pop()!;
    const base = path.basename(relative);
    if (relative && (base === "__pycache__" || base === ".venv" || base.endsWith(".pyc") || base.endsWith(".egg-info"))) {
      continue;
    }
    const name = Buffer.from(relative);
    hash.update(u64(name.length)).update(name);
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) {
      hash.update("directory");
      const names = fs.readdirSync(absolute).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      for (const entry of names.reverse()) {
        pending.push(relative ? `${relative}/${entry}` : entry);
      }
    } else if (stat.isFile()) {
      const bytes = fs.readFileSync(absolute);
      hash.update("file").update(u64(bytes.length)).update(bytes);
    } else {
      // Codex refuses such a folder too, and then lists none of its hooks.
      throw new Error(`unsupported plugin entry type: ${absolute}`);
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

let memo: { key: string; trust: CodexHookTrust | null } | undefined;

/** codexHookTrust, judged again only when Codex rewrites its config, as it does when the user trusts a hook. */
export function cachedCodexHookTrust(root: string, env: NodeJS.ProcessEnv = process.env): CodexHookTrust | null {
  let key = `${root}\0`;
  try {
    key += fs.statSync(path.join(codexHome(env), "config.toml")).mtimeMs;
  } catch {
    // no config yet: nothing trusted
  }
  if (memo?.key !== key) {
    memo = { key, trust: codexHookTrust(root, env) };
  }
  return memo.trust;
}
