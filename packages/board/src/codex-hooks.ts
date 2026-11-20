import fs from "node:fs";
import path from "node:path";
import { boardHome } from "./board.ts";

/**
 * Codex runs a plugin's hooks only after the user trusted them in /hooks, says
 * nothing while it skips them, and asks again after every update. Without the
 * hooks no principle reaches the agent.
 *
 * Rather than copy how Codex decides, which it changes at will, this keeps its
 * own evidence: the Codex installs whose MCP server started, and whether any
 * hook ever ran from them. An install that served but never ran a hook has its
 * hooks switched off, for trust or any other reason.
 * shortcut: hooks distrusted again after they once ran go unnoticed; judge recency of runs if that ever matters.
 */
interface Install {
  /** When the MCP server last started from this install. */
  served?: string;
  /** When a hook first ran from it. */
  hooked?: string;
}

/** What the agent is asked to tell the user, short enough for the one line Codex shows of a server's instructions. */
export const HOOKS_NEED_REVIEW =
  "Well Actually's hooks have not run since the plugin was installed or updated, so no principle reaches you. Codex skips them until they are trusted: tell the user to open /hooks in Codex (in the Codex app: Settings > Hooks) and trust the Well Actually hooks.";

function file(): string {
  return path.join(boardHome(), "codex-hooks.json");
}

function read(): Record<string, Install> {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8")) as Record<string, Install>;
  } catch {
    return {};
  }
}

function update(root: string, change: (install: Install) => Install | null): void {
  const installs = read();
  const key = canonical(root);
  const next = change(installs[key] ?? {});
  if (!next) {
    return;
  }
  installs[key] = next;
  // Updates leave old installs behind; a removed one has nothing more to say.
  for (const other of Object.keys(installs)) {
    if (!fs.existsSync(other)) delete installs[other];
  }
  try {
    fs.mkdirSync(boardHome(), { recursive: true });
    const temp = `${file()}.${process.pid}`;
    fs.writeFileSync(temp, `${JSON.stringify(installs, null, 2)}\n`);
    fs.renameSync(temp, file());
  } catch {
    // Evidence is a courtesy; a read-only home must not break a hook or the server.
  }
}

function canonical(root: string): string {
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

/** The MCP server of the Codex install at `root` started. */
export function noteCodexServer(root: string, now = new Date()): void {
  update(root, install => ({ ...install, served: now.toISOString() }));
}

/** A hook ran from the Codex install at `root`. Written once per install, so hooks stay cheap. */
export function noteCodexHook(root: string, now = new Date()): void {
  if (read()[canonical(root)]?.hooked) {
    return;
  }
  update(root, install => (install.hooked ? null : { ...install, hooked: now.toISOString() }));
}

/**
 * Whether the hooks of a Codex install have never run: of the install at
 * `root`, or else of the one whose server started last, which is what the
 * Review Inbox asks, served by whichever session holds its port.
 */
export function codexHooksSilent(root?: string): boolean {
  const installs = read();
  if (root) {
    const install = installs[canonical(root)];
    return Boolean(install?.served && !install.hooked);
  }
  const latest = Object.entries(installs)
    .filter(([where, install]) => install.served && fs.existsSync(where))
    .sort(([, a], [, b]) => (a.served! < b.served! ? 1 : -1))[0];
  return Boolean(latest && !latest[1].hooked);
}
