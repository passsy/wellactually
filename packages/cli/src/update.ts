import fs from "node:fs";
import path from "node:path";
import cli from "../package.json" with { type: "json" };
import { boardHome } from "./board/board.ts";

/** The release this plugin is, which scripts/version.mjs writes into the package. */
export const CLIENT_VERSION: string = cli.version;

/** Where a release says which version it is. Agents install the plugin from `main`, so its newest commit is the newest release. */
export const LATEST_URL = "https://raw.githubusercontent.com/passsy/wellactually/main/packages/cli/package.json";

const DAY_MS = 24 * 60 * 60 * 1000;

/** OpenCode 1 runs the plugin from a git clone; only OpenCode 2 has `opencode plugin update`. */
export type Agent = "claude-code" | "codex" | "opencode" | "opencode-1" | "pi";

/** What the last look at GitHub found, and which release the user was last told about. */
interface UpdateState {
  checkedAt?: string;
  latest?: string;
  announced?: string;
  announcedAt?: string;
}

/**
 * The agent a hook runs in. Codex sets PLUGIN_ROOT for a plugin's hooks,
 * Claude Code does not. The OpenCode and pi plugins say which they are.
 */
export function agentOf(env: NodeJS.ProcessEnv): Agent {
  if (env.PLUGIN_ROOT) {
    return "codex";
  }
  return "claude-code";
}

/** How a user of each agent gets the new release. `folder` is where the plugin is, which OpenCode 1 users pull in. */
export function howToUpdate(agent: Agent, folder = ""): string {
  if (agent === "codex") {
    return "run `codex plugin marketplace upgrade wellactually` and restart Codex";
  }
  if (agent === "opencode-1") {
    return `run \`git pull\` in ${folder} and restart OpenCode`;
  }
  if (agent === "opencode") {
    return "run `opencode plugin update` and restart OpenCode";
  }
  if (agent === "pi") {
    return "run `pi update git:github.com/passsy/wellactually` and restart pi";
  }
  // `claude plugin update` alone reads the marketplace as it was last fetched and finds nothing new.
  return "run `claude plugin marketplace update wellactually` and `claude plugin update wellactually@wellactually` and restart Claude Code, or turn on auto-update for the wellactually marketplace in /plugin";
}

/** Whether `latest` is a later release than `current`, both major.minor.patch. */
export function isNewer(latest: string, current: string): boolean {
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) {
      return false;
    }
    if (x !== y) {
      return x > y;
    }
  }
  return false;
}

/** The usual switches of update notices: WELLACTUALLY_UPDATE_CHECK=0, NO_UPDATE_NOTIFIER, or a CI run. */
export function updateCheckOff(env: NodeJS.ProcessEnv): boolean {
  return env.WELLACTUALLY_UPDATE_CHECK === "0" || Boolean(env.NO_UPDATE_NOTIFIER) || Boolean(env.CI);
}

function stateFile(): string {
  return path.join(boardHome(), "update.json");
}

function readState(): UpdateState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8")) as UpdateState;
  } catch {
    return {};
  }
}

function writeState(state: UpdateState): void {
  fs.mkdirSync(boardHome(), { recursive: true });
  fs.writeFileSync(stateFile(), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * What to tell the user at the start of a session about a newer release, or
 * "" when there is nothing to tell. A release is announced at most once a
 * day. It never touches the network: it reads what the last check found, and
 * `stale` says whether a new check should start in the background.
 */
export function updateNotice(agent: Agent, now = Date.now(), current = CLIENT_VERSION, folder = ""): { text: string; stale: boolean } {
  if (updateCheckOff(process.env)) {
    return { text: "", stale: false };
  }
  const state = readState();
  const stale = !state.checkedAt || now - Date.parse(state.checkedAt) >= DAY_MS;
  if (!state.latest || !isNewer(state.latest, current)) {
    return { text: "", stale };
  }
  if (state.announced === state.latest && state.announcedAt && now - Date.parse(state.announcedAt) < DAY_MS) {
    return { text: "", stale };
  }
  writeState({ ...state, announced: state.latest, announcedAt: new Date(now).toISOString() });
  return { text: `Well Actually ${state.latest} is available, you have ${current}. To update, ${howToUpdate(agent, folder)}.`, stale };
}

/**
 * Looks up the newest release on GitHub and remembers it. Started in the
 * background at most once a day; a failure waits for the next day too.
 */
export async function checkForUpdate(now = Date.now()): Promise<string | undefined> {
  const state = readState();
  let latest = state.latest;
  try {
    const response = await fetch(LATEST_URL, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const version = ((await response.json()) as { version?: unknown }).version;
      if (typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version)) {
        latest = version;
      }
    }
  } catch {
    // Offline, or GitHub did not answer. The next session tries again tomorrow.
  }
  writeState({ ...readState(), checkedAt: new Date(now).toISOString(), latest });
  return latest;
}
