import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type HookPayload } from "../hook/payload.ts";

/**
 * What OpenCode and pi plugins share: they have no hooks of their own that
 * run a command, so their plugin turns what the agent reports into the
 * payload Claude Code would send and hands it to `wellactually hook`, the
 * same command Claude Code and Codex run. Dedup, the hook log and the
 * background sync all happen there.
 */

/** How long a hook may take before the agent goes on without its advice, as in hooks.json. */
const HOOK_TIMEOUT_MS = 10_000;

/**
 * The plugin's root: the folder above the built plugin file, which holds
 * dist/wellactually.mjs, skills/ and the rest of the repository.
 */
export function pluginRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * How to start the command: the bundled file beside the plugin, or the
 * `wellactually` on the PATH when the plugin runs from a checkout.
 */
export function command(root = pluginRoot()): { file: string; args: string[] } {
  const bundled = path.join(root, "dist", "wellactually.mjs");
  return fs.existsSync(bundled) ? { file: "node", args: [bundled] } : { file: "wellactually", args: [] };
}

/**
 * Runs `wellactually hook` with one payload and returns the advice it
 * prints, or "" when there is none. It never throws: a hook that fails must
 * not break the agent's session, and the command logs its own failures.
 */
export function callHook(payload: HookPayload, root = pluginRoot()): Promise<string> {
  const { file, args } = command(root);
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (text: string): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(text);
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args, "hook"], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, WELLACTUALLY_BRIDGED: "1" } });
    } catch {
      resolve("");
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done("");
    }, HOOK_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", () => done(""));
    child.on("close", () => done(adviceOf(out)));
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(payload));
  });
}

/**
 * What to tell the user about a newer release of the plugin, or "" when
 * there is none. The plugin shows it where its agent shows notices, which a
 * hook cannot reach. Like `callHook` it never throws.
 */
export function updateNoticeFor(agent: "opencode" | "pi", root = pluginRoot()): Promise<string> {
  const { file, args } = command(root);
  return new Promise((resolve) => {
    let out = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args, "update-notice", "--agent", agent], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve("");
      return;
    }
    const timer = setTimeout(() => child.kill(), HOOK_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim() : "");
    });
  });
}

/** The advice in what the hook printed: the additional context of its JSON answer. */
export function adviceOf(printed: string): string {
  const text = printed.trim();
  if (text === "") {
    return "";
  }
  try {
    const answer = JSON.parse(text) as { hookSpecificOutput?: { additionalContext?: unknown } };
    const advice = answer.hookSpecificOutput?.additionalContext;
    return typeof advice === "string" ? advice : "";
  } catch {
    return "";
  }
}

/** Advice for a tool call is shown after its result, the way Claude Code adds it below the tool's output. */
export function withAdvice(result: string, advice: string): string {
  return advice === "" ? result : `${result}\n\n${advice}`;
}

/**
 * Advice that arrives before a tool runs, held until its result exists.
 * Neither agent lets a plugin add text to a tool call that has not run yet,
 * so what a command's detectors say is shown with what it printed.
 */
export class Pending {
  private readonly advice = new Map<string, string>();

  add(callId: string, text: string): void {
    if (text !== "") {
      const before = this.advice.get(callId);
      this.advice.set(callId, before ? `${before}\n\n${text}` : text);
    }
  }

  take(callId: string): string {
    const text = this.advice.get(callId) ?? "";
    this.advice.delete(callId);
    return text;
  }
}

/** Reads the skills of the plugin, with the command spelled the way this plugin starts it. */
export function readSkills(root = pluginRoot()): { name: string; description: string; path: string; content: string }[] {
  const dir = path.join(root, "skills");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = path.join(dir, name, "SKILL.md");
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const field = (key: string): string | undefined => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(content)?.[1]?.trim().replace(/^["']|["']$/g, "");
    // The instructions without their frontmatter, which the agent shows as the skill's name and description.
    const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    return [{ name: field("name") ?? name, description: field("description") ?? "", path: file, content: body.replaceAll("${CLAUDE_PLUGIN_ROOT}", root) }];
  });
}
