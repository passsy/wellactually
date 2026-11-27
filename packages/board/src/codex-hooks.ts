import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { boardHome } from "./board.ts";

/**
 * Codex runs the Well Actually hooks, which live in ~/.codex/hooks.json, only
 * after the user trusted them in /hooks; once trusted they stay trusted across updates. Without the hooks no principle reaches the
 * agent. Codex says so itself at the start of the CLI and on the composer of
 * its app, but a user who skips that review never hears what it costs.
 *
 * Whether the hooks need review is Codex's answer, asked when the MCP server
 * starts. That a hook ran since is our own evidence, which retires the answer
 * once the user trusted the hooks mid-session.
 */
interface Install {
  /** When the MCP server last started from this install. */
  served?: string;
  /** Whether Codex said then that its hooks need review. */
  review?: boolean;
  /** When a hook first ran from it. */
  hooked?: string;
}

/**
 * What the agent is told. Codex shows the model only the first line of a
 * server's instructions, cut at 250 characters, among the descriptions of its
 * tools, where models read it as one rather than as a request.
 */
export const HOOKS_NEED_REVIEW =
  "Codex skips Well Actually's hooks until the user trusts them in /hooks (Codex app: Settings > Hooks), so no principle reaches this session. Tell the user so.";

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

/** The MCP server of the Codex install at `root` started, and Codex said whether its hooks need review. */
export function noteCodexServer(root: string, review: boolean | undefined, now = new Date()): void {
  // A probe that could not answer keeps the last answer, so a timeout never hides a known review.
  update(root, install => ({ ...install, served: now.toISOString(), review: review ?? install.review }));
}

/** Tells the agent that the notice above no longer holds, from a hook, which only runs once the user trusted the hooks. */
export const HOOKS_TRUSTED_NOW =
  "Codex runs Well Actually's hooks now, so the user has trusted them: ignore the Well Actually notice that they need review, and do not tell the user it.";

/** The MCP server of the Codex install at `root` started while its hooks needed review, so it told the agent so. */
export function codexToldReview(root: string): boolean {
  return read()[canonical(root)]?.review === true;
}

/** A hook ran from the Codex install at `root`. Written once per install, so hooks stay cheap. */
export function noteCodexHook(root: string, now = new Date()): void {
  if (read()[canonical(root)]?.hooked) {
    return;
  }
  update(root, install => (install.hooked ? null : { ...install, hooked: now.toISOString() }));
}

/**
 * Whether Codex skips the hooks of an install: of the install at `root`, or
 * else of the one whose server started last, which is what the Review Inbox
 * asks, served by whichever session holds its port.
 */
export function codexHooksSilent(root?: string): boolean {
  const installs = read();
  const silent = (install?: Install) => Boolean(install?.review && !install.hooked);
  if (root) {
    return silent(installs[canonical(root)]);
  }
  const latest = Object.entries(installs)
    .filter(([where, install]) => install.served && fs.existsSync(where))
    .sort(([, a], [, b]) => (a.served! < b.served! ? 1 : -1))[0];
  return silent(latest?.[1]);
}

/** The Codex that started this server and the arguments it runs with, or null when its parent is not Codex. */
function parentCodex(): { bin: string; args: string } | null {
  try {
    if (process.platform === "win32") {
      // shortcut: on Windows the codex on PATH answers, and a bypassed trust check goes unseen; read the parent there if Windows users report it.
      return { bin: "codex", args: "" };
    }
    const linux = process.platform === "linux";
    const ps = (field: string) => execFileSync("ps", ["-o", `${field}=`, "-p", String(process.ppid)], { encoding: "utf8" }).trim();
    // The Codex app runs its own binary, which need not be on PATH.
    const bin = linux ? fs.readlinkSync(`/proc/${process.ppid}/exe`) : ps("comm");
    const args = linux ? fs.readFileSync(`/proc/${process.ppid}/cmdline`, "utf8").replaceAll("\0", " ") : ps("args");
    return path.basename(bin) === "codex" ? { bin, args } : null;
  } catch {
    return null;
  }
}

/**
 * Asks the Codex that started this server whether the Well Actually hooks
 * need review, from the `hooks/list` of its app server, where its own /hooks
 * and the app's Hooks settings read it. Undefined when Codex cannot answer,
 * which says nothing rather than something false.
 */
export async function askCodexHooksNeedReview(cwd = process.cwd(), codex = parentCodex(), timeoutMs = 5000): Promise<boolean | undefined> {
  if (!codex) {
    return undefined;
  }
  // Hooks run regardless of trust in this session.
  if (codex.args.includes("--dangerously-bypass-hook-trust")) {
    return false;
  }
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(codex.bin, ["app-server"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve(undefined);
      return;
    }
    const done = (answer: boolean | undefined) => {
      clearTimeout(timer);
      child.kill();
      resolve(answer);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    child.on("error", () => done(undefined));
    child.on("exit", () => done(undefined));
    const send = (message: object) => child.stdin!.write(`${JSON.stringify(message)}\n`);
    let buffer = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: { id?: number; result?: { data?: { hooks?: { pluginId?: string | null; command?: string; enabled?: boolean; trustStatus?: string }[] }[] } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "hooks/list", params: { cwds: [cwd] } });
        } else if (message.id === 2) {
          const ours = (message.result?.data ?? []).flatMap(entry => entry.hooks ?? []).filter(hook => (hook.pluginId?.startsWith("wellactually@") || hook.command?.includes("codex-hook.mjs")) && hook.enabled);
          // None of ours means none run, as much as an untrusted one: the hooks were never added, or another tool removed them.
          done(message.result ? ours.length === 0 || ours.some(hook => hook.trustStatus === "untrusted" || hook.trustStatus === "modified") : undefined);
        }
      }
    });
    child.stdin!.on("error", () => done(undefined));
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "wellactually", version: "0" } } });
  });
}
