import { spawnSync } from "node:child_process";

/** One command of an agent's plugin manager; `orElse` runs when it fails, as an update of what is already there. */
interface Step {
  args: string[];
  orElse?: string[];
  /** A step whose failure does not stop the install, such as adding a marketplace that is already added. */
  optional?: boolean;
}

/** An agent `wellactually install` sets up, and what the user still does in it afterwards. */
export interface Host {
  name: string;
  bin: string;
  steps: Step[];
  then?: string;
}

export const HOSTS: Host[] = [
  {
    name: "Claude Code",
    bin: "claude",
    steps: [
      { args: ["plugin", "marketplace", "add", "passsy/wellactually"], optional: true },
      { args: ["plugin", "marketplace", "update", "wellactually"], optional: true },
      { args: ["plugin", "install", "wellactually@wellactually"], orElse: ["plugin", "update", "wellactually@wellactually"] },
    ],
  },
  {
    name: "Codex",
    bin: "codex",
    steps: [
      { args: ["plugin", "marketplace", "add", "passsy/wellactually"], optional: true },
      { args: ["plugin", "marketplace", "upgrade", "wellactually"], optional: true },
      { args: ["plugin", "add", "wellactually@wellactually"] },
    ],
    // Codex runs no hook of a new plugin until the user trusts it, and offers no command to do that for them.
    then: "open Codex, type /hooks and press t to trust the new hooks",
  },
  { name: "OpenCode", bin: "opencode", steps: [{ args: ["plugin", "add", "wellactually"], orElse: ["plugin", "update"] }] },
  { name: "pi", bin: "pi", steps: [{ args: ["install", "npm:wellactually"], orElse: ["update", "npm:wellactually"] }] },
];

type Run = (bin: string, args: string[]) => boolean;

/** Runs an agent's command, showing its output; npm installs the agents' launchers as .cmd files on Windows, which only a shell starts. */
const run: Run = (bin, args) => spawnSync(bin, args, { stdio: ["ignore", "inherit", "inherit"], shell: process.platform === "win32" }).status === 0;
const found = (bin: string): boolean => spawnSync(bin, ["--version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0;

/**
 * `wellactually install`: adds the plugin to every agent on this machine
 * through the agent's own plugin manager, so each one updates itself from then on.
 */
export function install(hosts = HOSTS, exec: Run = run, exists = found): { installed: Host[]; failed: Host[]; missing: Host[] } {
  const result = { installed: [] as Host[], failed: [] as Host[], missing: [] as Host[] };
  for (const host of hosts) {
    if (!exists(host.bin)) {
      result.missing.push(host);
      continue;
    }
    console.log(`\n${host.name}:`);
    const ok = host.steps.every((step) => exec(host.bin, step.args) || (step.orElse !== undefined && exec(host.bin, step.orElse)) || step.optional === true);
    (ok ? result.installed : result.failed).push(host);
  }
  return result;
}
